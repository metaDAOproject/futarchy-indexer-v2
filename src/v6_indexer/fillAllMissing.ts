import { PublicKey, ConfirmedSignatureInfo, SignaturesForAddressOptions } from "@solana/web3.js";
import { log } from "../logger/logger";
import { connection } from "./connection";
import { db, schema, inArray, and, eq } from "@metadaoproject/indexer-db";
import pLimit from "p-limit";
import { index } from "./indexer";
import { getLatestTxSigProcessed, setLatestTxSigProcessed } from "./filler";
import { 
  getExistingCheckpoint,
  createNewCheckpoint,
  appendSignaturesToCheckpoint,
  updateCheckpoint, 
  getRemainingSignatures, 
  hasUnprocessedSignatures,
  cleanupCheckpoint,
  getProgress,
  saveSignatureCheckpoints,
  loadSignatureCheckpoints
} from "./signaturePersistence";
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
 * Inserts new signatures for a given program ID with incremental fetching and persistence.
 * This function:
 * 1. Checks if we have a signature file with existing signatures
 * 2. If yes, fetches only NEW signatures since the last fetch and appends them
 * 3. If no, starts fresh and fetches all signatures
 * 4. Processes signatures with resumption capability
 * 5. Updates progress checkpoints during processing
 * 
 * @param programId - The PublicKey of the program to insert new signatures for
 * @returns Array of all newly inserted ConfirmedSignatureInfo objects
 * @throws Error if there's an issue with signature retrieval or processing
 */
export const insertNewSignaturesNew = async (programId: PublicKey) => {
	const programIdString = programId.toString();
	logger.info(`frontfilling new signatures for ${programIdString}`);

	// Check if we have existing signatures in file
	const existingCheckpoint = getExistingCheckpoint(programIdString);
	
	if (existingCheckpoint) {
		logger.info(`Found existing signature file for ${programIdString} with ${existingCheckpoint.signatures.length} signatures`);
		
		// Check if we need to fetch NEWER signatures (not older ones)
		// This only fetches signatures that are newer than our latest file signature
		const needsNewSignatures = await checkIfNeedsNewSignatures(programId, existingCheckpoint);
		
		if (needsNewSignatures) {
			logger.info(`Fetching only NEWER signatures since last fetch for ${programIdString}`);
			await fetchAndAppendNewSignatures(programId, existingCheckpoint);
		} else {
			logger.info(`No new signatures to fetch for ${programIdString} - file is up to date`);
		}
		
		// Process signatures from file (both existing and newly fetched)
		return await processSignaturesFromFile(programId, existingCheckpoint);
	} else {
		// No existing file, start fresh and fetch all signatures
		logger.info(`No existing signature file found, starting fresh for ${programIdString}`);
		return await fetchAllSignaturesAndCreateFile(programId);
	}
}

/**
 * Checks if we need to fetch new signatures by comparing with the latest on chain
 * Only returns true if there are signatures NEWER than what we have in our file
 * @param programId - The PublicKey of the program
 * @param existingCheckpoint - The existing checkpoint
 * @returns True if we need to fetch new signatures
 */
async function checkIfNeedsNewSignatures(programId: PublicKey, existingCheckpoint: any): Promise<boolean> {
	try {
		// Get the most recent signature from chain
		const latestSignatures = await connection.getSignaturesForAddress(
			programId,
			{ limit: 1 },
			"finalized"
		);

		if (latestSignatures.length === 0) {
			logger.info("No signatures found on chain");
			return false;
		}

		const latestChainSignature = latestSignatures[0].signature;
		const latestFileSignature = existingCheckpoint.signatures[0]?.signature;

		// If we don't have any signatures in file, we need to fetch
		if (!latestFileSignature) {
			logger.info("No signatures in file, need to fetch all");
			return true;
		}

		// If the latest chain signature is different from our latest file signature, we need to fetch
		const needsFetch = latestChainSignature !== latestFileSignature;
		
		if (needsFetch) {
			logger.info(`New signatures available: chain=${latestChainSignature}, file=${latestFileSignature}`);
		} else {
			logger.info("No new signatures available, file is up to date");
		}
		
		return needsFetch;
	} catch (error) {
		logger.error("Error checking if new signatures needed:", error);
		return false;
	}
}

/**
 * Fetches new signatures since the last fetch and appends them to the file
 * Only fetches signatures NEWER than what we already have (not older)
 * @param programId - The PublicKey of the program
 * @param existingCheckpoint - The existing checkpoint
 */
async function fetchAndAppendNewSignatures(programId: PublicKey, existingCheckpoint: any): Promise<void> {
	const programIdString = programId.toString();
	const latestFileSignature = existingCheckpoint.signatures[0]?.signature;
	
	let newSignatures: ConfirmedSignatureInfo[] = [];
	let beforeSignature: string | undefined; // Start from the latest on chain

	// First, get the latest signature from chain to start from
	try {
		const latestChainSignatures = await connection.getSignaturesForAddress(
			programId,
			{ limit: 1 },
			"finalized"
		);

		if (latestChainSignatures.length === 0) {
			logger.info("No signatures found on chain");
			return;
		}

		beforeSignature = latestChainSignatures[0].signature;
		logger.info(`Starting fetch from latest chain signature: ${beforeSignature}`);
	} catch (error) {
		logger.error("Error getting latest chain signature:", error);
		throw error;
	}

	// Fetch new signatures working backwards from the latest on chain
	// Stop when we reach signatures we already have
	while (true) {
		try {
			const signatures = await connection.getSignaturesForAddress(
				programId,
				{ 
					limit: 1000,
					before: beforeSignature
				},
				"finalized"
			);

			if (signatures.length === 0) {
				break;
			}

			// Check if we've reached signatures we already have
			const lastSignature = signatures[signatures.length - 1];
			if (latestFileSignature && lastSignature.signature === latestFileSignature) {
				// We've reached our existing signatures, stop here
				// Don't include the duplicate signature
				signatures.pop();
				newSignatures = newSignatures.concat(signatures);
				logger.info(`Reached existing signatures, stopping fetch`);
				break;
			}

			// Check if any signature in this batch matches our latest file signature
			const duplicateIndex = signatures.findIndex(sig => sig.signature === latestFileSignature);
			if (duplicateIndex !== -1) {
				// Found duplicate, only take signatures before it
				const signaturesToAdd = signatures.slice(0, duplicateIndex);
				newSignatures = newSignatures.concat(signaturesToAdd);
				logger.info(`Found duplicate signature at index ${duplicateIndex}, stopping fetch`);
				break;
			}

			newSignatures = newSignatures.concat(signatures);
			beforeSignature = lastSignature.signature;

			logger.info(`Fetched ${newSignatures.length} new signatures so far`);
		} catch (error) {
			logger.error("Error fetching new signatures:", error);
			throw error;
		}
	}

	if (newSignatures.length > 0) {
		logger.info(`Appending ${newSignatures.length} new signatures to file`);
		appendSignaturesToCheckpoint(programIdString, newSignatures);
	} else {
		logger.info("No new signatures found to append");
	}
}

/**
 * Processes signatures from the file
 * @param programId - The PublicKey of the program
 * @param checkpoint - The checkpoint with signatures
 * @returns Array of newly processed ConfirmedSignatureInfo objects
 */
async function processSignaturesFromFile(programId: PublicKey, checkpoint: any): Promise<ConfirmedSignatureInfo[]> {
	const programIdString = programId.toString();
	const remainingSignatures = getRemainingSignatures(programIdString);
	
	if (remainingSignatures.length === 0) {
		logger.info(`No remaining signatures to process for ${programIdString}`);
		cleanupCheckpoint(programIdString);
		return [];
	}

	const progress = getProgress(programIdString);
	logger.info(`Processing signatures: ${progress?.processed || 0}/${progress?.total || 0} signatures (${progress?.percentage || 0}%)`);

	// Filter out signatures that already exist in the database
	const existingSignatures = await getExistingSignatures(programIdString);
	const newSignatures = remainingSignatures.filter(
		sig => !existingSignatures.has(sig.signature)
	);

	logger.info(`Found ${newSignatures.length} new signatures to process from file`);

	// Process signatures with progress tracking
	await processSignaturesWithProgress(programId, newSignatures, programIdString);

	// Clean up checkpoint if all signatures are processed
	if (remainingSignatures.length === newSignatures.length) {
		cleanupCheckpoint(programIdString);
		logger.info(`Completed processing all signatures for ${programIdString}`);
	}

	return newSignatures;
}

/**
 * Fetches all signatures from the chain and creates a new file
 * @param programId - The PublicKey of the program to fetch signatures for
 * @returns Array of all newly processed ConfirmedSignatureInfo objects
 */
async function fetchAllSignaturesAndCreateFile(programId: PublicKey): Promise<ConfirmedSignatureInfo[]> {
	const programIdString = programId.toString();
	let allSignaturesFetched: ConfirmedSignatureInfo[] = [];
	let oldestSignatureInserted: string | undefined;

	let signaturesOptions: SignaturesForAddressOptions = {
		limit: 1000,
	};

	// Fetch all signatures from the chain
	while (true) {
		try {
			if (oldestSignatureInserted) {
				signaturesOptions.before = oldestSignatureInserted;
			}

			const signatures = await connection.getSignaturesForAddress(
				programId,
				signaturesOptions,
				"finalized"
			);

			if (signatures.length === 0) {
				break;
			}

			allSignaturesFetched = allSignaturesFetched.concat(signatures);
			oldestSignatureInserted = signatures[signatures.length - 1].signature;
			
			logger.info(`Fetched ${allSignaturesFetched.length} signatures so far`);
		} catch (e) {
			logger.error(`Program: ${programIdString} Request options: ${JSON.stringify(signaturesOptions)} Commitment: finalized`);
			throw Error(e as string);
		}
	}

	logger.info(`Found ${allSignaturesFetched.length} total signatures to process`);

	// Create new checkpoint with all signatures
	const checkpoint = createNewCheckpoint(programIdString, allSignaturesFetched);
	
	// Save the checkpoint to file
	const file = loadSignatureCheckpoints();
	if (file) {
		file.checkpoints.push(checkpoint);
		saveSignatureCheckpoints(file.checkpoints);
	} else {
		saveSignatureCheckpoints([checkpoint]);
	}
	
	// Update the latest processed signature in the database
	if (allSignaturesFetched.length > 0) {
		setLatestTxSigProcessed(allSignaturesFetched[0].signature, programIdString);
	}

	// Filter out signatures that already exist in the database
	const existingSignatures = await getExistingSignatures(programIdString);
	const newSignatures = allSignaturesFetched.filter(
		sig => !existingSignatures.has(sig.signature)
	);

	logger.info(`Found ${newSignatures.length} new signatures to process`);

	// Process signatures with progress tracking
	await processSignaturesWithProgress(programId, newSignatures, programIdString);

	// Clean up checkpoint
	cleanupCheckpoint(programIdString);

	return newSignatures;
}

/**
 * Gets existing signatures from the database for a program ID
 * @param programIdString - The program ID string
 * @returns Set of existing signature strings
 */
async function getExistingSignatures(programIdString: string): Promise<Set<string>> {
	const existingSignatures = await db
		.select({ signature: schema.signatures.signature })
		.from(schema.signatures)
		.rightJoin(schema.signature_accounts, eq(schema.signatures.signature, schema.signature_accounts.signature))
		.where(eq(schema.signature_accounts.account, programIdString))
		.then(results => new Set(results.map((r: any) => r.signature as string)));

	logger.info(`Found ${existingSignatures.size} existing signatures in the database`);
	return existingSignatures;
}

/**
 * Processes signatures with progress tracking and checkpointing
 * @param programId - The PublicKey of the program
 * @param signatures - Array of signatures to process
 * @param programIdString - The program ID string
 */
async function processSignaturesWithProgress(
	programId: PublicKey, 
	signatures: ConfirmedSignatureInfo[], 
	programIdString: string
): Promise<void> {
	const tasks = [];
	let processedCount = 0;

	for (const signature of signatures) {
		const task = limit(async () => {
			await index(signature.signature, programId);
			await delay(100); // Add delay between tasks
			
			processedCount++;
			
			// Update checkpoint every 100 signatures or at the end
			if (processedCount % 100 === 0 || processedCount === signatures.length) {
				updateCheckpoint(programIdString, processedCount, signature.signature);
				logger.info(`Processed ${processedCount}/${signatures.length} signatures for ${programIdString}`);
			}
		});
		tasks.push(task);
	}

	await Promise.all(tasks);
	logger.info(`Completed processing ${signatures.length} signatures for ${programIdString}`);
}