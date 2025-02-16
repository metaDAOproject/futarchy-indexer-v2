import { ConfirmedSignatureInfo, Connection, PublicKey } from "@solana/web3.js";
import { AMM_PROGRAM_ID as V4_AMM_PROGRAM_ID, AUTOCRAT_PROGRAM_ID as V4_AUTOCRAT_PROGRAM_ID, CONDITIONAL_VAULT_PROGRAM_ID as V4_CONDITIONAL_VAULT_PROGRAM_ID } from "@metadaoproject/futarchy/v0.4";
import { db, schema, eq, asc } from "@metadaoproject/indexer-db";
import { log } from "../logger/logger";
import { index } from "./indexer";
import pLimit from "p-limit";

const limit = pLimit(10);

const RPC_ENDPOINT = process.env.RPC_ENDPOINT;

if (!RPC_ENDPOINT) {
  throw new Error("RPC_ENDPOINT is not set");
}
const connection = new Connection(RPC_ENDPOINT);
const logger = log.child({
  module: "v4_filler"
});

// it's possible that there are signatures BEFORE the oldest signature
// because the indexer may not have been running when those signatures were created

// it's also possible that there are signatures AFTER the newest signature

// we assume that there aren't signatures between the oldest and newest signatures

// we split these into two functions:
// - backfillHistoricalSignatures
// - insertNewSignatures

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
      "confirmed"
    );

    if (signatures.length === 0) break;

    await insertSignatures(signatures, programId);

    //trigger indexing
    const tasks = [];
    for (const signature of signatures) {
        const task = limit(() => index(signature.signature, programId));
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

const insertNewSignatures = async (programId: PublicKey) => {
  let allSignatures: ConfirmedSignatureInfo[] = [];
  logger.info(`frontfilling new signatures for ${programId.toString()}`);

  //get latest signature from db indexers table latestTxSigProcessed
  let latestRecordedSignature = await getLatestTxSigProcessed();

  let oldestSignatureInserted: string | undefined;
  let count = 0;
  while (true) {
    const signatures = await connection.getSignaturesForAddress(
      programId,
      { limit: 1000, until: latestRecordedSignature, before: oldestSignatureInserted },
      "confirmed"
    );

    if (signatures.length === 0) break;

    await insertSignatures(signatures, programId);

    //trigger indexing
    //TODO: maybe only index if signature doesnt exist in signatures table (which would mean it wasnt indexed yet)
    const tasks = [];
    for (const signature of signatures) {
        const task = limit(() => index(signature.signature, programId));
        tasks.push(task);
    }
    await Promise.all(tasks);

    allSignatures = allSignatures.concat(signatures);
    if (!oldestSignatureInserted) {
      setLatestTxSigProcessed(signatures[0].signature); //since getSignaturesForAddress is a backwards walk, this should be the latest signature
    }
    oldestSignatureInserted = signatures[signatures.length - 1].signature;

    count += signatures.length;
    logger.info(`inserted ${count} signatures so far for front filling...`);
  }

  return allSignatures;
}

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

//set latestTxSigProcessed
async function setLatestTxSigProcessed(signature: string) {
  try {
    logger.info(`setting latestTxSigProcessed to ${signature}`);
    await db.update(schema.indexers).set({ latestTxSigProcessed: signature }).where(eq(schema.indexers.name, "v0_4_amm_indexer")).execute();
  } catch (e) {
    logger.error(e, "Error setting the latest processed signature");
  }
}

//get latestTxSigProcessed
async function getLatestTxSigProcessed() {
  return await db.select({ signature: schema.indexers.latestTxSigProcessed })
      .from(schema.indexers)
      .where(eq(schema.indexers.name, "v0_4_amm_indexer"))
      .then(signatures => signatures[0] ? signatures[0].signature as string : undefined);

}


const programIds = [V4_CONDITIONAL_VAULT_PROGRAM_ID, V4_AMM_PROGRAM_ID, V4_AUTOCRAT_PROGRAM_ID];

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

export async function frontfill(): Promise<{message:string, error: Error|undefined}> {
  const results = await Promise.all(programIds.map(async (programId) => {
    try {
      
      const newSignatures = await insertNewSignatures(programId);
      logger.info(`inserted up to ${newSignatures.length} new signatures for ${programId.toString()}`);
      return {message: `inserted up to ${newSignatures.length} new signatures for ${programId.toString()}`};
      
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
