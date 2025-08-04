import { Context, Logs, PublicKey } from "@solana/web3.js";
import { ptFromSignatureAndSlot } from "./v3_indexer/transaction/persistableTransaction";
import { log } from "./logger/logger";
import { connection } from "./v3_indexer/connection";
import { AMM_PROGRAM_ID as V5_AMM_PROGRAM_ID, AUTOCRAT_PROGRAM_ID as V5_AUTOCRAT_PROGRAM_ID, LAUNCHPAD_PROGRAM_ID as V5_LAUNCHPAD_PROGRAM_ID } from "@metadaoproject/futarchy/v0.5";
import { AMM_PROGRAM_ID as V4_AMM_PROGRAM_ID, AUTOCRAT_PROGRAM_ID as V4_AUTOCRAT_PROGRAM_ID, CONDITIONAL_VAULT_PROGRAM_ID as V4_CONDITIONAL_VAULT_PROGRAM_ID, LAUNCHPAD_PROGRAM_ID as V4_LAUNCHPAD_PROGRAM_ID } from "@metadaoproject/futarchy/v0.4";
import { AMM_PROGRAM_ID as V3_AMM_PROGRAM_ID, AUTOCRAT_PROGRAM_ID as V3_AUTOCRAT_PROGRAM_ID, CONDITIONAL_VAULT_PROGRAM_ID as V3_CONDITIONAL_VAULT_PROGRAM_ID } from "@metadaoproject/futarchy/v0.3";
import { v5IndexFromLogs } from "./v5_indexer/indexer";
import { v4IndexFromLogs } from "./v4_indexer/indexer";
import { backfillProposals } from "./v3_indexer/backfill/proposals";



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

const commitment = "confirmed";

export const mapLogHealth = new Map<string, LogResult>();

//subscribes to logs for a given account
async function subscribe(accountPubKey: PublicKey) {
  connection.onLogs(accountPubKey, async (logs: Logs, ctx: Context) => { //TODO: maybe add commitment "confirmed" (rpc docs doesnt say if this is default)
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
  }, commitment); // Note: the default here is "finalized"
}

//asynchronously subscribes to logs for all programs
export async function subscribeAll() {
  const programIds = [
    V5_LAUNCHPAD_PROGRAM_ID,
    V5_AMM_PROGRAM_ID,
    V5_AUTOCRAT_PROGRAM_ID,
    V4_LAUNCHPAD_PROGRAM_ID,
    V4_AMM_PROGRAM_ID,
    V4_AUTOCRAT_PROGRAM_ID,
    V4_CONDITIONAL_VAULT_PROGRAM_ID,
    V3_AMM_PROGRAM_ID,
    V3_AUTOCRAT_PROGRAM_ID,
    V3_CONDITIONAL_VAULT_PROGRAM_ID,
    // driftProgramId
  ];
  console.log("Subscribing to logs");
  for (const programId of programIds) {
    mapLogHealth.set(programId.toString(), new LogResult(programId.toString(), undefined, new Date(1970, 0, 1)));
  }
  Promise.all(programIds.map(async (programId) => subscribe(programId)));
}

async function processLogs(logs: Logs, ctx: Context, programId: PublicKey) {
  // Special handling for V4 Conditional Vault - it can be used by both v4 and v5 programs
  if (programId.equals(V4_CONDITIONAL_VAULT_PROGRAM_ID)) {
    
    await indexV4(logs, ctx, programId);
    await indexV5(logs, ctx, programId);
    
    return; 
  }

  if (programId.equals(V4_AMM_PROGRAM_ID) || programId.equals(V4_AUTOCRAT_PROGRAM_ID) || programId.equals(V4_LAUNCHPAD_PROGRAM_ID)) {
    await indexV4(logs, ctx, programId);
  } else if (programId.equals(V5_AMM_PROGRAM_ID) || programId.equals(V5_AUTOCRAT_PROGRAM_ID) || programId.equals(V5_LAUNCHPAD_PROGRAM_ID)) {
    await indexV5(logs, ctx, programId);
  } else if (programId.equals(V3_AMM_PROGRAM_ID) || programId.equals(V3_CONDITIONAL_VAULT_PROGRAM_ID)) {
    await indexV3(logs, ctx, programId);
  } else if (programId.equals(V3_AUTOCRAT_PROGRAM_ID)) {
    await indexProposal(logs, ctx, programId);
  } else {
    logger.error(`Unknown programId ${programId.toString()}`);
  }
}

async function indexV3(logs: Logs, ctx: Context, programId: PublicKey) {
  //console.log("indexV3", logs, ctx, programId);
  const pt = await ptFromSignatureAndSlot(logs.signature, ctx.slot, logs, false);
  if (!pt) {
    return false;
  }
  await pt.persist();
  logger.info(`successfully persisted txLog: ${logs.signature} for account: ${programId.toBase58()}`);
  return true;
}

async function indexProposal(logs: Logs, ctx: Context, programId: PublicKey) {
  //this could be done better and properly index from the logs,
  //but this is a quick fix for now
  await backfillProposals();
}

async function indexV4(logs: Logs, ctx: Context, programId: PublicKey) {
  await v4IndexFromLogs(logs, ctx, programId);
}

async function indexV5(logs: Logs, ctx: Context, programId: PublicKey) {
  await v5IndexFromLogs(logs, ctx, programId);
}