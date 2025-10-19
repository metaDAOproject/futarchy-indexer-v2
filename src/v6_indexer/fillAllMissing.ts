import { PublicKey, ConfirmedSignatureInfo, SignaturesForAddressOptions } from "@solana/web3.js";
import { log } from "../logger/logger";
import { connection } from "./connection";
import { db, schema, inArray, and, eq } from "@metadaoproject/indexer-db";
import pLimit from "p-limit";
import { index } from "./indexer";
import { getLatestTxSigProcessed, setLatestTxSigProcessed } from "./filler";
const limit = pLimit(2);

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const RPC_ENDPOINT = process.env.RPC_ENDPOINT;

if (!RPC_ENDPOINT) {
  throw new Error("RPC_ENDPOINT is not set");
}

const logger = log.child({
  module: "v6_fillAllMissing"
});

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
export const insertNewSignaturesNew = async (programId: PublicKey) => {
	let allSignatures: ConfirmedSignatureInfo[] = [];
	logger.info(`frontfilling new signatures for ${programId.toString()}`);

	// Get the most recent signature that has been processed from the database
	// let latestRecordedSignature = await getLatestTxSigProcessed(programId.toString());
	let oldestSignatureInserted: string | undefined;

	let signaturesOptions: SignaturesForAddressOptions = {
		limit: 1000,
		//until: latestRecordedSignature,
	};

	let allSignaturesFetched: ConfirmedSignatureInfo[] = [];

	//we first fetch ALL the signatures from the CHAIN working 
	//from the latest signature back to latestRecordedSignature
	//this happens in batches 1000.
	while (true) {
		try {
			// For some reason the RPC updated and if we include undefined in the options it fails
			if (oldestSignatureInserted) {
				signaturesOptions.before = oldestSignatureInserted;
			}
			// Fetch a batch of signatures (max 1000) between latestRecordedSignature and oldestSignatureInserted
			const signatures = await connection.getSignaturesForAddress(
				programId,
				signaturesOptions,
				"finalized"
			);
			if (signatures.length === 0) {
				break;
			}

			allSignaturesFetched = allSignaturesFetched.concat(signatures);
			if (!oldestSignatureInserted) {
				// Update the latest processed signature in the database
				// This is the most recent signature since getSignaturesForAddress walks backwards

				//TODO this is an issue if we do not process the signature later on and 
				//fail.  This COULD be fixed by always getting all txs.
				setLatestTxSigProcessed(signatures[0].signature, programId.toString());
			}
			// Update the oldest signature we've processed for the next iteration
			oldestSignatureInserted = signatures[signatures.length - 1].signature;
      logger.info(`processed ${allSignaturesFetched.length} signatures so far`);
		} catch (e) {
			logger.error(`Program: ${programId.toString()} Request options: ${JSON.stringify(signaturesOptions)} Commitment: finalized`);
			throw Error(e as string);
		}
	}
  logger.info(`found ${allSignaturesFetched.length} signatures to index`);
  logger.info(`allSignaturesFetched: ${allSignaturesFetched[0]}`);

	//now lets see what we have in the db vs this list of signatures
	const existingSignatures = await db
		.select({ signature: schema.signatures.signature })
		.from(schema.signatures)
    .rightJoin(schema.signature_accounts, eq(schema.signatures.signature, schema.signature_accounts.signature))
		.where(eq(schema.signature_accounts.account, programId.toString()))
		.then(results => new Set(results.map((r: any) => r.signature as string)));

  
  logger.info(`found ${existingSignatures.size} existing signatures in the db`);
	// Filter to get ones NOT in DB
	const newSignatures = allSignaturesFetched.filter(
		sig => !existingSignatures.has(sig.signature)
	);

  logger.info(`found ${newSignatures.length} new signatures to index`);
  
	// Process each signature with rate limiting to avoid overwhelming the RPC
	const tasks = [];
	for (const signature of newSignatures) {
		// Create a rate-limited task for each signature
		// This ensures we don't exceed 1 request per second
		const task = limit(async () => {
			await index(signature.signature, programId);
			await delay(100); // Add 1 second delay between tasks
		});
		tasks.push(task);
	}
	await Promise.all(tasks);


	return newSignatures;
}