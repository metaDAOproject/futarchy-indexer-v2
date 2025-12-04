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

// RPC connection reference (set by subscriptionManager before subscribing)
let rpcConnection: Connection | null = null;

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

  rpcConnection.onLogs(programId, async (logs: Logs, ctx: Context) => {
    let err: Error | undefined = undefined;
    try {
      logger.debug({ program: indexer.name, signature: logs.signature }, "RPC log received");

      // Wait before fetching - transaction may not be available immediately
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

  logger.info({ program: indexer.name, programId: programId.toString() }, "Subscribed to RPC logs");
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
