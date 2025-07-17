import { ConfirmedSignatureInfo, Connection, PublicKey, SignaturesForAddressOptions } from "@solana/web3.js";
import { AMM_PROGRAM_ID as V5_AMM_PROGRAM_ID, AUTOCRAT_PROGRAM_ID as V5_AUTOCRAT_PROGRAM_ID, LAUNCHPAD_PROGRAM_ID as V5_LAUNCHPAD_PROGRAM_ID } from "@metadaoproject/futarchy/v0.5";
import { db, schema, eq, asc } from "@metadaoproject/indexer-db";
import { log } from "../logger/logger";
import { index } from "./indexer";
import pLimit from "p-limit";

const limit = pLimit(2);

const RPC_ENDPOINT = process.env.RPC_ENDPOINT;

if (!RPC_ENDPOINT) {
  throw new Error("RPC_ENDPOINT is not set");
}
const connection = new Connection(RPC_ENDPOINT);
const logger = log.child({
  module: "v5_filler"
});

// it's possible that there are signatures BEFORE the oldest signature
// because the indexer may not have been running when those signatures were created

// it's also possible that there are signatures AFTER the newest signature

// we assume that there aren't signatures between the oldest and newest signatures

// we split these into two functions:
// - backfillHistoricalSignatures
// - insertNewSignatures

/**
 * Utility function to create a delay
 * @param ms - Number of milliseconds to delay
 * @returns Promise that resolves after the specified delay
 */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Backfills historical signatures for a given program ID
 * @param programId - The PublicKey of the program to backfill signatures for
 * @returns Array of backfilled ConfirmedSignatureInfo objects
 */
const backfillHistoricalSignatures = async (
  programId: PublicKey,
) => {
  let backfilledSignatures: ConfirmedSignatureInfo[] = [];
  let oldestSignature = await db.select({ signature: schema.signatures.signature })
      .from(schema.signatures)
      .orderBy(asc(schema.signatures.slot))
      .limit(1)
      .then(signatures => signatures[0] ? signatures[0].signature : undefined);

  while (true) {

    const signatures = await connection.getSignaturesForAddress(
      programId,
      { before: oldestSignature, limit: 1000 },
      "finalized"
    );

    if (signatures.length === 0) break;

    await insertSignatures(signatures, programId);

    //trigger indexing
    const tasks = [];
    for (const signature of signatures) {
        // Add delay between tasks to ensure we don't exceed 1 request per second
        const task = limit(async () => {
          await index(signature.signature, programId);
          await delay(500); // Add 1 second delay between tasks
        });
        tasks.push(task);
    }
    await Promise.all(tasks);
    
    backfilledSignatures = backfilledSignatures.concat(signatures);
    oldestSignature = signatures[signatures.length - 1].signature;

    logger.info(`backfilled ${backfilledSignatures.length} historical signatures so far...`);
  }

  logger.info(`now done backfilling. backfilled ${backfilledSignatures.length} historical signatures`);
  return backfilledSignatures;
};

/**
 * Inserts new signatures for a given program ID, starting from the latest recorded signature.
 * This function performs a forward-fill operation by:
 * 1. Retrieving the latest processed signature from the database
 * 2. Fetching new signatures in batches of 1000
 * 3. Inserting signatures into the database
 * 4. Triggering indexing for each signature with rate limiting
 * 5. Updating the latest processed signature
 * 
 * The function uses a backwards walk through signatures, starting from the most recent
 * and moving towards older signatures until no more are found.
 * 
 * @param programId - The PublicKey of the program to insert new signatures for
 * @returns Array of all newly inserted ConfirmedSignatureInfo objects
 * @throws Error if there's an issue with signature retrieval or processing
 */
const insertNewSignatures = async (programId: PublicKey) => {
  let allSignatures: ConfirmedSignatureInfo[] = [];
  logger.info(`frontfilling new signatures for ${programId.toString()}`);

  // Get the most recent signature that has been processed from the database
  let latestRecordedSignature = await getLatestTxSigProcessed();

  let oldestSignatureInserted: string | undefined;
  let count = 0;

  let signaturesOptions: SignaturesForAddressOptions = {
    limit: 1000,
    until: latestRecordedSignature,
  };

  while (true) {
    try {
      // For some reason the RPC updated and if we include undefined in the options it fails
      if(oldestSignatureInserted) {
        signaturesOptions.before = oldestSignatureInserted;
      }
      // Fetch a batch of signatures (max 1000) between latestRecordedSignature and oldestSignatureInserted
      const signatures = await connection.getSignaturesForAddress(
        programId,
        signaturesOptions,
        "finalized"
      );

      if (signatures.length === 0) break;

      // Insert the batch of signatures into the database
      await insertSignatures(signatures, programId);

      // Process each signature with rate limiting to avoid overwhelming the RPC
      const tasks = [];
      for (const signature of signatures) {
          // Create a rate-limited task for each signature
          // This ensures we don't exceed 1 request per second
          const task = limit(async () => {
            await index(signature.signature, programId);
            await delay(500); // Add 1 second delay between tasks
          });
          tasks.push(task);
      }
      await Promise.all(tasks);

      // Update tracking variables
      allSignatures = allSignatures.concat(signatures);
      if (!oldestSignatureInserted) {
        // Update the latest processed signature in the database
        // This is the most recent signature since getSignaturesForAddress walks backwards
        setLatestTxSigProcessed(signatures[0].signature);
      }
      // Update the oldest signature we've processed for the next iteration
      oldestSignatureInserted = signatures[signatures.length - 1].signature;

      count += signatures.length;
      logger.info(`inserted ${count} signatures so far for front filling...`);
    } catch (e) {
      logger.error(`Program: ${programId.toString()} Request options: ${JSON.stringify(signaturesOptions)} Commitment: finalized`);
      throw Error(e as string);
    }
  }

  return allSignatures;
}

/**
 * Inserts signatures and their associated account information into the database
 * @param signatures - Array of ConfirmedSignatureInfo objects to insert
 * @param queriedAddr - The PublicKey of the account these signatures are associated with
 */
const insertSignatures = async (signatures: ConfirmedSignatureInfo[], queriedAddr: PublicKey) => {
  
  try {
    await db.insert(schema.signatures).values(signatures.map(tx => ({
      signature: tx.signature,
      slot: tx.slot.toString(),
      didErr: tx.err !== null,
      err: tx.err ? JSON.stringify(tx.err) : null,
      blockTime: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
    }))).onConflictDoNothing().execute();
  
    await db.insert(schema.signature_accounts).values(signatures.map(tx => ({
      signature: tx.signature,
      account: queriedAddr.toString()
    }))).onConflictDoNothing().execute();
  } catch (e) {
    logger.warn(e, "Error inserting the signatures");
  }
  
}

/**
 * Updates the latest processed transaction signature in the indexers table
 * @param signature - The signature string to set as the latest processed
 */
async function setLatestTxSigProcessed(signature: string) {
  try {
    logger.info(`setting latestTxSigProcessed to ${signature}`);
    await db.update(schema.indexers).set({ latestTxSigProcessed: signature }).where(eq(schema.indexers.name, "v0_5_amm_indexer")).execute(); //here
  } catch (e) {
    logger.error(e, "Error setting the latest processed signature");
  }
}

/**
 * Retrieves the latest processed transaction signature from the indexers table
 * @returns The latest processed signature string, or undefined if none exists
 */
async function getLatestTxSigProcessed() {
  return await db.select({ signature: schema.indexers.latestTxSigProcessed })
      .from(schema.indexers)
      .where(eq(schema.indexers.name, "v0_5_amm_indexer")) //here
      .then(signatures => signatures[0] ? signatures[0].signature as string : undefined);

}


const programIds = [ V5_LAUNCHPAD_PROGRAM_ID, V5_AMM_PROGRAM_ID, V5_AUTOCRAT_PROGRAM_ID]; //here

/**
 * Backfills historical signatures for all configured program IDs
 * @returns Object containing a message summarizing the results and any errors that occurred
 */
export async function backfill(): Promise<{message:string, error: Error | undefined}> {
  const results = await Promise.all(programIds.map(async (programId) => {
    let message = "";
    try {
      const backfilledSignatures = await backfillHistoricalSignatures(programId);
      message = `backfilled ${backfilledSignatures.length} signatures for ${programId.toString()}`;
      logger.info(message);
      return {message: message, error: undefined};
    } catch (error) {
      logger.error(
        error instanceof Error ? 
        `Error in backfill for ${programId.toString()}: ${error.message}` : 
        `Unknown error in backfill for ${programId.toString()}`
      );
      return {message: "An Error occurred", error: error};
    }
  }));
  let errorMessage = "";
  let message = "";
  for (const result of results) {
    if (result.error) {
      errorMessage += result.error.toString() + '<br>';
    }
    if (result.message) {
      message += result.message + '<br>';
    }
  }
  
  return { message: message, error: errorMessage ? new Error(errorMessage) : undefined };
}

/**
 * Fills gaps in signature processing by inserting new signatures for all configured program IDs
 * @returns Object containing a message summarizing the results and any errors that occurred
 */
export async function gapFill(): Promise<{message:string, error: Error|undefined}> {
  const results = await Promise.all(programIds.map(async (programId) => {
    try {
      
      const newSignatures = await insertNewSignatures(programId);
      logger.info(`inserted up to ${newSignatures.length} new signatures for ${programId.toString()}`);
      return {message: `inserted up to ${newSignatures.length} new signatures for ${programId.toString()}`};
      
    } catch (error) {
      logger.error(
        error instanceof Error ? 
        `Error in forward fill for ${programId.toString()}: ${error.message}` : 
        `Unknown error in forward fill for ${programId.toString()}`
      );
      return {message: "An Error occurred", error: error};
    }
  }));
  let errorMessage = "";
  let message = "";
  for (const result of results) {
    if (result.error) {
      errorMessage += result.error.toString() + '<br>';
    }
    if (result.message) {
      message += result.message + '<br>';
    }
  }
  return { message: message, error: errorMessage ? new Error(errorMessage) : undefined };
}
