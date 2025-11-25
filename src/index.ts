import { log } from "./logger/logger";
import { mapLogHealth } from "./txLogHandler";
import { subscriptionManager } from "./core/subscriptionManager";
import { gapFill as v6_gapfill, backfill as v6_backfill } from "./v6_indexer/filler";
import { captureTokenBalanceSnapshotV6 } from "./v6_indexer/snapshot";
import { CronJob } from "cron";
import http from "http";
import { updatePrices } from "./priceHandler";
import { completeStakingDataRecovery } from "./v6_indexer/backfillStakingRecords";
import { backfillDaos } from "./v6_indexer/backfillDaos";

// Import all program indexers (registers them with the registry)
import "./indexers/futarchy/v0.6";
import "./indexers/launchpad/v0.6";
import "./indexers/conditional-vault/v0.4";

// Set to true to log all Geyser data without writing to the database.
const DRY_RUN = true;

const appStartTime = new Date();

const logger = log.child({
  module: "main"
});

interface cronFunction {
  (): Promise<{message:string, error: Error | undefined}>;
}

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

let subscriptionProcess: any = null;
let subscriptionHealth: any = null;
let subscriptionLastHealthUpdate: Date | null = null;

async function main() {

  // if (process.env.BACKFILL_STAKING_RECORDS === 'true') {
  //   await completeStakingDataRecovery();
  //   return;
  // }
  // if (process.env.BACKFILL_DAOS === 'true') {
  //   await backfillDaos();
  //   return;
  // }
  if (process.env.IS_SUBSCRIPTION_WORKER === 'true') {
    logger.info("Running as subscription worker");
    await runSubscriptionWorker();
    return;
  }

  logger.info("Running as main process, spawning worker...");
  startSubscriptionWorker();

  //  time for v6
  // let start = new Date();
  // let res = await backfillV6()
  // let end = new Date();
  // let { message, error } = res;
  // healthMap.set("backfillV6", new CronRunResult("backfillV6", message, error, start, end, error ? 1 : 0));

  // now lets frontfill v6
  // let start = new Date();
  // let res  = await gapFillV6()
  // let end = new Date();
  // let { message, error } = res;
  // healthMap.set("gapFillV6", new CronRunResult("gapFillV6", message, error, start, end, error ? 1 : 0));

  //lets start our crons now
  //startCron("backfillV6", "*/20 * * * *", backfillV6);
  // startCron("gapFillV6", "*/16 * * * *", gapFillV6);
  // startCron("priceHandler", "* * * * *", priceHandler);
  //startCron("snapshotV6", "*/20 * * * *", snapshotV6);

  const server = http.createServer((req: any, res: any) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`).pathname;
    let hasError = false;
    for (const result of healthMap.values()) {
      if (result.error) {
        hasError = true;
        break;
      }
    }
    
    let subscriptionHasError = false;
    if (!subscriptionProcess || subscriptionProcess.killed) {
      subscriptionHasError = true;
    }

    if (reqUrl == "/") {
      let bgColor = "#357e4e";
      if (hasError || subscriptionHasError) {
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
        html += `<h2 style="color: orange;">⚠️ DRY-RUN MODE ACTIVE - No database writes</h2>`;
      }
      
      html += '<br><h2>Subscription Worker Status</h2>';
      html += '<table>';
      html += '<thead><tr><th>PID</th><th>Mode</th><th>Events</th><th>Account Updates</th><th>Reconnects</th><th>Last Update</th></tr></thead>';
      html += '<tbody>';
      html += `<tr>
        <td>${subscriptionProcess?.pid || 'N/A'}</td>
        <td>${subscriptionHealth?.state || 'Unknown'}</td>
        <td>${subscriptionHealth?.eventsProcessed || 0}</td>
        <td>${subscriptionHealth?.accountUpdatesProcessed || 0}</td>
        <td>${subscriptionHealth?.reconnectAttempts || 0}</td>
        <td>${subscriptionLastHealthUpdate ? subscriptionLastHealthUpdate.toLocaleString('en-US', {timeZone: 'America/Vancouver'}) : 'Never'}</td>
      </tr>`;
      html += '</tbody></table>';
      
      html += '<br><br><h2>Backfill Health</h2>';
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

      html += "</body></html>";
      res.end(html);
    }
    else if (reqUrl == "/health") {
      if (hasError || subscriptionHasError) {
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
    logger.info(`Server running at ${port}`);
  });
}

async function runSubscriptionWorker() {
  logger.info("Starting as subscription worker process");

  subscriptionManager.setHealthCallback((health) => {
    if (process.send) {
      process.send({ type: 'health', data: health });
    }
  });

  await subscriptionManager.start({ dryRun: DRY_RUN });

  setInterval(() => {
    const health = subscriptionManager.getHealth();
    if (process.send) {
      process.send({ type: 'health', data: health });
    }
  }, 5000);
  
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Subscription worker running');
  });
  
  const port = process.env.SUBSCRIPTION_PORT || 8082;
  server.listen(port, () => {
    logger.info(`Subscription worker health server on port ${port}`);
  });
  
  process.on('SIGTERM', () => {
    logger.info('Subscription worker shutting down...');
    process.exit(0);
  });
}

function startSubscriptionWorker() {
  logger.info("Starting subscription worker process...");
  
  subscriptionProcess = Bun.spawn(["bun", __filename], {
    env: { 
      ...process.env,
      IS_SUBSCRIPTION_WORKER: 'true'
    },
    stdout: "inherit",
    stderr: "inherit",
    ipc(message: any) {
      if (message.type === 'health') {
        subscriptionHealth = message.data;
        subscriptionLastHealthUpdate = new Date();
      }
    }
  });
  
  logger.info(`Subscription worker started with PID: ${subscriptionProcess.pid}`);
  
  subscriptionProcess.exited.then((exitCode: number) => {  
    logger.error(`Subscription worker exited with code ${exitCode}`);
    
    setTimeout(() => {
      logger.info('Restarting subscription worker...');
      startSubscriptionWorker();
    }, 5000);
  });
}

process.on('SIGTERM', () => {
  logger.info('Main process shutting down...');
  if (subscriptionProcess) {
    subscriptionProcess.kill();
  }
  process.exit(0);
});

function startCron(cronName: string, cronFrequency: string, cf: cronFunction) {
  const cronJob = new CronJob(cronFrequency, async () => {
    const start = new Date();
    let result = await cf();
    const { message, error } = result;
    const end = new Date();
    let totalPreviousErrors = error ? 1 : 0;
    const oldHealth = healthMap.get(cronName);
    if (oldHealth) {
      totalPreviousErrors = totalPreviousErrors + oldHealth.totalPreviousErrors;
    }
    healthMap.set(cronName, new CronRunResult(cronName, message, error, start, end, totalPreviousErrors));
  });
  cronJob.start();
}

async function backfillV6(): Promise<{message:string, error: Error|undefined}> {
  return await v6_backfill();
}

async function gapFillV6(): Promise<{message:string, error: Error|undefined}> {
  return await v6_gapfill();
}

async function priceHandler(): Promise<{message:string, error: Error|undefined}> {
  return await updatePrices();
}

async function snapshotV6(): Promise<{message:string, error: Error|undefined}> {
  return await captureTokenBalanceSnapshotV6();
}

// Run the main function
if (process.env.REPROCESS == "true") {
  // reprocess();
} else {
  main();
}