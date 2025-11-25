import { Context, Logs, PublicKey } from "@solana/web3.js";
import { log } from "./logger/logger";
import { connection } from "./connections/v0.6";
import { FUTARCHY_PROGRAM_ID as V6_FUTARCHY_PROGRAM_ID, LAUNCHPAD_PROGRAM_ID as V6_LAUNCHPAD_PROGRAM_ID, CONDITIONAL_VAULT_PROGRAM_ID as V4_CONDITIONAL_VAULT_PROGRAM_ID} from "@metadaoproject/futarchy/v0.6";
import { v6IndexFromLogs } from "./v6_indexer/indexer";

const logger = log.child({
  module: "transaction-log-handler"
});

export class LogResult {
  name: string;
  error: Error | undefined;
  lastRun: Date;
  

  constructor(name: string,error: Error | undefined, lastRun: Date) {
    this.name = name;
    this.error = error;
    this.lastRun = lastRun;
  }
}

// type Commitment = 'processed' | 'confirmed' | 'finalized' | 'recent' | 'single' | 'singleGossip' | 'root' | 'max';
// optons for commitment above, currently using 'confirmed'

export const mapLogHealth = new Map<string, LogResult>();

//subscribes to logs for a given account
async function subscribe(accountPubKey: PublicKey) {
  connection.onLogs(accountPubKey, async (logs: Logs, ctx: Context) => { 
    let err: Error | undefined = undefined
    try {
      // wait here because we need to fetch the txn from RPC
      // and often we get no response if we try right after recieving the logs notification
      console.log("Logs received for account", accountPubKey.toString());
      await new Promise((resolve) => setTimeout(resolve, 500));
      processLogs(logs, ctx,  accountPubKey); //trigger processing of logs
    } catch (error) {
      logger.error(error, `Error processing logs for account ${accountPubKey.toString()}`);
      err = error as Error;
    }

    mapLogHealth.set(accountPubKey.toString(), new LogResult(accountPubKey.toString(), err, new Date()));
  }, "confirmed"); 
}

//asynchronously subscribes to logs for all programs
export async function subscribeAll() {
  const programIds = [
    V6_FUTARCHY_PROGRAM_ID,
    V6_LAUNCHPAD_PROGRAM_ID,
    V4_CONDITIONAL_VAULT_PROGRAM_ID, 
  ];
  console.log("Subscribing to logs");
  for (const programId of programIds) {
    mapLogHealth.set(programId.toString(), new LogResult(programId.toString(), undefined, new Date(1970, 0, 1)));
  }
  Promise.all(programIds.map(async (programId) => subscribe(programId)));
}

async function processLogs(logs: Logs, ctx: Context, programId: PublicKey) {
  if (
    programId.equals(V6_FUTARCHY_PROGRAM_ID)
    || 
    programId.equals(V6_LAUNCHPAD_PROGRAM_ID)
    || 
    programId.equals(V4_CONDITIONAL_VAULT_PROGRAM_ID)
  ) {
    await v6IndexFromLogs(logs, ctx, programId);
  } 
  else {
    logger.error(`Unknown programId ${programId.toString()}`);
  }
}
