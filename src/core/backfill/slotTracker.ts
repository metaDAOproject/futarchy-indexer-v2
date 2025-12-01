import { db, schema, eq } from "@metadaoproject/indexer-db";
import { IndexerImplementation, IndexerType } from "@metadaoproject/indexer-db/lib/schema";
import { log } from "../../logger/logger";

const logger = log.child({ module: "slotTracker" });

/**
 * Indexer progress tracker
 * Uses the indexers table as source of truth for:
 * - Gap detection (latest_slot_processed vs current chain slot)
 * - Backfill resume (latest_tx_sig_processed)
 */

// Map indexer names to their implementation enum values
const INDEXER_IMPLEMENTATION_MAP: Record<string, IndexerImplementation> = {
  "futarchy-v0.6": IndexerImplementation.FutarchyV06,
  "launchpad-v0.6": IndexerImplementation.LaunchpadV06,
  "conditional-vault-v0.4": IndexerImplementation.ConditionalVaultV04,
};

/**
 * Get the latest processed slot for an indexer from the indexers table
 */
export async function getLatestProcessedSlot(indexerName: string): Promise<bigint | undefined> {
  try {
    const result = await db.select({ slot: schema.indexers.latestSlotProcessed })
      .from(schema.indexers)
      .where(eq(schema.indexers.name, indexerName))
      .limit(1);

    if (result.length > 0 && result[0].slot) {
      return BigInt(result[0].slot);
    }
    return undefined;
  } catch (error) {
    logger.error({ error, indexerName }, "Error getting latest processed slot");
    return undefined;
  }
}

/**
 * Get the latest processed signature for an indexer (for backfill resume)
 */
export async function getLatestProcessedSignature(indexerName: string): Promise<string | undefined> {
  try {
    const result = await db.select({ sig: schema.indexers.latestTxSigProcessed })
      .from(schema.indexers)
      .where(eq(schema.indexers.name, indexerName))
      .limit(1);

    if (result.length > 0 && result[0].sig) {
      return result[0].sig;
    }
    return undefined;
  } catch (error) {
    logger.error({ error, indexerName }, "Error getting latest processed signature");
    return undefined;
  }
}

/**
 * Update the indexer progress after processing a transaction
 * Should be called after every successful DB insert
 */
export async function updateIndexerProgress(
  indexerName: string,
  slot: bigint,
  signature: string
): Promise<void> {
  try {
    const implementation = INDEXER_IMPLEMENTATION_MAP[indexerName];
    if (!implementation) {
      logger.warn({ indexerName }, "Unknown indexer implementation, skipping progress update");
      return;
    }

    // Upsert the indexer record
    await db.insert(schema.indexers).values({
      name: indexerName,
      implementation,
      latestSlotProcessed: slot.toString(),
      latestTxSigProcessed: signature,
      indexerType: IndexerType.GrpcStream,
    }).onConflictDoUpdate({
      target: schema.indexers.name,
      set: {
        latestSlotProcessed: slot.toString(),
        latestTxSigProcessed: signature,
      },
    }).execute();
  } catch (error) {
    logger.error({ error, indexerName, slot: slot.toString(), signature }, "Error updating indexer progress");
  }
}

/**
 * Initialize an indexer in the table if it doesn't exist
 */
export async function initializeIndexer(indexerName: string): Promise<void> {
  try {
    const implementation = INDEXER_IMPLEMENTATION_MAP[indexerName];
    if (!implementation) {
      logger.warn({ indexerName }, "Unknown indexer implementation, skipping initialization");
      return;
    }

    await db.insert(schema.indexers).values({
      name: indexerName,
      implementation,
      latestSlotProcessed: "0",
      latestTxSigProcessed: null,
      indexerType: IndexerType.GrpcStream,
    }).onConflictDoNothing().execute();

    logger.info({ indexerName }, "Initialized indexer");
  } catch (error) {
    logger.error({ error, indexerName }, "Error initializing indexer");
  }
}

/**
 * Detect if there's a gap between our DB state and current chain slot
 * Returns gap info if gap > threshold, otherwise returns no gap
 */
export async function detectGapFromDb(
  indexerName: string,
  currentChainSlot: bigint,
  gapThreshold: bigint = 10n
): Promise<{ hasGap: boolean; fromSlot: bigint; toSlot: bigint; gapSize: bigint }> {
  const latestDbSlot = await getLatestProcessedSlot(indexerName);

  if (!latestDbSlot) {
    // No data in DB yet - not a gap, just need initial backfill
    return { hasGap: false, fromSlot: 0n, toSlot: 0n, gapSize: 0n };
  }

  const gap = currentChainSlot - latestDbSlot;

  if (gap > gapThreshold) {
    logger.info({
      indexerName,
      latestDbSlot: latestDbSlot.toString(),
      currentChainSlot: currentChainSlot.toString(),
      gap: gap.toString()
    }, "Gap detected");

    return {
      hasGap: true,
      fromSlot: latestDbSlot,
      toSlot: currentChainSlot,
      gapSize: gap
    };
  }

  return { hasGap: false, fromSlot: 0n, toSlot: 0n, gapSize: 0n };
}

/**
 * Reset indexer progress to beginning (for full reindex)
 */
export async function resetIndexerProgress(indexerName: string): Promise<void> {
  try {
    await db.update(schema.indexers)
      .set({ latestSlotProcessed: "0", latestTxSigProcessed: null })
      .where(eq(schema.indexers.name, indexerName))
      .execute();
    logger.info({ indexerName }, "Reset indexer progress");
  } catch (error) {
    logger.error({ error, indexerName }, "Error resetting indexer progress");
  }
}

/**
 * Set indexer to a specific slot (for partial reindex)
 */
export async function setIndexerSlot(indexerName: string, slot: bigint): Promise<void> {
  try {
    await db.update(schema.indexers)
      .set({ latestSlotProcessed: slot.toString(), latestTxSigProcessed: null })
      .where(eq(schema.indexers.name, indexerName))
      .execute();
    logger.info({ indexerName, slot: slot.toString() }, "Set indexer slot");
  } catch (error) {
    logger.error({ error, indexerName, slot: slot.toString() }, "Error setting indexer slot");
  }
}

// Legacy exports for backwards compatibility (deprecated)
// These are no-ops now since we use DB-based detection
export function recordGeyserSlot(_programId: string, _slot: bigint): void {}
export function recordDisconnectSlot(_programId: string): void {}
export function clearDisconnectSlot(_programId: string): void {}
export function detectGap(
  _programId: string,
  _currentGeyserSlot: bigint
): { hasGap: boolean; fromSlot: bigint; toSlot: bigint } {
  // Deprecated - use detectGapFromDb instead
  return { hasGap: false, fromSlot: 0n, toSlot: 0n };
}
