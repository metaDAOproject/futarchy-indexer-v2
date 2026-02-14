import { Connection, VersionedTransactionResponse } from "@solana/web3.js";
import bs58 from "bs58";
import { db, schema } from "@metadaoproject/indexer-db";
import { log } from "../../logger/logger";
import { ProgramIndexer } from "../registry";
import { updateIndexerProgress } from "./slotTracker";
import { withRetry, isRetryableError } from "../retry";
import { decodeEventsFromRpc, decodeEventsFromGrpc, extractBlockTimeFromEvents } from "../eventDecoder";
import { incrementEventCounter, getEventCount } from "../stats";

const logger = log.child({ module: "transactionIndexer" });

/**
 * Fetch and index a transaction by signature
 * Returns event counts by event name
 * @param filterToIndexer - If true, only process events for the provided indexer (used by RPC fallback to avoid duplicates)
 */
export async function indexTransaction(
  signature: string,
  indexer: ProgramIndexer,
  connection: Connection,
  skipSignatureInsert: boolean = false,
  filterToIndexer: boolean = false
): Promise<Record<string, number>> {
  try {
    const transactionResponse = await withRetry(
      () => connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 1
      }),
      { shouldRetry: isRetryableError }
    );

    if (!transactionResponse) {
      return {};
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
      return {};
    }

    // Parse and process events (filter to specific indexer if requested)
    return await parseAndProcessEvents(transactionResponse, signature, filterToIndexer ? indexer : undefined);
  } catch (error: any) {
    logger.error({
      err: error?.message || error?.toString() || JSON.stringify(error),
      signature
    }, "Error indexing transaction");
    return {};
  }
}

/**
 * Parse events from a transaction and process them through the appropriate indexer
 * Returns event counts by event name
 * @param filterIndexer - If provided, only process events for this specific indexer (used by RPC fallback to avoid duplicates)
 */
async function parseAndProcessEvents(
  transactionResponse: VersionedTransactionResponse,
  signature: string,
  filterIndexer?: ProgramIndexer
): Promise<Record<string, number>> {
  const innerInstructions = transactionResponse.meta?.innerInstructions ?? [];
  const eventCounts: Record<string, number> = {};

  if (innerInstructions.length === 0) {
    return eventCounts;
  }

  // Build full address list: static keys + loaded addresses (for versioned transactions with ALTs)
  const staticKeys = transactionResponse.transaction.message.staticAccountKeys;
  const loadedWritable = transactionResponse.meta?.loadedAddresses?.writable ?? [];
  const loadedReadonly = transactionResponse.meta?.loadedAddresses?.readonly ?? [];
  const allAccountKeys = [...staticKeys, ...loadedWritable, ...loadedReadonly];

  // Use shared decoder
  const decodedEvents = decodeEventsFromRpc(innerInstructions, allAccountKeys, filterIndexer);

  // Process each decoded event
  for (const { event, indexer } of decodedEvents) {
    eventCounts[event.name] = (eventCounts[event.name] || 0) + 1;
    incrementEventCounter(); // Track for health stats

    logger.info({
      eventName: event.name,
      signature,
      slot: transactionResponse.slot,
      program: indexer.name
    }, `${indexer.name} event #${getEventCount()} (RPC)`);

    try {
      await indexer.processEvent(event, signature, transactionResponse as any);
    } catch (processError) {
      logger.error({ error: processError, signature, eventName: event.name }, "Error processing event");
    }
  }

  return eventCounts;
}

/**
 * Check if a transaction should be skipped based on its logs and the indexer's skipEvents config.
 * Returns true if ALL meaningful events in the logs are in the skip list.
 */
function shouldSkipTransaction(logs: string[], skipEvents: string[]): boolean {
  if (!skipEvents || skipEvents.length === 0) {
    return false;
  }

  // Check if any log contains a skippable event
  let hasSkippableEvent = false;
  let hasNonSkippableEvent = false;

  for (const log of logs) {
    // Check if this log mentions any skip event
    const isSkippable = skipEvents.some(skipEvent => log.includes(skipEvent));
    if (isSkippable) {
      hasSkippableEvent = true;
    }

    // Check if this log looks like a meaningful event (program log with event name pattern)
    // Events typically appear as "Program log: <EventName>" or contain event identifiers
    if (log.includes("Program log:") && !isSkippable) {
      // This might be a non-skippable event
      hasNonSkippableEvent = true;
    }
  }

  // Skip only if we found skippable events AND no non-skippable events
  return hasSkippableEvent && !hasNonSkippableEvent;
}

/**
 * Index a transaction from RPC logs (for real-time processing via RPC fallback)
 * This is used when Geyser is unavailable
 * Only processes events for the specific indexer to avoid duplicates when multiple programs subscribe
 */
export async function indexFromLogs(
  signature: string,
  logs: string[],
  indexer: ProgramIndexer,
  connection: Connection
): Promise<void> {
  // Check if we should skip this transaction based on log contents
  const skipEvents = indexer.skipEvents ?? [];
  if (shouldSkipTransaction(logs, skipEvents)) {
    logger.debug({ signature, program: indexer.name }, "Skipping transaction (only contains filtered events)");
    return;
  }

  // filterToIndexer=true ensures we only process events for this specific indexer
  // This prevents duplicates when a transaction touches multiple programs
  await indexTransaction(signature, indexer, connection, false, true);
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

  // Use shared decoder for gRPC format
  const decodedEvents = decodeEventsFromGrpc(
    innerInstructions,
    transaction.transaction?.message?.accountKeys ?? [],
    transaction.meta?.loadedWritableAddresses ?? [],
    transaction.meta?.loadedReadonlyAddresses ?? []
  );

  // Extract block time from events
  const blockTime = extractBlockTimeFromEvents(decodedEvents);

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
