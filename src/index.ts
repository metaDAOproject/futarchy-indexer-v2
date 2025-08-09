import { backfillDaos, backfillProposals, backfillTokenSupply, backfillTransactions } from "./v3_indexer";
import { log } from "./logger/logger";
import { mapLogHealth, subscribeAll } from "./txLogHandler";
import { gapFill as v4_gapfill, backfill as v4_backfill } from "./v4_indexer/filler";
import { gapFill as v5_gapfill, backfill as v5_backfill } from "./v5_indexer/filler";
import { captureTokenBalanceSnapshotV3 } from "./v3_indexer/snapshot";
import { captureTokenBalanceSnapshotV4 } from "./v4_indexer/snapshot";
import { captureTokenBalanceSnapshotV5 } from "./v5_indexer/snapshot";
import { CronJob } from "cron";
import http from "http";
import { updatePrices } from "./priceHandler";

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
  if (process.env.IS_SUBSCRIPTION_WORKER === 'true') {
    await runSubscriptionWorker();
    return; 
  }

  startSubscriptionWorker();

  let start = new Date();
  let res = await backfillV3()
  let end = new Date();
  let { message, error } = res;

  healthMap.set("backfillV3", new CronRunResult("backfillV3", message, error, start, end, error ? 1 : 0));

  //now lets do v4
  start = new Date();
  res = await backfillV4()
  end = new Date();
  ({ message, error } = res);
  let totalPreviousErrors = error ? 1 : 0;
  healthMap.set("backfillV4", new CronRunResult("backfillV4", message, error, start, end, error ? 1 : 0));

  // now lets frontfill v4
  start = new Date();
  res = await gapFillV4()
  end = new Date();
  ({ message, error } = res);
  healthMap.set("gapFillV4", new CronRunResult("gapFillV4", message, error, start, end, error ? 1 : 0));

  // time for v5
  start = new Date();
  res = await backfillV5()
  end = new Date();
  ({ message, error } = res);
  healthMap.set("backfillV5", new CronRunResult("backfillV5", message, error, start, end, error ? 1 : 0));

  //now lets frontfill v5
  start = new Date();
  res = await gapFillV5()
  end = new Date();
  ({ message, error } = res);
  healthMap.set("gapFillV5", new CronRunResult("gapFillV5", message, error, start, end, error ? 1 : 0));

  //lets start our crons now
  startCron("backfillV3", "*/10 * * * *", backfillV3);
  startCron("backfillV4", "*/12 * * * *", backfillV4);
  startCron("backfillV5", "*/14 * * * *", backfillV5);
  startCron("gapFillV4", "*/16 * * * *", gapFillV4);
  startCron("gapFillV5", "*/18 * * * *", gapFillV5);
  startCron("priceHandler", "* * * * *", priceHandler);
  startCron("snapshotV3", "0 */23 * * *", snapshotV3);
  startCron("snapshotV4", "5 */12 * * *", snapshotV4);
  startCron("snapshotV5", "10 */12 * * *", snapshotV5);

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
    if (subscriptionHealth) {
      for (const log of subscriptionHealth) {
        if (log.error) {
          subscriptionHasError = true;
          break;
        }
      }
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
      
      html += '<br><h2>Subscription Worker Status</h2>';
      html += '<table>';
      html += '<thead><tr><th>PID</th><th>Status</th><th>Last Health Update</th></tr></thead>';
      html += '<tbody>';
      html += `<tr>
        <td>${subscriptionProcess?.pid || 'N/A'}</td>
        <td>${subscriptionProcess && !subscriptionProcess.killed ? 'Running' : 'Not Running'}</td>
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

      if (subscriptionHealth && subscriptionHealth.length > 0) {
        html += "<br><br><h2>Subscription Worker Logs</h2>";
        html += "<table>";
        html += "<thead><tr><th>Name</th><th>Error</th><th>Last Message</th></tr></thead>";
        html += "<tbody>";
        for (const result of subscriptionHealth) {
          html += `<tr><td>${result.name}</td><td>${result.error || 'None'}</td><td>${result.lastRun}</td></tr>`;
        }
        html += "</tbody>";
        html += "</table>";
      }

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
  
  subscribeAll();
  
  setInterval(() => {
    const health = Array.from(mapLogHealth.entries()).map(([name, result]) => ({
      name,
      error: result.error?.message || null,
      lastRun: result.lastRun.toLocaleString('en-US', {timeZone: 'America/Vancouver'})
    }));
    
    if (process.send) {
      process.send({
        type: 'health',
        data: health
      });
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

/**
 * Backfill V3
 * @returns {Promise<string | Error>}
 */
async function backfillV3(): Promise<{ message:string, error: Error | undefined }> {
  const backfillTasks = [
    { fn: backfillDaos, name: 'backfillDaos' },
    { fn: backfillProposals, name: 'backfillProposals' },
    { fn: backfillTokenSupply, name: 'backfillTokenSupply' },
    { fn: backfillTransactions, name: 'backfillTransactions' }
  ];

  let errors: string[] = [];
  let messages: string[] = [];
  for (const task of backfillTasks) {
    try {
      await task.fn()
        .then((data) => {
          messages.push(data.message);
          if (data.error) {
            errors.push(data.error.message);
          }
        })
        .catch((e) => errors.push(e?.toString() || 'Unknown error'));
     
    } catch (error) {
      errors.push(`${task.name}: ${error}`);
    }
  }

  const errorMessage = errors.filter(Boolean).join('');
  const message = messages.join('<br>');
  return { message:message, error: errorMessage ? new Error(errorMessage) : undefined };
}

async function backfillV4(): Promise<{message:string, error: Error|undefined}> {
  return await v4_backfill();
}

async function backfillV5(): Promise<{message:string, error: Error|undefined}> {
  return await v5_backfill();
}

async function gapFillV4(): Promise<{message:string, error: Error|undefined}> {
  return await v4_gapfill();
}

async function gapFillV5(): Promise<{message:string, error: Error|undefined}> {
  return await v5_gapfill();
}

async function priceHandler(): Promise<{message:string, error: Error|undefined}> {
  return await updatePrices();
}

async function snapshotV3(): Promise<{message:string, error: Error|undefined}> {
  return await captureTokenBalanceSnapshotV3();
}

async function snapshotV4(): Promise<{message:string, error: Error|undefined}> {
  return await captureTokenBalanceSnapshotV4();
}

async function snapshotV5(): Promise<{message:string, error: Error|undefined}> {
  return await captureTokenBalanceSnapshotV5();
}

async function reprocess() {
  console.log("Reprocessing called")
  let start = new Date();
  let res = await backfillTransactions(true);
  let end = new Date();
  console.log("Reprocessing complete")
}

// Run the main function
if (process.env.REPROCESS == "true") {
  reprocess();
} else {
  main();
}