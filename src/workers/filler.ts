/**
 * Filler Worker Entry Point
 *
 * Handles cron-scheduled data filling operations.
 * This runs as a separate process from streaming to avoid blocking.
 *
 * Modes:
 *   - backfill: Historical signature crawl for all programs
 *   - gapfill: Smart gap-fill (backup gRPC for ≤3000 slots, RPC for larger)
 *   - snapshot: Account snapshot refresh
 *   - reindex [slot] [programId]: Reset and reindex from beginning or specific slot
 */

import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { log } from "../logger/logger";
import { getAllPrograms, getProgramByOwner, getProgramByName, ProgramIndexer } from "../core/registry";
import { backfillHistorical, gapFill, detectGapFromDb, updateIndexerProgress, getLatestProcessedSignature, processGrpcTransaction, resetIndexerProgress, setIndexerSlot, reindexHistorical, ReindexProgress } from "../core/backfill";
import { HeliusProvider } from "../core/providers/helius";
import { db, schema } from "@metadaoproject/indexer-db";
import bs58 from "bs58";
import assert from "assert";

// Import all program indexers (auto-registers via side effect)
import "../indexers/futarchy/v0.6";
import "../indexers/launchpad/v0.6";
import "../indexers/launchpad/v0.7";
import "../indexers/conditional-vault/v0.4";
import "../indexers/bid-wall/v0.7";

const logger = log.child({ module: "filler-worker" });

// Parse arguments: mode [fromSlot] [programName]
const mode = process.argv[2] as 'backfill' | 'gapfill' | 'snapshot' | 'reindex';
const arg3 = process.argv[3]; // Could be slot or programName
const arg4 = process.argv[4]; // Could be programName if arg3 is slot

async function main() {
  logger.info(`Starting ${mode} worker`);

  const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
  if (!RPC_ENDPOINT) {
    logger.error("RPC_ENDPOINT not set");
    process.exit(1);
  }

  const rpcConnection = new Connection(RPC_ENDPOINT, "confirmed");

  // Initialize backup gRPC provider for smart gap-fill
  let backupGrpcProvider: HeliusProvider | null = null;
  if (process.env.BACKUP_GRPC_ENDPOINT && process.env.BACKUP_GRPC_TOKEN) {
    backupGrpcProvider = new HeliusProvider(
      process.env.BACKUP_GRPC_ENDPOINT,
      process.env.BACKUP_GRPC_TOKEN
    );
    logger.info("Backup gRPC provider initialized for gap-fill");
  } else {
    logger.warn({
      hasEndpoint: !!process.env.BACKUP_GRPC_ENDPOINT,
      hasToken: !!process.env.BACKUP_GRPC_TOKEN
    }, "Backup gRPC provider NOT initialized - missing env vars");
  }

  if (mode === 'backfill') {
    await runBackfill(rpcConnection);
  } else if (mode === 'gapfill') {
    await runGapFill(rpcConnection, backupGrpcProvider);
  } else if (mode === 'snapshot') {
    await runSnapshot();
  } else if (mode === 'reindex') {
    // Parse optional args: reindex [fromSlot] [programName]
    // If arg3 is a number, it's the slot; otherwise it's the programName
    let fromSlot: bigint | undefined;
    let programName: string | undefined;

    if (arg3) {
      if (/^\d+$/.test(arg3)) {
        fromSlot = BigInt(arg3);
        programName = arg4;
      } else {
        programName = arg3;
      }
    }

    await runReindex(rpcConnection, fromSlot, programName);
  } else {
    logger.error({ mode }, "Unknown mode");
    process.exit(1);
  }

  logger.info(`${mode} worker completed`);
  process.exit(0);
}

/**
 * Run historical backfill for all programs
 */
async function runBackfill(rpcConnection: Connection): Promise<void> {
  const programs = getAllPrograms();
  logger.info({ programCount: programs.length }, "Starting historical backfill");

  for (const program of programs) {
    if (!program.backfillConfig) {
      logger.debug({ program: program.name }, "No backfill config, skipping");
      continue;
    }

    logger.info({ program: program.name }, "Starting backfill for program");

    try {
      // Phase 1: Snapshot current state (optional)
      if (program.backfillConfig.snapshotAccounts) {
        logger.info({ program: program.name }, "Running account snapshot");
        await program.backfillConfig.snapshotAccounts();
      }

      // Phase 2: Historical signature crawl
      const result = await backfillHistorical(program, rpcConnection);
      if (result.error) {
        logger.error({ error: result.error, program: program.name }, "Backfill error");
      } else {
        logger.info({ program: program.name, signatures: result.count }, "Backfill complete");
      }
    } catch (error) {
      logger.error({ error, program: program.name }, "Program backfill failed");
    }
  }
}

/**
 * Run smart gap-fill for all programs
 * Uses backup gRPC replay for small gaps (≤3000 slots), RPC crawl for larger gaps
 * Gap detection uses DB as source of truth - queries latest processed slot
 */
async function runGapFill(
  rpcConnection: Connection,
  backupGrpcProvider: HeliusProvider | null
): Promise<void> {
  const programs = getAllPrograms();
  const currentSlot = BigInt(await rpcConnection.getSlot());

  logger.info({
    programCount: programs.length,
    currentSlot: currentSlot.toString()
  }, "Starting gap-fill check");

  for (const program of programs) {
    if (!program.backfillConfig) {
      continue;
    }

    const programId = program.programId.toString();
    // Use indexer name for gap detection (queries indexers table)
    const gap = await detectGapFromDb(program.name, currentSlot);

    if (!gap.hasGap) {
      logger.debug({ program: program.name }, "No gap detected");
      continue;
    }

    logger.info({
      program: program.name,
      fromSlot: gap.fromSlot.toString(),
      toSlot: gap.toSlot.toString(),
      gapSize: gap.gapSize.toString(),
      hasBackupProvider: !!backupGrpcProvider,
      willUseGrpc: gap.gapSize <= 3000n && !!backupGrpcProvider
    }, "Gap detected");

    // Use backup gRPC replay for small gaps (≤3000 slots)
    if (gap.gapSize <= 3000n && backupGrpcProvider) {
      logger.info({ program: program.name, gapSize: gap.gapSize.toString() }, "Using laserstream replay for gap-fill");
      try {
        const result = await backupGrpcProvider.replayFromSlot(
          [programId],
          gap.fromSlot,
          async (data) => {
            // Process the transaction through the shared gRPC processing logic
            if (data.transaction) {
              await processGrpcTransaction(data);
            }
          },
          gap.toSlot // Pass target slot so we know when to stop
        );
        logger.info({ program: program.name, txCount: result.txCount }, "Laserstream replay gap-fill complete");
      } catch (error) {
        logger.error({ error, program: program.name }, "Backup gRPC replay failed, falling back to RPC crawl");
        // Fall through to RPC gap-fill
        const result = await gapFill(program, rpcConnection);
        logger.info({ program: program.name, signatures: result.count }, "RPC gap-fill complete");
      }
    } else {
      // Use RPC signature crawl for large gaps
      logger.info({ program: program.name, gapSize: gap.gapSize.toString() }, "Using RPC signature crawl for gap-fill");
      try {
        const result = await gapFill(program, rpcConnection);
        logger.info({ program: program.name, signatures: result.count }, "RPC gap-fill complete");
      } catch (error) {
        logger.error({ error, program: program.name }, "RPC gap-fill failed");
      }
    }
  }
}

/**
 * Run account snapshot refresh for all programs
 */
async function runSnapshot(): Promise<void> {
  const programs = getAllPrograms();
  logger.info({ programCount: programs.length }, "Starting account snapshot refresh");

  for (const program of programs) {
    if (!program.backfillConfig?.snapshotAccounts) {
      logger.debug({ program: program.name }, "No snapshot function, skipping");
      continue;
    }

    logger.info({ program: program.name }, "Running snapshot for program");

    try {
      await program.backfillConfig.snapshotAccounts();
      logger.info({ program: program.name }, "Snapshot complete");
    } catch (error) {
      logger.error({ error, program: program.name }, "Snapshot failed");
    }
  }
}

/**
 * Run reindex for programs
 * ISOLATED from normal indexing - does NOT update the indexers table
 * @param fromSlot - Optional starting slot (undefined = full history from beginning)
 * @param programName - Optional program name filter (undefined = all programs)
 */
async function runReindex(
  rpcConnection: Connection,
  fromSlot?: bigint,
  programName?: string
): Promise<void> {
  let programs = getAllPrograms();

  // Filter to specific program if provided
  if (programName) {
    const program = getProgramByName(programName);
    if (!program) {
      logger.error({ programName }, "Program not found");
      logger.info({ availablePrograms: programs.map(p => p.name) }, "Available programs");
      process.exit(1);
    }
    programs = [program];
  }

  logger.info({
    programCount: programs.length,
    programs: programs.map(p => p.name),
    fromSlot: fromSlot?.toString() ?? "beginning"
  }, "Starting reindex (isolated - no indexers table updates)");

  // Progress callback for IPC reporting
  const onProgress = (progress: ReindexProgress) => {
    // Send progress to parent process via IPC
    if (process.send) {
      process.send({
        type: 'reindex-progress',
        data: {
          program: progress.program,
          currentSlot: progress.currentSlot.toString(),
          txProcessed: progress.txProcessed,
          eventCounts: progress.eventCounts,
          startedAt: progress.startedAt.toISOString(),
        }
      });
    }
  };

  // Run isolated reindex for each program
  for (const program of programs) {
    logger.info({ program: program.name }, "Starting reindex for program");

    try {
      const result = await reindexHistorical(program, rpcConnection, fromSlot, onProgress);
      if (result.error) {
        logger.error({ error: result.error, program: program.name }, "Reindex error");
      } else {
        logger.info({ program: program.name, txProcessed: result.count }, "Reindex complete");
      }
    } catch (error) {
      logger.error({ error, program: program.name }, "Program reindex failed");
    }
  }
}

main().catch((error) => {
  logger.error({ error }, "Backfill worker failed");
  process.exit(1);
});
