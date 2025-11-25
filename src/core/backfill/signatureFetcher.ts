import { ConfirmedSignatureInfo, Connection, PublicKey, SignaturesForAddressOptions } from "@solana/web3.js";
import { db, schema, eq, asc, desc } from "@metadaoproject/indexer-db";
import { log } from "../../logger/logger";
import { ProgramIndexer } from "../registry";
import { indexTransaction } from "./transactionIndexer";
import pLimit from "p-limit";

const logger = log.child({ module: "signatureFetcher" });

// Configurable rate limiting via env vars
// RPC backfill doesn't compete with Geyser (gRPC), so can be aggressive
const BACKFILL_CONCURRENCY = parseInt(process.env.BACKFILL_CONCURRENCY || "20");
const BACKFILL_DELAY_MS = parseInt(process.env.BACKFILL_DELAY_MS || "0");
const GAP_FILL_LIMIT = parseInt(process.env.GAP_FILL_LIMIT || "500");

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
 * Set the latest processed signature for a program in the indexers table
 */
async function setLatestTxSigProcessed(signature: string, programId: string): Promise<void> {
  try {
    logger.info({ programId, signature }, "Setting latestTxSigProcessed");
    await db.update(schema.indexers)
      .set({ latestTxSigProcessed: signature })
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
      const signatures = await connection.getSignaturesForAddress(
        programId,
        { before: oldestSignature, limit: 1000 },
        "finalized"
      );

      if (signatures.length === 0) break;

      // Filter out failed signatures - Geyser only streams successful txs
      const successfulSignatures = signatures.filter(sig => sig.err === null);

      // Insert only successful signatures to DB
      await insertSignatures(successfulSignatures, programId);

      // Process each signature with configurable concurrency
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
    gapFillLimit: GAP_FILL_LIMIT
  }, "Starting gap fill");

  try {
    // Get the most recent signature we've processed
    const latestRecordedSignature = await getLatestTxSigProcessed(programId.toString());
    let oldestSignatureInserted: string | undefined;

    const signaturesOptions: SignaturesForAddressOptions = {
      limit: 1000,
      until: latestRecordedSignature,
    };

    while (true) {
      if (oldestSignatureInserted) {
        signaturesOptions.before = oldestSignatureInserted;
      }

      const signatures = await connection.getSignaturesForAddress(
        programId,
        signaturesOptions,
        "finalized"
      );

      if (signatures.length === 0) break;

      // Filter out failed signatures - Geyser only streams successful txs
      const successfulSignatures = signatures.filter(sig => sig.err === null);

      // Insert only successful signatures to DB
      await insertSignatures(successfulSignatures, programId);

      // Process each signature with configurable concurrency
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
        await setLatestTxSigProcessed(successfulSignatures[0].signature, programId.toString());
      }
      // Use last signature from original list for pagination (not filtered)
      oldestSignatureInserted = signatures[signatures.length - 1].signature;

      filledCount += successfulSignatures.length;
      logger.info({ program: indexer.name, count: filledCount }, "Gap fill progress");

      // Respect gap fill limit
      if (filledCount >= GAP_FILL_LIMIT) {
        logger.info({ program: indexer.name, limit: GAP_FILL_LIMIT }, "Gap fill limit reached");
        break;
      }
    }

    logger.info({ program: indexer.name, totalCount: filledCount }, "Gap fill complete");
    return { count: filledCount };
  } catch (error) {
    logger.error({ error, program: indexer.name }, "Error in gap fill");
    return { count: filledCount, error: error as Error };
  }
}
