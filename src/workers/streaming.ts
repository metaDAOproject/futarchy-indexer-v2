/**
 * Streaming Worker Entry Point
 *
 * Handles gRPC/RPC subscriptions for real-time transaction and account updates.
 * Failover chain: Yellowstone → Helius → RPC
 */

import "dotenv/config";
import { log } from "../logger/logger";
import { subscriptionManager } from "../core/subscriptionManager";

// Import all program indexers (auto-registers via side effect)
import "../indexers/futarchy/v0.6";
import "../indexers/launchpad/v0.6";
import "../indexers/launchpad/v0.7";
import "../indexers/conditional-vault/v0.4";

const logger = log.child({ module: "streaming-worker" });

async function main() {
  const dryRun = process.env.DRY_RUN === 'true';
  logger.info({ dryRun }, "Starting streaming worker");

  // Report health to parent process
  subscriptionManager.setHealthCallback((health) => {
    if (process.send) {
      process.send({ type: 'health', data: health });
    }
  });

  // Start streaming with failover chain (Yellowstone → Helius → RPC)
  // Auto gap-fill is always enabled when gRPC reconnects
  await subscriptionManager.start({
    dryRun,
    enableBackfill: false, // Backfill runs in separate cron worker
    autoGapFill: true,     // Always gap-fill on reconnect
  });

  // Periodic health reporting
  setInterval(() => {
    const health = subscriptionManager.getHealth();
    if (process.send) {
      process.send({ type: 'health', data: health });
    }
  }, 5000);

  // Graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('Streaming worker shutting down...');
    subscriptionManager.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  logger.error({ error }, "Streaming worker failed to start");
  process.exit(1);
});
