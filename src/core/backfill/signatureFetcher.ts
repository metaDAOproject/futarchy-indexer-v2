import { ConfirmedSignatureInfo, Connection, PublicKey, SignaturesForAddressOptions } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { db, schema, eq, asc, desc } from "@metadaoproject/indexer-db";
import { log } from "../../logger/logger";
import { ProgramIndexer, getProgramByOwner } from "../registry";
import { indexTransaction } from "./transactionIndexer";
import { withRetry, isRetryableError } from "../retry";
import pLimit from "p-limit";

const logger = log.child({ module: "signatureFetcher" });

// Configurable rate limiting via env vars
// RPC backfill doesn't compete with Geyser (gRPC), so can be aggressive
const BACKFILL_CONCURRENCY = parseInt(process.env.BACKFILL_CONCURRENCY || "20");
const BACKFILL_DELAY_MS = parseInt(process.env.BACKFILL_DELAY_MS || "0");
const DEBUG_BACKFILL = process.env.DEBUG_BACKFILL === "true";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Insert signatures and their associated account information into the database
 */
export async function insertSignatures(
  signatures: ConfirmedSignatureInfo[],
  programId: PublicKey
): Promise<void> {
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
      account: programId.toString()
    }))).onConflictDoNothing().execute();
  } catch (e) {
    logger.warn(e, "Error inserting signatures");
  }
}

/**
 * Get the latest processed signature for a program from the indexers table
 */
async function getLatestTxSigProcessed(programId: string): Promise<string | undefined> {
  const result = await db.select({ signature: schema.indexers.latestTxSigProcessed })
    .from(schema.indexers)
    .where(eq(schema.indexers.name, programId))
    .then(rows => rows[0]?.signature as string | undefined);
  return result;
}

/**
 * Set the latest processed signature and slot for a program in the indexers table
 */
async function setLatestTxSigProcessed(signature: string, slot: bigint, programId: string): Promise<void> {
  try {
    logger.debug({ programId, signature, slot: slot.toString() }, "Setting latestTxSigProcessed");
    await db.update(schema.indexers)
      .set({
        latestTxSigProcessed: signature,
        latestSlotProcessed: slot.toString()
      })
      .where(eq(schema.indexers.name, programId))
      .execute();
  } catch (e) {
    logger.error(e, "Error setting latest processed signature");
  }
}

/**
 * Get the oldest signature we have in the database (for backfill starting point)
 */
async function getOldestSignature(): Promise<string | undefined> {
  const result = await db.select({ signature: schema.signatures.signature })
    .from(schema.signatures)
    .orderBy(asc(schema.signatures.slot))
    .limit(1)
    .then(rows => rows[0]?.signature);
  return result;
}

/**
 * Backfill historical signatures for a program
 * Walks backward from the oldest known signature to get all historical data
 */
export async function backfillHistorical(
  indexer: ProgramIndexer,
  connection: Connection
): Promise<{ count: number; error?: Error }> {
  const programId = indexer.programId;
  const limit = pLimit(BACKFILL_CONCURRENCY);
  let backfilledCount = 0;

  logger.info({
    program: indexer.name,
    programId: programId.toString(),
    concurrency: BACKFILL_CONCURRENCY,
    delayMs: BACKFILL_DELAY_MS
  }, "Starting historical backfill");

  try {
    // Start from oldest signature we have
    let oldestSignature = await getOldestSignature();

    while (true) {
      if (DEBUG_BACKFILL) {
        logger.info({ before: oldestSignature, program: indexer.name }, "RPC: getSignaturesForAddress");
      }

      const signatures = await withRetry(
        () => connection.getSignaturesForAddress(
          programId,
          { before: oldestSignature, limit: 1000 },
          "finalized"
        ),
        { shouldRetry: isRetryableError }
      );

      if (signatures.length === 0) break;

      if (DEBUG_BACKFILL) {
        logger.info({
          count: signatures.length,
          firstSlot: signatures[0]?.slot,
          lastSlot: signatures[signatures.length - 1]?.slot
        }, "RPC: received signatures batch");
      }

      // Filter out failed signatures - Geyser only streams successful txs
      const successfulSignatures = signatures.filter(sig => sig.err === null);

      // Insert only successful signatures to DB
      await insertSignatures(successfulSignatures, programId);

      // Process each signature with configurable concurrency
      if (DEBUG_BACKFILL) {
        logger.info({ program: indexer.name, count: successfulSignatures.length }, "Processing batch of transactions");
      }
      const tasks = successfulSignatures.map(sig =>
        limit(async () => {
          await indexTransaction(sig.signature, indexer, connection);
          if (BACKFILL_DELAY_MS > 0) {
            await delay(BACKFILL_DELAY_MS);
          }
        })
      );
      await Promise.all(tasks);

      backfilledCount += successfulSignatures.length;
      // Use last signature from original list for pagination (not filtered)
      oldestSignature = signatures[signatures.length - 1].signature;

      logger.info({
        program: indexer.name,
        count: backfilledCount
      }, "Backfill progress");
    }

    logger.info({
      program: indexer.name,
      totalCount: backfilledCount
    }, "Historical backfill complete");

    return { count: backfilledCount };
  } catch (error) {
    logger.error({ error, program: indexer.name }, "Error in historical backfill");
    return { count: backfilledCount, error: error as Error };
  }
}

/**
 * Gap fill - catch up from latest processed signature to current
 * Used after Geyser reconnects to fill any gaps
 */
export async function gapFill(
  indexer: ProgramIndexer,
  connection: Connection
): Promise<{ count: number; error?: Error }> {
  const programId = indexer.programId;
  const limit = pLimit(BACKFILL_CONCURRENCY);
  let filledCount = 0;

  logger.info({
    program: indexer.name,
    programId: programId.toString(),
    concurrency: BACKFILL_CONCURRENCY,
  }, "Starting gap fill");

  try {
    // Get the most recent signature we've processed
    const latestRecordedSignature = await getLatestTxSigProcessed(indexer.name);
    let oldestSignatureInserted: string | undefined;

    const signaturesOptions: SignaturesForAddressOptions = {
      limit: 1000,
      until: latestRecordedSignature,
    };

    while (true) {
      if (oldestSignatureInserted) {
        signaturesOptions.before = oldestSignatureInserted;
      }

      if (DEBUG_BACKFILL) {
        logger.info({
          before: signaturesOptions.before,
          until: signaturesOptions.until,
          program: indexer.name
        }, "RPC: getSignaturesForAddress (gap fill)");
      }

      const signatures = await withRetry(
        () => connection.getSignaturesForAddress(
          programId,
          signaturesOptions,
          "finalized"
        ),
        { shouldRetry: isRetryableError }
      );

      if (signatures.length === 0) break;

      if (DEBUG_BACKFILL) {
        logger.info({
          count: signatures.length,
          firstSlot: signatures[0]?.slot,
          lastSlot: signatures[signatures.length - 1]?.slot
        }, "RPC: received signatures batch (gap fill)");
      }

      // Filter out failed signatures - Geyser only streams successful txs
      const successfulSignatures = signatures.filter(sig => sig.err === null);

      // Insert only successful signatures to DB
      await insertSignatures(successfulSignatures, programId);

      // Process each signature with configurable concurrency
      if (DEBUG_BACKFILL) {
        logger.info({ program: indexer.name, count: successfulSignatures.length }, "Processing batch of transactions (gap fill)");
      }
      const tasks = successfulSignatures.map(sig =>
        limit(async () => {
          await indexTransaction(sig.signature, indexer, connection);
          if (BACKFILL_DELAY_MS > 0) {
            await delay(BACKFILL_DELAY_MS);
          }
        })
      );
      await Promise.all(tasks);

      // Update tracking - use first successful signature as the latest processed
      if (!oldestSignatureInserted && successfulSignatures.length > 0) {
        await setLatestTxSigProcessed(
          successfulSignatures[0].signature,
          BigInt(successfulSignatures[0].slot),
          indexer.name
        );
      }
      // Use last signature from original list for pagination (not filtered)
      oldestSignatureInserted = signatures[signatures.length - 1].signature;

      filledCount += successfulSignatures.length;
      logger.info({ program: indexer.name, count: filledCount }, "Gap fill progress");
    }

    logger.info({ program: indexer.name, totalCount: filledCount }, "Gap fill complete");
    return { count: filledCount };
  } catch (error) {
    logger.error({ error, program: indexer.name }, "Error in gap fill");
    return { count: filledCount, error: error as Error };
  }
}

/**
 * Progress callback for reindex observability
 */
export interface ReindexProgress {
  program: string;
  currentSlot: bigint;
  txProcessed: number;
  eventCounts: Record<string, number>;
  startedAt: Date;
}

/**
 * Reindex historical transactions for a program
 * This is ISOLATED from normal indexing - does NOT update the indexers table
 * Walks forward (oldest first) through history
 */
export async function reindexHistorical(
  indexer: ProgramIndexer,
  connection: Connection,
  fromSlot?: bigint,
  onProgress?: (progress: ReindexProgress) => void
): Promise<{ count: number; error?: Error }> {
  const programId = indexer.programId;
  const limit = pLimit(BACKFILL_CONCURRENCY);
  let processedCount = 0;
  const totalEventCounts: Record<string, number> = {};
  const startedAt = new Date();

  logger.info({
    program: indexer.name,
    programId: programId.toString(),
    fromSlot: fromSlot?.toString() ?? "beginning",
    concurrency: BACKFILL_CONCURRENCY,
  }, "Starting reindex (isolated, no progress updates)");

  try {
    // Phase 1: Collect all signatures walking backward
    // RPC returns newest-first, so we collect all then reverse
    const allSignatures: ConfirmedSignatureInfo[] = [];
    let oldestSignature: string | undefined;

    logger.info({ program: indexer.name }, "Phase 1: Collecting signatures...");

    while (true) {
      const signatures = await withRetry(
        () => connection.getSignaturesForAddress(
          programId,
          { before: oldestSignature, limit: 1000 },
          "finalized"
        ),
        { shouldRetry: isRetryableError }
      );

      if (signatures.length === 0) break;

      // Filter by fromSlot if provided
      let filteredSigs = signatures;
      if (fromSlot !== undefined) {
        filteredSigs = signatures.filter(sig => BigInt(sig.slot) >= fromSlot);
        // If we've gone past fromSlot, we're done collecting
        if (filteredSigs.length < signatures.length) {
          allSignatures.push(...filteredSigs.filter(sig => sig.err === null));
          break;
        }
      }

      // Only keep successful signatures
      allSignatures.push(...filteredSigs.filter(sig => sig.err === null));
      oldestSignature = signatures[signatures.length - 1].signature;

      logger.info({
        program: indexer.name,
        collected: allSignatures.length,
        oldestSlot: signatures[signatures.length - 1]?.slot
      }, "Collecting signatures...");
    }

    logger.info({
      program: indexer.name,
      totalSignatures: allSignatures.length
    }, "Phase 1 complete: Signatures collected");

    // Phase 2: Process oldest-first (reverse the array)
    logger.info({ program: indexer.name }, "Phase 2: Processing transactions oldest-first...");

    // Reverse to process oldest first
    allSignatures.reverse();

    // Process in batches for efficiency
    const BATCH_SIZE = 100;
    for (let i = 0; i < allSignatures.length; i += BATCH_SIZE) {
      const batch = allSignatures.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;

      logger.info({
        program: indexer.name,
        batchNum,
        batchSize: batch.length,
        firstSig: batch[0]?.signature?.slice(0, 20) + "..."
      }, "Starting batch");

      // Insert signatures to DB
      await insertSignatures(batch, programId);
      logger.info({ batchNum }, "Signatures inserted, processing transactions...");

      // Process each signature with concurrency
      // Skip signature insert since we already bulk-inserted above
      let batchCompleted = 0;
      const batchEventCounts: Record<string, number> = {};
      const tasks = batch.map(sig =>
        limit(async () => {
          try {
            const eventCounts = await indexTransaction(sig.signature, indexer, connection, true);
            // Merge event counts
            for (const [eventName, count] of Object.entries(eventCounts)) {
              batchEventCounts[eventName] = (batchEventCounts[eventName] || 0) + count;
            }
          } catch (error) {
            logger.error({ error, signature: sig.signature }, "Error indexing transaction");
          }
          batchCompleted++;
          const totalCompleted = processedCount + batchCompleted;
          const percent = ((totalCompleted / allSignatures.length) * 100).toFixed(1);

          // Log progress every 10 transactions
          if (batchCompleted % 10 === 0) {
            const currentSlot = BigInt(sig.slot);
            // Merge batch counts with total for display
            const currentEventCounts = { ...totalEventCounts };
            for (const [eventName, count] of Object.entries(batchEventCounts)) {
              currentEventCounts[eventName] = (currentEventCounts[eventName] || 0) + count;
            }

            logger.info({
              program: indexer.name,
              batchNum,
              batchProgress: `${batchCompleted}/${batch.length}`,
              totalProgress: `${totalCompleted}/${allSignatures.length}`,
              percent,
              currentSlot: currentSlot.toString(),
              eventCounts: currentEventCounts
            }, "Reindex progress");

            // Send IPC progress update
            if (onProgress) {
              onProgress({
                program: indexer.name,
                currentSlot,
                txProcessed: totalCompleted,
                eventCounts: currentEventCounts,
                startedAt
              });
            }
          }

          if (BACKFILL_DELAY_MS > 0) {
            await delay(BACKFILL_DELAY_MS);
          }
        })
      );
      await Promise.all(tasks);
      // Merge batch counts into total
      for (const [eventName, count] of Object.entries(batchEventCounts)) {
        totalEventCounts[eventName] = (totalEventCounts[eventName] || 0) + count;
      }

      processedCount += batch.length;
      const currentSlot = BigInt(batch[batch.length - 1]?.slot ?? 0);

      // Final batch progress report
      logger.info({
        program: indexer.name,
        batchNum,
        processed: processedCount,
        total: allSignatures.length,
        percent: ((processedCount / allSignatures.length) * 100).toFixed(1)
      }, "Batch complete");
    }

    // Final progress update
    if (onProgress) {
      onProgress({
        program: indexer.name,
        currentSlot: BigInt(allSignatures[allSignatures.length - 1]?.slot ?? 0),
        txProcessed: processedCount,
        eventCounts: totalEventCounts,
        startedAt
      });
    }

    logger.info({
      program: indexer.name,
      totalProcessed: processedCount,
      duration: `${((Date.now() - startedAt.getTime()) / 1000 / 60).toFixed(1)} minutes`
    }, "Reindex complete");

    return { count: processedCount };
  } catch (error) {
    logger.error({ error, program: indexer.name }, "Error in reindex");
    return { count: processedCount, error: error as Error };
  }
}
