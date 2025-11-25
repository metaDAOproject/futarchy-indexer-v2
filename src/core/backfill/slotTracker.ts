import { db, schema, eq, desc } from "@metadaoproject/indexer-db";
import { log } from "../../logger/logger";

const logger = log.child({ module: "slotTracker" });

/**
 * Slot tracker for detecting gaps when Geyser reconnects
 * Tracks the highest slot seen per program to detect missed slots
 */

// In-memory cache of highest slots seen from Geyser
const highestGeyserSlots = new Map<string, bigint>();

// In-memory cache of slot when Geyser disconnected
const disconnectSlots = new Map<string, bigint>();

/**
 * Record a slot from Geyser streaming
 * Called whenever we receive data from Geyser
 */
export function recordGeyserSlot(programId: string, slot: bigint): void {
  const current = highestGeyserSlots.get(programId) || 0n;
  if (slot > current) {
    highestGeyserSlots.set(programId, slot);
  }
}

/**
 * Record the slot when Geyser disconnected
 * Used to detect gaps when Geyser reconnects
 */
export function recordDisconnectSlot(programId: string): void {
  const currentSlot = highestGeyserSlots.get(programId);
  if (currentSlot) {
    disconnectSlots.set(programId, currentSlot);
    logger.info({ programId, slot: currentSlot.toString() }, "Recorded disconnect slot");
  }
}

/**
 * Get the highest slot we've seen from Geyser for a program
 */
export function getHighestGeyserSlot(programId: string): bigint {
  return highestGeyserSlots.get(programId) || 0n;
}

/**
 * Get the slot when Geyser disconnected for a program
 */
export function getDisconnectSlot(programId: string): bigint | undefined {
  return disconnectSlots.get(programId);
}

/**
 * Clear the disconnect slot after gap fill is complete
 */
export function clearDisconnectSlot(programId: string): void {
  disconnectSlots.delete(programId);
}

/**
 * Detect if there's a gap between when Geyser disconnected and the current slot
 */
export function detectGap(
  programId: string,
  currentGeyserSlot: bigint
): { hasGap: boolean; fromSlot: bigint; toSlot: bigint } {
  const disconnectSlot = disconnectSlots.get(programId);

  if (!disconnectSlot) {
    return { hasGap: false, fromSlot: 0n, toSlot: 0n };
  }

  // If there's a significant gap (more than a few slots), we need to backfill
  const gap = currentGeyserSlot - disconnectSlot;
  const GAP_THRESHOLD = 10n; // Allow some small gaps due to timing

  if (gap > GAP_THRESHOLD) {
    logger.info({
      programId,
      disconnectSlot: disconnectSlot.toString(),
      currentSlot: currentGeyserSlot.toString(),
      gap: gap.toString()
    }, "Gap detected");

    return {
      hasGap: true,
      fromSlot: disconnectSlot,
      toSlot: currentGeyserSlot
    };
  }

  return { hasGap: false, fromSlot: 0n, toSlot: 0n };
}

/**
 * Get the latest processed slot from the database
 * Used for resuming backfill after restart
 */
export async function getLatestProcessedSlot(programId: string): Promise<bigint | undefined> {
  try {
    const result = await db.select({ slot: schema.signatures.slot })
      .from(schema.signatures)
      .innerJoin(
        schema.signature_accounts,
        eq(schema.signatures.signature, schema.signature_accounts.signature)
      )
      .where(eq(schema.signature_accounts.account, programId))
      .orderBy(desc(schema.signatures.slot))
      .limit(1);

    if (result.length > 0 && result[0].slot) {
      return BigInt(result[0].slot);
    }
    return undefined;
  } catch (error) {
    logger.error({ error, programId }, "Error getting latest processed slot");
    return undefined;
  }
}

/**
 * Check if backfill has been completed for a program
 * Returns true if we've backfilled all the way to the beginning
 */
export async function isBackfillComplete(programId: string): Promise<boolean> {
  try {
    // Check if we have an entry in the indexers table marking completion
    const result = await db.select({ name: schema.indexers.name })
      .from(schema.indexers)
      .where(eq(schema.indexers.name, `${programId}_backfill_complete`))
      .limit(1);

    return result.length > 0;
  } catch (error) {
    logger.error({ error, programId }, "Error checking backfill status");
    return false;
  }
}

/**
 * Mark backfill as complete for a program
 */
export async function markBackfillComplete(programId: string): Promise<void> {
  try {
    await db.insert(schema.indexers).values({
      name: `${programId}_backfill_complete`,
      latestTxSigProcessed: null,
    }).onConflictDoNothing().execute();

    logger.info({ programId }, "Marked backfill as complete");
  } catch (error) {
    logger.error({ error, programId }, "Error marking backfill complete");
  }
}
