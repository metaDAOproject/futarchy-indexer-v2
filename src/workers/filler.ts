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
 *   - riskassessment: Monthly Chainalysis risk assessment for all addresses
 */

import { Connection } from "@solana/web3.js";
import { log } from "../logger/logger";
import { getAllPrograms, getProgramByName } from "../core/registry";
import { backfillHistorical, gapFill, detectGapFromDb, processGrpcTransaction, setIndexerSlot, reindexHistorical, ReindexProgress } from "../core/backfill";
import { HeliusProvider } from "../core/providers/helius";
import { db, schema } from "@metadaoproject/indexer-db";
import { eq } from "drizzle-orm";
import { checkAddressRisk } from "../services/chainalysis";

// Import all program indexers (auto-registers via side effect)
import "../indexers/futarchy/v0.6";
import "../indexers/launchpad/v0.6";
import "../indexers/launchpad/v0.7";
import "../indexers/conditional-vault/v0.4";
import "../indexers/bid-wall/v0.7";
import "../indexers/performance-package/v0.7";

const logger = log.child({ module: "filler-worker" });

// Configuration
const SKIP_RISK_HISTORY = false; // Set to true to skip archiving to history table

// Parse arguments: mode [fromSlot] [programName]
const mode = process.argv[2] as 'backfill' | 'gapfill' | 'snapshot' | 'reindex' | 'riskassessment';
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
  } else if (mode === 'riskassessment') {
    await runRiskAssessment();
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
        await setIndexerSlot(program.name, gap.toSlot);
      } catch (error) {
        logger.error({ error, program: program.name }, "Backup gRPC replay failed, falling back to RPC crawl");
        const result = await gapFill(program, rpcConnection);
        logger.info({ program: program.name, signatures: result.count }, "RPC gap-fill complete");
        await setIndexerSlot(program.name, gap.toSlot);
      }
    } else {
      // Use RPC signature crawl for large gaps
      logger.info({ program: program.name, gapSize: gap.gapSize.toString() }, "Using RPC signature crawl for gap-fill");
      try {
        const result = await gapFill(program, rpcConnection);
        logger.info({ program: program.name, signatures: result.count }, "RPC gap-fill complete");
        await setIndexerSlot(program.name, gap.toSlot);
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

/**
 * Run monthly risk assessment for all addresses
 */
async function runRiskAssessment(): Promise<void> {
  logger.info("Starting monthly risk assessment");

  try {
    // Step 1: Get current assessments
    const currentAssessments = await db
      .select()
      .from(schema.addressRiskAssessments)
      .execute();

    if (currentAssessments.length === 0) {
      logger.info("No addresses to assess");
      return;
    }

    // Skip archiving if requested
    if (!SKIP_RISK_HISTORY) {
      logger.info("Archiving current assessments to history");
      // Insert into history table in batches to avoid parameter limits
      const historyRecords = currentAssessments.map((assessment) => ({
        address: assessment.address,
        risk: assessment.risk,
        addressType: assessment.addressType,
        cluster: assessment.cluster,
        riskReason: assessment.riskReason,
        status: assessment.status,
        addressIdentifications: assessment.addressIdentifications,
        exposures: assessment.exposures,
        triggers: assessment.triggers,
        assessedAt: new Date(),
      }));

      // Batch insert to avoid PostgreSQL parameter limits (65535 params / ~10 fields = ~6500 records max)
      const batchSize = 1000;
      for (let i = 0; i < historyRecords.length; i += batchSize) {
        const batch = historyRecords.slice(i, i + batchSize);
        await db
          .insert(schema.addressRiskAssessmentHistory)
          .values(batch)
          .execute();
        logger.info({ processed: i + batch.length, total: historyRecords.length }, "Archiving batch to history");
      }

      logger.info({ count: historyRecords.length }, "Archived assessments to history");
    } else {
      logger.info("Skipping history archive (SKIP_RISK_HISTORY is true)");
    }

    // Step 2: Re-run Chainalysis checks
    logger.info({ count: currentAssessments.length }, "Re-checking addresses with Chainalysis");

    const startTime = Date.now();
    const highRiskAddresses: Array<{ address: string; risk: string; riskReason: string }> = [];
    let successCount = 0;
    let errorCount = 0;

    // Configurable rate limiting
    const rateLimitMs = parseInt(process.env.CHAINALYSIS_RATE_LIMIT_MS || "1000");
    const estimatedMs = currentAssessments.length * rateLimitMs;
    const estimatedMinutes = Math.round(estimatedMs / 60000);
    const estimatedHours = Math.floor(estimatedMinutes / 60);
    const remainingMinutes = estimatedMinutes % 60;

    const estimatedTime = estimatedHours > 0
      ? `${estimatedHours}h ${remainingMinutes}m`
      : `${estimatedMinutes}m`;

    logger.info({
      rateLimitMs,
      totalAddresses: currentAssessments.length,
      estimatedTime,
      estimatedMs
    }, "Starting address checks");

    for (const assessment of currentAssessments) {
      try {
        const result = await checkAddressRisk(assessment.address);

        if (result) {
          // Update the assessment
          await db
            .update(schema.addressRiskAssessments)
            .set({
              risk: result.risk,
              addressType: result.addressType,
              cluster: result.cluster,
              riskReason: result.riskReason,
              status: result.status,
              addressIdentifications: result.addressIdentifications || [],
              exposures: result.exposures || [],
              triggers: result.triggers || [],
              updatedAt: new Date(),
            })
            .where(eq(schema.addressRiskAssessments.address, assessment.address))
            .execute();

          // Track high/severe risk addresses
          if (result.risk === "High" || result.risk === "Severe") {
            highRiskAddresses.push({
              address: assessment.address,
              risk: result.risk,
              riskReason: result.riskReason || "No reason provided",
            });
          }

          successCount++;
        } else {
          // Address not found in Chainalysis - keep existing data
          logger.info({ address: assessment.address }, "Address not in Chainalysis system");
          successCount++;
        }

        // Rate limiting: configurable delay between requests (default 1 second)
        await new Promise((resolve) => setTimeout(resolve, rateLimitMs));

        // Log progress every 10 addresses
        if ((successCount + errorCount) % 10 === 0) {
          logger.info(
            { processed: successCount + errorCount, total: currentAssessments.length },
            "Progress update"
          );
        }
      } catch (error) {
        errorCount++;
        logger.error(
          {
            error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorName: error instanceof Error ? error.name : undefined,
            errorStack: error instanceof Error ? error.stack : undefined,
            errorDetails: JSON.stringify(error, Object.getOwnPropertyNames(error)),
            address: assessment.address
          },
          "Failed to check address risk"
        );
        // Continue with next address
      }
    }

    const endTime = Date.now();
    const totalTimeMs = endTime - startTime;
    const totalTimeMinutes = Math.floor(totalTimeMs / 60000);
    const totalTimeSeconds = Math.floor((totalTimeMs % 60000) / 1000);

    logger.info(
      { successCount, errorCount, highRiskCount: highRiskAddresses.length, totalTimeMs },
      "Risk assessment complete"
    );

    // Step 3: Send Telegram alert (always send summary, include high-risk addresses if any)
    await sendHighRiskAlert({
      highRiskAddresses,
      totalScanned: currentAssessments.length,
      successCount,
      errorCount,
      totalTimeMinutes,
      totalTimeSeconds,
    });

  } catch (error) {
    logger.error({ error }, "Risk assessment failed");
    throw error;
  }
}

async function sendHighRiskAlert({
  highRiskAddresses,
  totalScanned,
  successCount,
  errorCount,
  totalTimeMinutes,
  totalTimeSeconds,
}: {
  highRiskAddresses: Array<{ address: string; risk: string; riskReason: string }>;
  totalScanned: number;
  successCount: number;
  errorCount: number;
  totalTimeMinutes: number;
  totalTimeSeconds: number;
}) {
  const timeStr = totalTimeMinutes > 0
    ? `${totalTimeMinutes}m ${totalTimeSeconds}s`
    : `${totalTimeSeconds}s`;

  let addressList = '';
  if (highRiskAddresses.length > 0) {
    for (const addr of highRiskAddresses) {
      addressList += `
*${escapeMarkdown(addr.risk)}* Risk
Address: \`${addr.address}\`
Reason: ${escapeMarkdown(addr.riskReason)}
`;
    }
  }

  const message = highRiskAddresses.length > 0
    ? `⚠️ *Monthly Risk Assessment Complete*

📊 *Summary*
• Total Scanned: ${totalScanned.toLocaleString()}
• Successful: ${successCount.toLocaleString()}
• Errors: ${errorCount.toLocaleString()}
• Duration: ${timeStr}
• High Risk Found: ${highRiskAddresses.length}

🚨 *High Risk Addresses*
${addressList}`
    : `⚠️ *Monthly Risk Assessment Complete*

📊 *Summary*
• Total Scanned: ${totalScanned.toLocaleString()}
• Successful: ${successCount.toLocaleString()}
• Errors: ${errorCount.toLocaleString()}
• Duration: ${timeStr}
• High Risk Found: 0

✅ No high\\-risk addresses detected`;

  // Log to console
  logger.info({ highRiskCount: highRiskAddresses.length }, "Sending risk assessment alert");

  // Send directly to Telegram
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID;

  if (!botToken || !chatId) {
    logger.warn("Telegram credentials not configured, skipping alert");
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'MarkdownV2',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ error, status: response.status }, "Failed to send Telegram alert");
    } else {
      logger.info("Telegram alert sent successfully");
    }
  } catch (error) {
    logger.error({ error }, "Error sending Telegram alert");
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

main().catch((error) => {
  logger.error({ error }, "Backfill worker failed");
  process.exit(1);
});
