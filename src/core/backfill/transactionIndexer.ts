import { Connection, PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import bs58 from "bs58";
import assert from "assert";
import { db, schema } from "@metadaoproject/indexer-db";
import { log } from "../../logger/logger";
import { ProgramIndexer, getProgramByOwner } from "../registry";
import { updateIndexerProgress } from "./slotTracker";

const logger = log.child({ module: "transactionIndexer" });

// Signatures to skip (comma-separated in env var)
// Example: SKIP_SIGNATURES=sig1,sig2,sig3
const SKIP_SIGNATURES = new Set(
  (process.env.SKIP_SIGNATURES || "").split(",").filter(s => s.length > 0)
);

/**
 * Fetch and index a transaction by signature
 */
export async function indexTransaction(
  signature: string,
  indexer: ProgramIndexer,
  connection: Connection,
  skipSignatureInsert: boolean = false
): Promise<void> {
  if (SKIP_SIGNATURES.has(signature)) {
    logger.warn({ signature }, "Skipping blocklisted signature");
    return;
  }

  try {
    logger.info({ signature }, "Fetching transaction");
    const transactionResponse = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    });
    logger.info({ signature, hasResponse: !!transactionResponse, slot: transactionResponse?.slot }, "Transaction fetched");

    if (!transactionResponse) {
      return;
    }

    // Insert signature to DB (skip if already inserted in bulk, e.g., during reindex)
    if (!skipSignatureInsert) {
      try {
        await db.insert(schema.signatures).values({
          signature: transactionResponse.transaction.signatures[0],
          slot: transactionResponse.slot.toString(),
          didErr: transactionResponse.meta?.err !== null,
          err: transactionResponse.meta?.err ? JSON.stringify(transactionResponse.meta.err) : null,
          blockTime: transactionResponse.blockTime ? new Date(transactionResponse.blockTime * 1000) : null,
        }).onConflictDoNothing().execute();

        await db.insert(schema.signature_accounts).values({
          signature: transactionResponse.transaction.signatures[0],
          account: indexer.programId.toString()
        }).onConflictDoNothing().execute();
      } catch (e) {
        logger.warn(e, "Error inserting signature");
      }
    }

    // Skip if transaction had an error
    if (transactionResponse.meta?.err) {
      logger.debug({ signature, error: transactionResponse.meta.err }, "Transaction had error, skipping");
      return;
    }

    // Parse and process events
    await parseAndProcessEvents(transactionResponse, signature, indexer);
  } catch (error: any) {
    logger.error({
      err: error?.message || error?.toString() || JSON.stringify(error),
      signature
    }, "Error indexing transaction");
  }
}

/**
 * Parse events from a transaction and process them through the appropriate indexer
 */
async function parseAndProcessEvents(
  transactionResponse: VersionedTransactionResponse,
  signature: string,
  primaryIndexer: ProgramIndexer
): Promise<void> {
  const innerInstructions = transactionResponse.meta?.innerInstructions ?? [];

  for (const innerInstruction of innerInstructions) {
    for (const ix of innerInstruction.instructions) {
      // Get the program ID for this instruction
      const accountKeys = transactionResponse.transaction.message.staticAccountKeys;
      if (ix.programIdIndex >= accountKeys.length) {
        continue;
      }
      const programId = accountKeys[ix.programIdIndex];

      // Find the indexer for this program
      const indexer = getProgramByOwner(programId);
      if (!indexer) {
        continue;
      }

      // Try to decode as an event
      try {
        const ixData = anchor.utils.bytes.bs58.decode(ix.data);
        const event = indexer.decodeEvent(Buffer.from(ixData));

        if (event) {
          logger.debug({
            signature,
            program: indexer.name,
            eventName: event.name
          }, "Processing event from backfill");

          try {
            await indexer.processEvent(event, signature, transactionResponse as any);
          } catch (processError) {
            logger.error({ error: processError, signature, eventName: event.name }, "Error processing event");
          }
        }
      } catch (decodeError) {
        // Not all instructions are events, this is expected
        logger.trace({ error: decodeError }, "Failed to decode instruction as event");
      }
    }
  }
}

/**
 * Index a transaction from RPC logs (for real-time processing via RPC fallback)
 * This is used when Geyser is unavailable
 */
export async function indexFromLogs(
  signature: string,
  logs: string[],
  indexer: ProgramIndexer,
  connection: Connection
): Promise<void> {
  // For now, just delegate to the full transaction indexing
  // In the future, we could optimize by filtering based on logs
  await indexTransaction(signature, indexer, connection);
}

/**
 * Process a gRPC transaction update (from Yellowstone or Helius Laserstream)
 * This is the shared logic used by both streaming and gap-fill replay
 */
export async function processGrpcTransaction(data: any): Promise<void> {
  const transaction = data.transaction;
  if (!transaction?.transaction || !transaction.meta) {
    return;
  }

  const innerInstructions = transaction.meta.innerInstructions ?? [];
  const signature = bs58.encode(Buffer.from(transaction.signature));
  const slot = BigInt(data.slot);

  logger.debug({ signature, slot: slot.toString() }, "Processing gRPC transaction (gap-fill)");

  // FIRST PASS: Decode all events and extract timestamp
  let blockTime: Date | null = null;
  const decodedEvents: Array<{ event: any; indexer: ProgramIndexer }> = [];

  for (const innerInstruction of innerInstructions) {
    for (const ix of innerInstruction.instructions) {
      // Build full address list from account keys + loaded addresses
      let addresses: Uint8Array[] = [];
      addresses = addresses.concat(transaction.transaction?.message?.accountKeys ?? []);
      addresses = addresses.concat(transaction.meta?.loadedWritableAddresses ?? []);
      addresses = addresses.concat(transaction.meta?.loadedReadonlyAddresses ?? []);

      assert(ix.programIdIndex < addresses.length, "programIdIndex is out of bounds");
      const programId = new PublicKey(addresses[ix.programIdIndex]);

      // Find the indexer for this program
      const indexer = getProgramByOwner(programId);
      if (!indexer) {
        continue;
      }

      // Try to decode as an event
      const event = indexer.decodeEvent(Buffer.from(ix.data));
      if (!event) {
        continue;
      }

      decodedEvents.push({ event, indexer });

      // Extract timestamp from first event that has it
      if (!blockTime && event.data?.common?.unixTimestamp) {
        const unixTs = Number(event.data.common.unixTimestamp);
        blockTime = new Date(unixTs * 1000);
      }
    }
  }

  // INSERT SIGNATURE
  try {
    await db.insert(schema.signatures).values({
      signature,
      slot: slot.toString(),
      didErr: transaction.meta.err !== null,
      err: transaction.meta.err ? JSON.stringify(transaction.meta.err) : null,
      blockTime: blockTime,
    }).onConflictDoNothing().execute();
  } catch (e) {
    logger.warn({ error: e }, "Error inserting signature");
  }

  // Skip if transaction had an error
  if (transaction.meta.err) {
    return;
  }

  // SECOND PASS: Process decoded events
  const processedIndexers = new Set<string>();

  for (const { event, indexer } of decodedEvents) {
    logger.debug({
      signature,
      program: indexer.name,
      eventName: event.name,
      slot: slot.toString()
    }, "Processing event from gRPC gap-fill");

    // Create a minimal transaction response for the processor
    const txResponse = {
      slot: Number(slot),
      blockTime: blockTime ? Math.floor(blockTime.getTime() / 1000) : null,
      transaction: { signatures: [signature] },
      meta: transaction.meta,
    } as any;

    await indexer.processEvent(event, signature, txResponse);
    processedIndexers.add(indexer.name);
  }

  // Update progress for all indexers that processed events
  for (const indexerName of processedIndexers) {
    await updateIndexerProgress(indexerName, slot, signature);
  }
}
