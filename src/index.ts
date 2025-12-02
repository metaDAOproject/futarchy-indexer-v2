import "dotenv/config";
import { log } from "./logger/logger";
import { CronJob } from "cron";
import http from "http";
import path from "path";
import { updatePrices } from "./priceHandler";

// DRY_RUN: Log events without writing to DB (for testing)
// set to false to write to DB
const DRY_RUN = false;

// Enable cron-scheduled backfill and gap-fill
const ENABLE_BACKFILL = true;
const ENABLE_GAPFILL = true;

// Reindex: Reset tracking and re-process all historical signatures
// Set to true to run reindex on startup (will reset progress and crawl from beginning)
// REINDEX_FROM_SLOT: Optional starting slot (undefined = full history)
// ** IMPORTANT ** if the program has been upgraded, namely event data won't match what is in the imported clients from the sdk,
// then this reindexer will silently fail and hang on that event when reindexing. we would have to manually import all verisons of the idl
// and have some range of slots per idl to properly do a historical decode.
// an easy way to determine what viable slot you can crawl forward from is to go any explorer and plug in the program 
// addy, they have a Last Deployed Slot that tracks most recent upgrades.
// REINDEX_PROGRAM: Optional program name filter (undefined = all programs)
// needs futarchy-v0.6 not the program address
const ENABLE_REINDEXING = false;
const REINDEX_FROM_SLOT: number | undefined = 383871385;
const REINDEX_PROGRAM: string | undefined = "futarchy-v0.6";

const appStartTime = new Date();

const logger = log.child({
  module: "main"
});

class CronRunResult {
  name: string;
  message: string;
  error: Error | undefined;
  start: Date;
  end: Date;
  totalPreviousErrors: number;

  constructor(name: string, message: string, error: Error | undefined, start: Date, end: Date, totalPreviousErrors: number) {
    this.name = name;
    this.message = message;
    this.error = error;
    this.start = start;
    this.end = end;
    this.totalPreviousErrors = totalPreviousErrors;
  }
}
const healthMap = new Map<string, CronRunResult>();

let streamingProcess: any = null;
let streamingHealth: any = null;
let streamingLastHealthUpdate: Date | null = null;

let backfillRunning = false;
let gapfillRunning = false;

// Reindex state (isolated from normal indexing)
let reindexProcess: any = null;
let reindexProgress: {
  program: string;
  currentSlot: string;
  txProcessed: number;
  eventCounts: Record<string, number>;
  startedAt: string;
} | null = null;
let reindexLastUpdate: Date | null = null;
let reindexCompleted: { at: Date; exitCode: number } | null = null;

// Price handler state
let priceHandlerLastRun: Date | null = null;
let priceHandlerLastResult: { message: string; error: Error | undefined } | null = null;

async function main() {
  logger.info("Starting main process");
  logger.info({
    DRY_RUN,
    ENABLE_BACKFILL,
    ENABLE_GAPFILL,
    ENABLE_REINDEXING,
    REINDEX_FROM_SLOT,
    REINDEX_PROGRAM,
  }, "Configuration");

  // Spawn reindex worker in background (isolated from streaming)
  if (ENABLE_REINDEXING && !DRY_RUN) {
    logger.info({
      fromSlot: REINDEX_FROM_SLOT ?? "beginning",
      program: REINDEX_PROGRAM ?? "all"
    }, "Spawning reindex worker (runs in background, isolated from streaming)");

    // Build args for reindex worker
    const reindexArgs: string[] = [];
    if (REINDEX_FROM_SLOT !== undefined) {
      reindexArgs.push(REINDEX_FROM_SLOT.toString());
    }
    if (REINDEX_PROGRAM !== undefined) {
      reindexArgs.push(REINDEX_PROGRAM);
    }

    startReindexWorker(reindexArgs);
  }

  // Spawn streaming worker
  startStreamingWorker();

  // Cron-scheduled backfill (historical signature crawl) - runs hourly
  if (ENABLE_BACKFILL && !DRY_RUN) {
    logger.info("Starting backfill cron (hourly)");
    const backfillCron = new CronJob("0 * * * *", async () => {
      if (backfillRunning) {
        logger.warn("Backfill already running, skipping");
        return;
      }
      await runBackfillWorker('backfill');
    });
    backfillCron.start();
  }

  // Cron-scheduled gap-fill (catch missed slots) - runs every 10 minutes
  if (ENABLE_GAPFILL && !DRY_RUN) {
    logger.info("Starting gapfill cron (every 10 min)");
    const gapfillCron = new CronJob("*/10 * * * *", async () => {
      if (gapfillRunning) {
        logger.warn("Gapfill already running, skipping");
        return;
      }
      await runBackfillWorker('gapfill');
    });
    gapfillCron.start();
  }

  // Jupiter USD price updates - runs every minute
  const pricesCron = new CronJob("* * * * *", async () => {
    priceHandlerLastResult = await updatePrices();
    priceHandlerLastRun = new Date();
  });
  pricesCron.start();
  logger.info("Started Jupiter price updates cron (every minute)");

  // Health server
  const server = http.createServer((req: any, res: any) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`).pathname;
    let hasError = false;
    for (const result of healthMap.values()) {
      if (result.error) {
        hasError = true;
        break;
      }
    }

    let streamingHasError = false;
    if (!streamingProcess || streamingProcess.killed) {
      streamingHasError = true;
    }

    if (reqUrl == "/") {
      let bgColor = "#357e4e";
      if (hasError || streamingHasError) {
        bgColor = "#ff0000";
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      let style = `<style>
        body {font-family: Arial, sans-serif;}
        table {border-collapse: collapse;width:100%;margin:25px 0; min-width: 400px; box-shadow: 0 0 20px rgba(0, 0, 0, 0.15);}
        thead tr {background-color: ${bgColor};color: #ffffff;text-align: left;font-weight: bold;}
        td {padding:5px;min-width:100px;border-top:1px solid grey;}
        th,td {padding:12px 15px;}
        tr:nth-child(even) {background-color: #f3f3f3;}
        tr{border-bottom:1px solid #dddddd;}
      </style>`;
      let html = "<html><body>";
      html += style;
      html += `<h1>MetaDao Indexer Health Check - Started at ${appStartTime.toLocaleString('en-US', {timeZone: 'America/Vancouver'})} </h1>`;
      if (DRY_RUN) {
        html += `<h2 style="color: orange;">DRY-RUN MODE ACTIVE - No database writes</h2>`;
      }

      html += '<br><h2>Streaming Worker Status</h2>';
      html += '<table>';
      html += '<thead><tr><th>PID</th><th>State</th><th>Provider</th><th>Events</th><th>Account Updates</th><th>Reconnects</th><th>Last Update</th></tr></thead>';
      html += '<tbody>';
      html += `<tr>
        <td>${streamingProcess?.pid || 'N/A'}</td>
        <td>${streamingHealth?.state || 'Unknown'}</td>
        <td>${streamingHealth?.geyserConnected ? 'gRPC' : 'RPC'}</td>
        <td>${streamingHealth?.eventsProcessed || 0}</td>
        <td>${streamingHealth?.accountUpdatesProcessed || 0}</td>
        <td>${streamingHealth?.reconnectAttempts || 0}</td>
        <td>${streamingLastHealthUpdate ? streamingLastHealthUpdate.toLocaleString('en-US', {timeZone: 'America/Vancouver'}) : 'Never'}</td>
      </tr>`;
      html += '</tbody></table>';

      html += '<br><h3>Configuration</h3>';
      html += '<ul>';
      html += `<li>Dry Run: ${DRY_RUN ? 'Enabled' : 'Disabled'}</li>`;
      html += `<li>Backfill Cron: ${ENABLE_BACKFILL ? 'Hourly (0 * * * *)' : 'Disabled'}</li>`;
      html += `<li>Gap-Fill Cron: ${ENABLE_GAPFILL ? 'Every 10 min (*/10 * * * *)' : 'Disabled'}</li>`;
      html += `<li>Helius Backup: ${process.env.BACKUP_GRPC_ENDPOINT ? 'Configured' : 'Not configured'}</li>`;
      html += '</ul>';

      html += '<br><h3>Worker Status</h3>';
      html += '<ul>';
      html += `<li>Backfill Running: ${backfillRunning ? 'Yes' : 'No'}</li>`;
      html += `<li>Gap-Fill Running: ${gapfillRunning ? 'Yes' : 'No'}</li>`;
      html += `<li>Reindex Running: ${reindexProcess && !reindexProcess.killed ? 'Yes' : 'No'}</li>`;
      html += '</ul>';

      // Jupiter price handler status
      html += '<br><h3>Jupiter Price Updates</h3>';
      html += '<table>';
      html += '<thead><tr><th>Last Run</th><th>Status</th><th>Message</th></tr></thead>';
      html += '<tbody>';
      const priceStatus = priceHandlerLastResult?.error ? 'Error' : 'OK';
      const priceStatusColor = priceHandlerLastResult?.error ? 'red' : 'green';
      html += `<tr>
        <td>${priceHandlerLastRun ? priceHandlerLastRun.toLocaleString('en-US', {timeZone: 'America/Vancouver'}) : 'Never'}</td>
        <td style="color: ${priceStatusColor}">${priceStatus}</td>
        <td>${priceHandlerLastResult?.message || 'Waiting for first run...'}</td>
      </tr>`;
      html += '</tbody></table>';

      // Reindex progress section - show if running OR if we have progress data (completed)
      if (reindexProgress || (reindexProcess && !reindexProcess.killed)) {
        const isRunning = reindexProcess && !reindexProcess.killed;
        const statusText = isRunning ? 'In Progress' : (reindexCompleted?.exitCode === 0 ? 'Completed' : 'Failed');
        const statusColor = isRunning ? 'orange' : (reindexCompleted?.exitCode === 0 ? 'green' : 'red');

        html += `<br><h2>Reindex Report <span style="color: ${statusColor}">(${statusText})</span></h2>`;
        html += '<table>';
        html += '<thead><tr><th>Program</th><th>Current Slot</th><th>Tx Processed</th><th>Started</th><th>Completed</th></tr></thead>';
        html += '<tbody>';
        html += `<tr>
          <td>${reindexProgress?.program || 'Starting...'}</td>
          <td>${reindexProgress?.currentSlot || 'N/A'}</td>
          <td>${reindexProgress?.txProcessed || 0}</td>
          <td>${reindexProgress?.startedAt ? new Date(reindexProgress.startedAt).toLocaleString('en-US', {timeZone: 'America/Vancouver'}) : 'N/A'}</td>
          <td>${reindexCompleted ? reindexCompleted.at.toLocaleString('en-US', {timeZone: 'America/Vancouver'}) : (isRunning ? 'Running...' : 'N/A')}</td>
        </tr>`;
        html += '</tbody></table>';

        // Event counts table
        if (reindexProgress?.eventCounts && Object.keys(reindexProgress.eventCounts).length > 0) {
          html += '<br><h3>Events Reindexed</h3>';
          html += '<table>';
          html += '<thead><tr><th>Event Name</th><th>Count</th></tr></thead>';
          html += '<tbody>';
          for (const [eventName, count] of Object.entries(reindexProgress.eventCounts).sort((a, b) => b[1] - a[1])) {
            html += `<tr><td>${eventName}</td><td>${count}</td></tr>`;
          }
          html += '</tbody></table>';
        }

        html += '<p><em>Note: Reindex is isolated and does not affect the indexers table or streaming.</em></p>';
      }

      if (healthMap.size > 0) {
        html += '<br><br><h2>Cron Health</h2>';
        html += "<table>";
        html += "<thead><tr><th>Name</th><th>Message</th><th>Error</th><th>Previous Errors</th><th>Start</th><th>End</th></tr></thead>";
        html += "<tbody>";
        for (const result of healthMap.values()) {
          html += `<tr>
                  <td >${result.name}</td>
                  <td >${result.message}</td>
                  <td >${result.error?.message || 'None'}</td>
                  <td >${result.totalPreviousErrors}</td>
                  <td >${result.start.toLocaleString('en-US', {timeZone: 'America/Vancouver'})}</td>
                  <td >${result.end.toLocaleString('en-US', {timeZone: 'America/Vancouver'})}</td>
                </tr>`;
        }
        html += "</tbody>";
        html += "</table>";
      }

      html += "</body></html>";
      res.end(html);
    }
    else if (reqUrl == "/health") {
      if (hasError || streamingHasError) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end("Error");
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end("OK");
      }
    }
  });

  let port = process.env.PORT ?? 8080;
  server.listen(port, () => {
    logger.info(`Health server running at ${port}`);
  });
}

/**
 * Start the streaming worker process
 */
function startStreamingWorker() {
  logger.info("Starting streaming worker...");

  const workerPath = path.join(__dirname, "workers", "streaming.ts");

  streamingProcess = Bun.spawn(["bun", workerPath], {
    env: {
      ...process.env,
      DRY_RUN: DRY_RUN ? 'true' : 'false',
    },
    stdout: "inherit",
    stderr: "inherit",
    ipc(message: any) {
      if (message.type === 'health') {
        streamingHealth = message.data;
        streamingLastHealthUpdate = new Date();
      }
    }
  });

  logger.info(`Streaming worker started with PID: ${streamingProcess.pid}`);

  streamingProcess.exited.then((exitCode: number) => {
    logger.error(`Streaming worker exited with code ${exitCode}`);

    setTimeout(() => {
      logger.info('Restarting streaming worker...');
      startStreamingWorker();
    }, 5000);
  });
}

/**
 * Start the reindex worker process (runs in background, isolated from streaming)
 */
function startReindexWorker(args: string[]) {
  logger.info({ args }, "Starting reindex worker...");

  const workerPath = path.join(__dirname, "workers", "filler.ts");

  reindexProcess = Bun.spawn(["bun", workerPath, "reindex", ...args], {
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
    ipc(message: any) {
      if (message.type === 'reindex-progress') {
        reindexProgress = message.data;
        reindexLastUpdate = new Date();
      }
    }
  });

  logger.info(`Reindex worker started with PID: ${reindexProcess.pid}`);

  reindexProcess.exited.then((exitCode: number) => {
    if (exitCode === 0) {
      logger.info("Reindex worker completed successfully");
    } else {
      logger.error(`Reindex worker exited with code ${exitCode}`);
    }
    // Don't restart - reindex is a one-time operation
    // Keep progress visible with completion status
    reindexCompleted = { at: new Date(), exitCode };
  });
}

/**
 * Run a backfill worker process
 */
async function runBackfillWorker(
  mode: 'backfill' | 'gapfill' | 'snapshot' | 'reindex',
  extraArgs: string[] = []
): Promise<void> {
  const start = new Date();

  if (mode === 'backfill') {
    backfillRunning = true;
  } else if (mode === 'gapfill') {
    gapfillRunning = true;
  }

  logger.info(`Running ${mode} worker`);

  const workerPath = path.join(__dirname, "workers", "filler.ts");

  try {
    const worker = Bun.spawn(["bun", workerPath, mode, ...extraArgs], {
      env: process.env,
      stdout: "inherit",
      stderr: "inherit",
    });

    const exitCode = await worker.exited;
    const end = new Date();

    if (exitCode === 0) {
      healthMap.set(mode, new CronRunResult(
        mode,
        `Completed successfully`,
        undefined,
        start,
        end,
        healthMap.get(mode)?.totalPreviousErrors || 0
      ));
      logger.info({ exitCode }, `${mode} worker completed`);
    } else {
      const error = new Error(`Worker exited with code ${exitCode}`);
      healthMap.set(mode, new CronRunResult(
        mode,
        `Failed with exit code ${exitCode}`,
        error,
        start,
        end,
        (healthMap.get(mode)?.totalPreviousErrors || 0) + 1
      ));
      logger.error({ mode, exitCode }, "Backfill worker failed");
    }
  } catch (error) {
    const end = new Date();
    healthMap.set(mode, new CronRunResult(
      mode,
      `Error: ${error}`,
      error as Error,
      start,
      end,
      (healthMap.get(mode)?.totalPreviousErrors || 0) + 1
    ));
    logger.error({ mode, error }, "Backfill worker error");
  } finally {
    if (mode === 'backfill') {
      backfillRunning = false;
    } else if (mode === 'gapfill') {
      gapfillRunning = false;
    }
  }
}

process.on('SIGTERM', () => {
  logger.info('Main process shutting down...');
  if (streamingProcess) {
    streamingProcess.kill();
  }
  process.exit(0);
});

// Run the main function
main();
