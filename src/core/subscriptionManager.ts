import Client, {
  CommitmentLevel,
  SubscribeRequest,
  SubscribeUpdate,
  SubscribeUpdateTransaction,
} from "@triton-one/yellowstone-grpc";

import { PublicKey } from "@solana/web3.js";
import bs58 from 'bs58';
import assert from "assert";
import * as anchor from "@coral-xyz/anchor";

import { getAllPrograms, getProgramByOwner, getRegisteredProgramIds, ProgramIndexer } from "./registry";
import { serializeForLogging } from "../indexers/shared/utils";
import { subscribeAll } from "../txLogHandler";
import { log } from "../logger/logger";
import { db, schema } from "@metadaoproject/indexer-db";

const logger = log.child({ module: "subscriptionManager" });

// Subscription state machine
type SubscriptionState =
  | "INITIALIZING"
  | "GEYSER_ACTIVE"
  | "RPC_ACTIVE"
  | "GEYSER_RECONNECTING";

// Health status
interface SubscriptionHealth {
  state: SubscriptionState;
  eventsProcessed: number;
  accountUpdatesProcessed: number;
  lastEventTime: Date | null;
  reconnectAttempts: number;
  geyserConnected: boolean;
}

// Stats counters
let eventCounter = 0;
let accountUpdateCounter = 0;
// Per-program event counts (program name -> event name -> count)
const eventCountsByProgram: Map<string, Map<string, number>> = new Map();
// Per-account type counts
const accountCountsByType: Map<string, number> = new Map();

interface StartOptions {
  dryRun?: boolean;
}

class SubscriptionManager {
  private state: SubscriptionState = "INITIALIZING";
  private geyserClient: Client | null = null;
  private geyserStream: any = null;
  private rpcSubscriptionIds: number[] = [];
  private lastPongTime: Date = new Date();
  private lastDataTime: Date = new Date();
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private healthCallback: ((health: SubscriptionHealth) => void) | null = null;
  private dryRun: boolean = false;
  private isGeyser: boolean = false;

  // Reconnection settings
  private readonly INITIAL_RECONNECT_DELAY = 1000; // 1 second
  private readonly MAX_RECONNECT_DELAY = 60000; // 60 seconds
  private readonly PONG_TIMEOUT = 60000; // 60 seconds
  private readonly PING_INTERVAL = 30000; // 30 seconds

  setHealthCallback(callback: (health: SubscriptionHealth) => void) {
    this.healthCallback = callback;
  }

  async start(options: StartOptions = {}): Promise<void> {
    this.dryRun = options.dryRun ?? false;

    if (this.dryRun) {
      logger.info("=== DRY-RUN MODE ENABLED ===");
      logger.info("All events and account updates will be logged but NOT written to database");
    }

    logger.info("Starting subscription manager");
    logger.info({
      GRPC_ENDPOINT: process.env.GRPC_ENDPOINT ? "SET" : "NOT SET",
      GRPC_TOKEN: process.env.GRPC_TOKEN ? "SET" : "NOT SET",
    }, "Environment check");

    // Try Geyser first
    logger.info("Attempting to start Geyser...");
    const geyserStarted = await this.startGeyser();
    logger.info({ geyserStarted }, "Geyser start result");

    if (!geyserStarted) {
      logger.warn("Geyser failed to start, falling back to RPC");
      await this.startRpcSubscription();
    }
  }

  async stop(): Promise<void> {
    logger.info("Stopping subscription manager");

    // Clear timers
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Stop Geyser
    if (this.geyserStream) {
      this.geyserStream.end();
      this.geyserStream = null;
    }
    if (this.geyserClient) {
      this.geyserClient = null;
    }

    // Stop RPC subscriptions
    this.stopRpcSubscription();

    this.state = "INITIALIZING";
  }

  getHealth(): SubscriptionHealth {
    return {
      state: this.state,
      eventsProcessed: eventCounter,
      accountUpdatesProcessed: accountUpdateCounter,
      lastEventTime: this.lastDataTime,
      reconnectAttempts: this.reconnectAttempts,
      geyserConnected: this.state === "GEYSER_ACTIVE",
    };
  }

  getGeyserMode(): boolean {
    return this.isGeyser;
  }

  // ==================== Geyser Methods ====================

  private async startGeyser(): Promise<boolean> {
    const GRPC_TOKEN = process.env.GRPC_TOKEN;
    const GRPC_ENDPOINT = process.env.GRPC_ENDPOINT;

    logger.info({ GRPC_ENDPOINT, hasToken: !!GRPC_TOKEN }, "startGeyser called");

    if (!GRPC_TOKEN || !GRPC_ENDPOINT) {
      logger.warn("GRPC_TOKEN or GRPC_ENDPOINT not set, skipping Geyser");
      return false;
    }

    try {
      logger.info("Creating Geyser client...");
      this.geyserClient = new Client(GRPC_ENDPOINT, GRPC_TOKEN, {});
      logger.info("Geyser client created, getting version...");

      const version = await this.geyserClient.getVersion();
      logger.info({ version }, "Connected to Yellowstone gRPC");

      // Create subscription stream
      logger.info("Creating subscription stream...");
      this.geyserStream = await this.geyserClient.subscribe();
      logger.info("Subscription stream created");

      // Set up event handlers
      this.geyserStream.on("data", async (data: SubscribeUpdate) => {
        await this.handleGeyserData(data);
      });

      this.geyserStream.on("error", (error: Error) => {
        this.handleGeyserError(error);
      });

      this.geyserStream.on("end", () => {
        this.handleGeyserEnd();
      });

      // Send subscription request
      await this.sendGeyserSubscription();

      // Start ping keepalive
      this.startPingInterval();

      this.state = "GEYSER_ACTIVE";
      this.reconnectAttempts = 0;
      this.isGeyser = true;
      logger.info("Geyser subscription active");

      return true;
    } catch (error) {
      logger.error({ error }, "Failed to start Geyser");
      return false;
    }
  }

  private async sendGeyserSubscription(): Promise<void> {
    // Get all registered program IDs from the registry
    const programIds = getRegisteredProgramIds();

    if (programIds.length === 0) {
      logger.warn("No programs registered! Make sure to import indexers before starting.");
    }

    // Build accounts subscription dynamically from registered programs
    const accountsSubscription: Record<string, { owner: string[]; account: string[]; filters: any[] }> = {};

    for (const program of getAllPrograms()) {
      accountsSubscription[`${program.name}_accounts`] = {
        owner: [program.programId.toString()],
        account: [],
        filters: [],
      };
    }

    const request: SubscribeRequest = {
      transactions: {
        metadao_programs: {
          accountInclude: programIds,
          accountExclude: [],
          accountRequired: [],
          failed: false,
        },
      },
      accounts: accountsSubscription,
      slots: {},
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      entry: {},
      transactionsStatus: {},
      commitment: CommitmentLevel.CONFIRMED,
    };

    await new Promise<void>((resolve, reject) => {
      this.geyserStream.write(request, (err: Error | null | undefined) => {
        if (err === null || err === undefined) {
          resolve();
        } else {
          reject(err);
        }
      });
    });

    logger.info("Geyser subscription request sent");
    for (const program of getAllPrograms()) {
      logger.info(`  - ${program.name}: ${program.programId.toString()}`);
    }
  }

  private startPingInterval(): void {
    this.pingInterval = setInterval(async () => {
      // Check for pong timeout
      const timeSinceLastPong = Date.now() - this.lastPongTime.getTime();
      if (timeSinceLastPong > this.PONG_TIMEOUT) {
        logger.error("Pong timeout, triggering failover");
        await this.triggerFailover();
        return;
      }

      // Send ping
      const pingRequest: SubscribeRequest = {
        ping: { id: 1 },
        accounts: {},
        accountsDataSlice: [],
        transactions: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        slots: {},
      };

      try {
        await new Promise<void>((resolve, reject) => {
          this.geyserStream.write(pingRequest, (err: Error | null | undefined) => {
            if (err === null || err === undefined) {
              resolve();
            } else {
              reject(err);
            }
          });
        });
      } catch (error) {
        logger.error({ error }, "Ping failed");
      }

      // Report health
      if (this.healthCallback) {
        this.healthCallback(this.getHealth());
      }

      // Log stats
      this.printStats();
    }, this.PING_INTERVAL);
  }

  private async handleGeyserData(data: SubscribeUpdate): Promise<void> {
    this.lastDataTime = new Date();

    // Handle ping/pong (server sends ping, we ignore; pong is response to our ping)
    if (data.pong || data.ping) {
      this.lastPongTime = new Date();
      return;
    }

    // Process transactions (events)
    if (data.transaction) {
      try {
        await this.processGeyserTransaction(data.transaction);
      } catch (error) {
        logger.error({ error }, "Error processing Geyser transaction");
      }
    }

    // Process account updates
    if (data.account) {
      try {
        await this.processGeyserAccountUpdate(data.account);
      } catch (error) {
        logger.error({ error }, "Error processing Geyser account update");
      }
    }
  }

  private async processGeyserTransaction(transaction: SubscribeUpdateTransaction): Promise<void> {
    if (!transaction.transaction || !transaction.transaction.meta) {
      return;
    }

    const innerInstructions = transaction.transaction.meta.innerInstructions;
    const signature = bs58.encode(Buffer.from(transaction.transaction.signature));
    const slot = transaction.slot;

    logger.debug({ signature, slot }, "Processing Geyser transaction");

    // FIRST PASS: Decode all events and extract timestamp
    let blockTime: Date | null = null;
    const decodedEvents: Array<{ event: any; indexer: ProgramIndexer }> = [];

    for (const innerInstruction of innerInstructions) {
      for (const ix of innerInstruction.instructions) {
        let addresses: Uint8Array[] = [];
        addresses = addresses.concat(transaction.transaction.transaction?.message?.accountKeys ?? []);
        addresses = addresses.concat(transaction.transaction.meta?.loadedWritableAddresses ?? []);
        addresses = addresses.concat(transaction.transaction.meta?.loadedReadonlyAddresses ?? []);

        assert(ix.programIdIndex < addresses.length, "programIdIndex is out of bounds");
        const programId = new PublicKey(addresses[ix.programIdIndex]);

        // Find the indexer for this program
        const indexer = getProgramByOwner(programId);
        if (!indexer) {
          continue;
        }

        // Try to decode as an event
        const event = indexer.decodeEvent(Buffer.from(ix.data));
        if (!event) {
          continue;
        }

        decodedEvents.push({ event, indexer });

        // Extract timestamp from first event that has it
        if (!blockTime && event.data?.common?.unixTimestamp) {
          const unixTs = Number(event.data.common.unixTimestamp);
          blockTime = new Date(unixTs * 1000);
        }
      }
    }

    // INSERT SIGNATURE with timestamp
    if (!this.dryRun) {
      try {
        await db.insert(schema.signatures).values({
          signature,
          slot: slot.toString(),
          didErr: transaction.transaction.meta.err !== null,
          err: transaction.transaction.meta.err ? JSON.stringify(transaction.transaction.meta.err) : null,
          blockTime: blockTime,
        }).onConflictDoNothing().execute();
      } catch (e) {
        logger.warn({ error: e }, "Error inserting signature");
      }
    } else {
      logger.info({
        type: 'signature',
        signature,
        slot: slot.toString(),
        didErr: transaction.transaction.meta.err !== null,
        blockTime: blockTime?.toISOString() ?? null,
      }, `[DRY-RUN] Would insert signature`);
    }

    // Skip if transaction had an error
    if (transaction.transaction.meta.err) {
      return;
    }

    // SECOND PASS: Process decoded events
    for (const { event, indexer } of decodedEvents) {
      eventCounter++;

      if (this.dryRun) {
        // Track per-program event counts
        let programCounts = eventCountsByProgram.get(indexer.name);
        if (!programCounts) {
          programCounts = new Map();
          eventCountsByProgram.set(indexer.name, programCounts);
        }
        const count = (programCounts.get(event.name) || 0) + 1;
        programCounts.set(event.name, count);

        // Log with pretty-printed JSON like geyser.ts
        const prettyData = JSON.stringify(serializeForLogging(event.data), null, 2);
        logger.info(
          `\n=== ${indexer.name.toUpperCase()} EVENT #${eventCounter} ===\n` +
          `Event: ${event.name} (Count: ${count})\n` +
          `Signature: ${signature}\n` +
          `Slot: ${slot.toString()}\n` +
          `BlockTime: ${blockTime?.toISOString() ?? null}\n` +
          `Data:\n${prettyData}\n` +
          `${"=".repeat(50)}`
        );
      } else {
        // Process the event normally
        logger.info({ eventName: event.name, signature, slot }, `${indexer.name} event #${eventCounter}`);

        // Create a minimal transaction response for the processor
        const txResponse = {
          slot: Number(slot),
          blockTime: blockTime ? Math.floor(blockTime.getTime() / 1000) : null,
          transaction: { signatures: [signature] },
          meta: transaction.transaction.meta,
        } as any;

        await indexer.processEvent(event, signature, txResponse);
      }
    }
  }

  private async processGeyserAccountUpdate(accountUpdate: any): Promise<void> {
    accountUpdateCounter++;

    if (!accountUpdate.account) {
      return;
    }

    const account = accountUpdate.account;
    const pubkey = bs58.encode(Buffer.from(account.pubkey));
    const owner = new PublicKey(account.owner);
    const slot = BigInt(accountUpdate.slot);
    const data = Buffer.from(account.data);

    // Find the indexer for this program
    const indexer = getProgramByOwner(owner);
    if (!indexer) {
      return;
    }

    // Get discriminator (first 8 bytes) to identify account type
    const discriminator = bs58.encode(data.slice(0, 8));

    // Try to decode the account
    const decoded = indexer.decodeAccount(discriminator, data);
    if (!decoded) {
      logger.debug({ pubkey, discriminator, program: indexer.name }, "Unknown account type");
      return;
    }

    if (this.dryRun) {
      // Track per-account type counts
      const accountKey = `${indexer.name}:${decoded.type}`;
      const count = (accountCountsByType.get(accountKey) || 0) + 1;
      accountCountsByType.set(accountKey, count);

      // Log with pretty-printed JSON like geyser.ts
      const prettyData = JSON.stringify(serializeForLogging(decoded.data), null, 2);
      logger.info(
        `\n=== ${indexer.name.toUpperCase()} ACCOUNT #${accountUpdateCounter} ===\n` +
        `Type: ${decoded.type} (Count: ${count})\n` +
        `Pubkey: ${pubkey}\n` +
        `Slot: ${slot.toString()}\n` +
        `Data:\n${prettyData}\n` +
        `${"=".repeat(50)}`
      );
    } else {
      // Process the account update normally
      logger.debug({ pubkey, slot: slot.toString(), accountType: decoded.type }, `${decoded.type} account update`);
      await indexer.processAccountUpdate(pubkey, decoded.type, decoded.data, slot);
    }
  }

  private handleGeyserError(error: Error): void {
    logger.error({ error }, "Geyser stream error");
    this.triggerFailover();
  }

  private handleGeyserEnd(): void {
    logger.warn("Geyser stream ended");
    this.triggerFailover();
  }

  // ==================== RPC Fallback Methods ====================

  private async startRpcSubscription(): Promise<void> {
    logger.info("Starting RPC log subscription (fallback mode)");
    this.state = "RPC_ACTIVE";
    this.isGeyser = false;

    // Use existing subscribeAll from txLogHandler
    await subscribeAll();

    logger.info("RPC subscription active");
  }

  private stopRpcSubscription(): void {
    // RPC subscriptions are managed by connection.onLogs
    // They auto-reconnect, so we just update state
    logger.info("Stopping RPC subscription");
  }

  // ==================== Failover Logic ====================

  private async triggerFailover(): Promise<void> {
    if (this.state === "RPC_ACTIVE" || this.state === "GEYSER_RECONNECTING") {
      return; // Already in failover state
    }

    logger.warn("Triggering failover to RPC");
    this.state = "GEYSER_RECONNECTING";

    // Clean up Geyser
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.geyserStream) {
      try {
        this.geyserStream.end();
      } catch {}
      this.geyserStream = null;
    }

    // Start RPC fallback
    await this.startRpcSubscription();

    // Schedule Geyser reconnection
    this.scheduleGeyserReconnect();
  }

  private scheduleGeyserReconnect(): void {
    this.reconnectAttempts++;
    const delay = this.calculateReconnectDelay(this.reconnectAttempts);

    logger.info({ delay, attempt: this.reconnectAttempts }, "Scheduling Geyser reconnection");

    this.reconnectTimer = setTimeout(async () => {
      logger.info("Attempting Geyser reconnection");

      const success = await this.startGeyser();

      if (success) {
        logger.info("Geyser reconnected successfully");
        this.stopRpcSubscription();
        this.reconnectAttempts = 0;
      } else {
        logger.warn("Geyser reconnection failed, staying on RPC");
        this.scheduleGeyserReconnect();
      }
    }, delay);
  }

  private calculateReconnectDelay(attempt: number): number {
    // Exponential backoff with jitter
    const exponentialDelay = Math.min(
      this.INITIAL_RECONNECT_DELAY * Math.pow(2, attempt - 1),
      this.MAX_RECONNECT_DELAY
    );

    // Add jitter (+/- 20%)
    const jitter = exponentialDelay * 0.2 * (Math.random() * 2 - 1);

    return Math.floor(exponentialDelay + jitter);
  }

  private printStats(): void {
    let stats = `\n${"=".repeat(60)}\n`;
    stats += `SUBSCRIPTION STATISTICS${this.dryRun ? ' (DRY-RUN)' : ''}\n`;
    stats += `${"=".repeat(60)}\n`;
    stats += `State: ${this.state}\n`;
    stats += `Total Events: ${eventCounter}\n`;
    stats += `Total Account Updates: ${accountUpdateCounter}\n`;
    stats += `Reconnect Attempts: ${this.reconnectAttempts}\n\n`;

    // Per-program event stats
    for (const [program, counts] of eventCountsByProgram.entries()) {
      stats += `${program.toUpperCase()} EVENTS:\n`;
      const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
      for (const [eventName, count] of sorted) {
        stats += `  ${eventName.padEnd(35)} ${count}\n`;
      }
      stats += '\n';
    }

    // Per-account type stats
    if (accountCountsByType.size > 0) {
      stats += `ACCOUNT UPDATES:\n`;
      const sorted = Array.from(accountCountsByType.entries()).sort((a, b) => b[1] - a[1]);
      for (const [accountType, count] of sorted) {
        stats += `  ${accountType.padEnd(35)} ${count}\n`;
      }
    }

    stats += `${"=".repeat(60)}`;
    logger.info(stats);
  }
}

// Export singleton instance
export const subscriptionManager = new SubscriptionManager();
