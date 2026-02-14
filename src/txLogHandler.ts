import { Context, Logs, PublicKey, Connection } from "@solana/web3.js";
import { log } from "./logger/logger";
import { getAllPrograms, ProgramIndexer } from "./core/registry";
import { indexFromLogs } from "./core/backfill/transactionIndexer";

const logger = log.child({
  module: "transaction-log-handler"
});

export class LogResult {
  name: string;
  error: Error | undefined;
  lastRun: Date;

  constructor(name: string, error: Error | undefined, lastRun: Date) {
    this.name = name;
    this.error = error;
    this.lastRun = lastRun;
  }
}

export const mapLogHealth = new Map<string, LogResult>();

let rpcConnection: Connection | null = null;
const subscriptionIds: number[] = [];

export function setRpcConnection(connection: Connection) {
  rpcConnection = connection;
}

/**
 * Subscribe to logs for a single program indexer
 */
async function subscribeToProgram(indexer: ProgramIndexer) {
  if (!rpcConnection) {
    logger.error("RPC connection not set, cannot subscribe to logs");
    return;
  }

  const programId = indexer.programId;

  const subId = rpcConnection.onLogs(programId, async (logs: Logs, ctx: Context) => {
    let err: Error | undefined = undefined;
    try {
      logger.debug({ program: indexer.name, signature: logs.signature }, "RPC log received");

      await new Promise((resolve) => setTimeout(resolve, 500));

      if (logs.signature) {
        await indexFromLogs(
          logs.signature,
          logs.logs,
          indexer,
          rpcConnection!
        );
      }
    } catch (error) {
      logger.error({ error, program: indexer.name }, "Error processing RPC logs");
      err = error as Error;
    }

    mapLogHealth.set(
      programId.toString(),
      new LogResult(indexer.name, err, new Date())
    );
  }, "confirmed");

  subscriptionIds.push(subId);
  logger.info({ program: indexer.name, programId: programId.toString(), subId }, "Subscribed to RPC logs");
}

/**
 * Subscribe to logs for all registered programs.
 * Uses the registry pattern - programs must be imported before calling this.
 */
export async function subscribeAll() {
  const programs = getAllPrograms();

  if (programs.length === 0) {
    logger.warn("No programs registered! Make sure to import indexers before calling subscribeAll()");
    return;
  }

  logger.info({ programCount: programs.length }, "Subscribing to RPC logs for all programs");

  // Initialize health tracking
  for (const indexer of programs) {
    mapLogHealth.set(
      indexer.programId.toString(),
      new LogResult(indexer.name, undefined, new Date(1970, 0, 1))
    );
  }

  // Subscribe to each program
  await Promise.all(programs.map(indexer => subscribeToProgram(indexer)));

  logger.info("RPC log subscriptions active for all programs");
}

export async function unsubscribeAll() {
  if (!rpcConnection) return;

  logger.info({ count: subscriptionIds.length }, "Unsubscribing from all RPC logs");

  for (const subId of subscriptionIds) {
    try {
      await rpcConnection.removeOnLogsListener(subId);
      logger.debug({ subId }, "Removed log listener");
    } catch (error) {
      logger.warn({ subId, error }, "Failed to remove log listener");
    }
  }

  subscriptionIds.length = 0;
  logger.info("Unsubscribed from all RPC logs");
}
