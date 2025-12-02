import Client, {
  CommitmentLevel,
  SubscribeRequest,
  SubscribeUpdate,
  SubscribeUpdateTransaction,
} from "@triton-one/yellowstone-grpc";

import { Connection, PublicKey } from "@solana/web3.js";
import { HeliusProvider } from "./providers/helius";
import bs58 from 'bs58';

import { getAllPrograms, getProgramByOwner, getRegisteredProgramIds, ProgramIndexer } from "./registry";
import { decodeEventsFromGrpc, extractBlockTimeFromEvents } from "./eventDecoder";
import { serializeForLogging } from "../indexers/shared/utils";
import { subscribeAll, setRpcConnection } from "../txLogHandler";
import { log } from "../logger/logger";
import { db, schema } from "@metadaoproject/indexer-db";
import {
  backfillHistorical,
  gapFill,
  detectGapFromDb,
  updateIndexerProgress,
} from "./backfill";

const logger = log.child({ module: "subscriptionManager" });

// Subscription state machine
type SubscriptionState =
  | "INITIALIZING"
  | "GRPC_ACTIVE"         // Primary gRPC
  | "BACKUP_GRPC_ACTIVE"  // Backup gRPC
  | "RPC_ACTIVE"          // Fallback RPC
  | "RECONNECTING";

// Health status
interface SubscriptionHealth {
  state: SubscriptionState;
  eventsProcessed: number;
  accountUpdatesProcessed: number;
  lastEventTime: Date | null;
  reconnectAttempts: number;
  geyserConnected: boolean;
}

import {
  getEventCount,
  getAccountUpdateCount,
  incrementEventCounter,
  incrementAccountUpdateCounter,
  eventCountsByProgram,
  accountCountsByType,
} from "./stats";

interface StartOptions {
  dryRun?: boolean;
  enableBackfill?: boolean;  // Enable parallel backfill on startup
  autoGapFill?: boolean;     // Auto gap-fill when Geyser reconnects
}

class SubscriptionManager {
  private state: SubscriptionState = "INITIALIZING";
  private geyserClient: Client | null = null;
  private geyserStream: any = null;
  private heliusProvider: HeliusProvider | null = null;
  private rpcSubscriptionIds: number[] = [];
  private lastPongTime: Date = new Date();
  private lastDataTime: Date = new Date();
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private healthCallback: ((health: SubscriptionHealth) => void) | null = null;
  private dryRun: boolean = false;
  private isGeyser: boolean = false;

  // Backfill settings
  private enableBackfill: boolean = false;
  private autoGapFill: boolean = false;
  private backfillRunning = new Map<string, boolean>();
  private rpcConnection: Connection | null = null;

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
    this.enableBackfill = options.enableBackfill ?? false;
    this.autoGapFill = options.autoGapFill ?? false;

    if (this.dryRun) {
      logger.info("=== DRY-RUN MODE ENABLED ===");
      logger.info("All events and account updates will be logged but NOT written to database");
    }

    logger.info("Starting subscription manager");
    logger.info({
      GRPC_ENDPOINT: process.env.GRPC_ENDPOINT ? "SET" : "NOT SET",
      GRPC_TOKEN: process.env.GRPC_TOKEN ? "SET" : "NOT SET",
      BACKUP_GRPC_ENDPOINT: process.env.BACKUP_GRPC_ENDPOINT ? "SET" : "NOT SET",
      BACKUP_GRPC_API_KEY: process.env.BACKUP_GRPC_API_KEY ? "SET" : "NOT SET",
      enableBackfill: this.enableBackfill,
      autoGapFill: this.autoGapFill,
    }, "Environment check");

    // Initialize RPC connection for backfill
    const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
    if (RPC_ENDPOINT) {
      this.rpcConnection = new Connection(RPC_ENDPOINT, "confirmed");
    }

    // Initialize backup gRPC provider if configured
    if (process.env.BACKUP_GRPC_ENDPOINT && process.env.BACKUP_GRPC_API_KEY) {
      this.heliusProvider = new HeliusProvider(
        process.env.BACKUP_GRPC_ENDPOINT,
        process.env.BACKUP_GRPC_API_KEY
      );
      logger.info("Backup gRPC provider initialized");
    }

    // Try providers in order: Primary gRPC → Backup gRPC → RPC
    logger.info("Attempting to start primary gRPC...");
    const geyserStarted = await this.startGeyser();
    logger.info({ geyserStarted }, "Primary gRPC start result");

    if (!geyserStarted) {
      logger.warn("Primary gRPC failed to start, trying backup gRPC...");
      const backupStarted = await this.startHelius();
      logger.info({ backupStarted }, "Backup gRPC start result");

      if (!backupStarted) {
        logger.warn("Backup gRPC failed to start, falling back to RPC");
        await this.startRpcSubscription();
      }
    }

    // Start parallel backfill for all programs (runs alongside Geyser/RPC)
    if (this.enableBackfill && !this.dryRun && this.rpcConnection) {
      this.startBackfillForAllPrograms();
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
      eventsProcessed: getEventCount(),
      accountUpdatesProcessed: getAccountUpdateCount(),
      lastEventTime: this.lastDataTime,
      reconnectAttempts: this.reconnectAttempts,
      geyserConnected: this.state === "GRPC_ACTIVE" || this.state === "BACKUP_GRPC_ACTIVE",
    };
  }

  getGeyserMode(): boolean {
    return this.isGeyser;
  }

  // ==================== Geyser Methods ====================

  private async startGeyser(): Promise<boolean> {
    const GRPC_TOKEN = process.env.GRPC_TOKEN;
    const GRPC_ENDPOINT = process.env.GRPC_ENDPOINT;

    logger.info({ GRPC_ENDPOINT, hasToken: !!GRPC_TOKEN }, "Starting primary gRPC");

    if (!GRPC_TOKEN || !GRPC_ENDPOINT) {
      logger.warn("GRPC_TOKEN or GRPC_ENDPOINT not set, skipping primary gRPC");
      return false;
    }

    try {
      logger.info("Creating gRPC client...");
      this.geyserClient = new Client(GRPC_ENDPOINT, GRPC_TOKEN, {});
      logger.info("gRPC client created, calling getVersion()...");

      const version = await this.geyserClient.getVersion();
      logger.info({ version }, "getVersion() returned, connected to primary gRPC");

      // Create subscription stream
      logger.info("Creating subscription stream via subscribe()...");
      this.geyserStream = await this.geyserClient.subscribe();
      logger.info("subscribe() returned, stream created");

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

      this.state = "GRPC_ACTIVE";
      this.reconnectAttempts = 0;
      this.isGeyser = true;
      logger.info("Primary gRPC subscription active");

      return true;
    } catch (error) {
      logger.error({ error }, "Failed to start primary gRPC");
      return false;
    }
  }

  /**
   * Start backup gRPC provider
   */
  private async startHelius(): Promise<boolean> {
    if (!this.heliusProvider) {
      logger.warn("Backup gRPC provider not configured, skipping");
      return false;
    }

    try {
      logger.info("Starting backup gRPC subscription...");
      const programIds = getRegisteredProgramIds();

      await this.heliusProvider.subscribe(
        programIds,
        async (data: any) => {
          await this.handleHeliusData(data);
        },
        (error: Error) => {
          logger.error({ error }, "Backup gRPC stream error");
          this.triggerFailover();
        }
      );

      this.state = "BACKUP_GRPC_ACTIVE";
      this.reconnectAttempts = 0;
      this.isGeyser = true;
      logger.info("Backup gRPC subscription active");

      return true;
    } catch (error) {
      logger.error({ error }, "Failed to start backup gRPC");
      return false;
    }
  }

  /**
   * Handle data from Helius Laserstream
   * Helius uses same format as Yellowstone, so we can reuse most logic
   */
  private async handleHeliusData(data: any): Promise<void> {
    this.lastDataTime = new Date();

    // Handle ping/pong
    if (data.pong || data.ping) {
      logger.info("Received pong");
      this.lastPongTime = new Date();
      return;
    }

    // Process transactions (events)
    if (data.transaction) {
      try {
        await this.processGeyserTransaction(data.transaction);
      } catch (error) {
        logger.error({ error }, "Error processing backup gRPC transaction");
      }
    }

    // Process account updates
    if (data.account) {
      try {
        await this.processGeyserAccountUpdate(data.account);
      } catch (error) {
        logger.error({ error }, "Error processing backup gRPC account update");
      }
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

    logger.info("gRPC subscription request sent");
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
              logger.info("Sent ping");
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
      logger.info("Received pong");
      this.lastPongTime = new Date();
      return;
    }

    // Process transactions (events)
    if (data.transaction) {
      try {
        await this.processGeyserTransaction(data.transaction);
      } catch (error) {
        logger.error({ error }, "Error processing gRPC transaction");
      }
    }

    // Process account updates
    if (data.account) {
      try {
        await this.processGeyserAccountUpdate(data.account);
      } catch (error) {
        logger.error({ error }, "Error processing gRPC account update");
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

    logger.debug({ signature, slot }, "Processing gRPC transaction");

    // Use shared decoder for gRPC format
    const decodedEvents = decodeEventsFromGrpc(
      innerInstructions,
      transaction.transaction.transaction?.message?.accountKeys ?? [],
      transaction.transaction.meta?.loadedWritableAddresses ?? [],
      transaction.transaction.meta?.loadedReadonlyAddresses ?? []
    );

    // Extract block time from events
    const blockTime = extractBlockTimeFromEvents(decodedEvents);

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
    // Track which indexers processed events for progress updates
    const processedIndexers = new Set<string>();

    for (const { event, indexer } of decodedEvents) {
      incrementEventCounter();

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
          `\n=== ${indexer.name.toUpperCase()} EVENT #${getEventCount()} ===\n` +
          `Event: ${event.name} (Count: ${count})\n` +
          `Signature: ${signature}\n` +
          `Slot: ${slot.toString()}\n` +
          `BlockTime: ${blockTime?.toISOString() ?? null}\n` +
          `Data:\n${prettyData}\n` +
          `${"=".repeat(50)}`
        );
      } else {
        // Process the event normally
        logger.info({ eventName: event.name, signature, slot }, `${indexer.name} event #${getEventCount()}`);

        // Create a minimal transaction response for the processor
        const txResponse = {
          slot: Number(slot),
          blockTime: blockTime ? Math.floor(blockTime.getTime() / 1000) : null,
          transaction: { signatures: [signature] },
          meta: transaction.transaction.meta,
        } as any;

        await indexer.processEvent(event, signature, txResponse);
        processedIndexers.add(indexer.name);
      }
    }

    // Update progress for all indexers that processed events in this transaction
    if (!this.dryRun) {
      for (const indexerName of processedIndexers) {
        await updateIndexerProgress(indexerName, BigInt(slot), signature);
      }
    }
  }

  private async processGeyserAccountUpdate(accountUpdate: any): Promise<void> {
    incrementAccountUpdateCounter();

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
        `\n=== ${indexer.name.toUpperCase()} ACCOUNT #${getAccountUpdateCount()} ===\n` +
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
    logger.error({ error }, "gRPC stream error");
    this.triggerFailover();
  }

  private handleGeyserEnd(): void {
    logger.warn("gRPC stream ended");
    this.triggerFailover();
  }

  // ==================== RPC Fallback Methods ====================

  private async startRpcSubscription(): Promise<void> {
    logger.info("Starting RPC log subscription (fallback mode)");
    this.state = "RPC_ACTIVE";
    this.isGeyser = false;

    // Wire RPC connection to txLogHandler before subscribing
    if (this.rpcConnection) {
      setRpcConnection(this.rpcConnection);
    }

    // Subscribe to logs for all registered programs
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
    if (this.state === "RPC_ACTIVE" || this.state === "RECONNECTING") {
      return; // Already in failover state
    }

    const failingState = this.state;
    logger.warn({ failingState }, "Triggering failover");
    this.state = "RECONNECTING";

    // Gap detection now uses DB as source of truth - no need to record disconnect slots

    // Clean up current gRPC connection
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

    // Failover chain: Primary gRPC → Backup gRPC → RPC
    if (failingState === 'GRPC_ACTIVE' && this.heliusProvider) {
      logger.info("Primary gRPC failed, trying backup gRPC...");
      const backupStarted = await this.startHelius();
      if (backupStarted) {
        logger.info("Backup gRPC now active");
        await this.handleSmartGapFill();
        this.scheduleGeyserReconnect();
        return;
      }
    }

    // Fall back to RPC
    logger.warn("Falling back to RPC subscription");
    await this.startRpcSubscription();
    this.scheduleGeyserReconnect();
  }

  /**
   * Smart gap-fill: Use backup gRPC replay for small gaps (≤3000 slots), RPC crawl for larger gaps
   */
  private async handleSmartGapFill(): Promise<void> {
    if (!this.autoGapFill || !this.rpcConnection) {
      return;
    }

    const programs = getAllPrograms();
    const currentSlot = BigInt(await this.rpcConnection.getSlot());

    for (const program of programs) {
      if (!program.backfillConfig) continue;

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
        gapSize: gap.gapSize.toString()
      }, "Gap detected");

      // Use backup gRPC replay for small gaps (≤3000 slots)
      if (gap.gapSize <= 3000n && this.heliusProvider) {
        logger.info({ program: program.name, gapSize: gap.gapSize.toString() }, "Using backup gRPC replay for gap-fill");
        try {
          await this.heliusProvider.replayFromSlot(
            [programId],
            gap.fromSlot,
            async (data) => {
              await this.handleHeliusData(data);
            }
          );
          logger.info({ program: program.name }, "Backup gRPC replay gap-fill complete");
        } catch (error) {
          logger.error({ error, program: program.name }, "Backup gRPC replay failed, falling back to RPC crawl");
          // Fall through to RPC gap-fill
          const result = await gapFill(program, this.rpcConnection);
          logger.info({ program: program.name, signatures: result.count }, "RPC gap-fill complete");
        }
      } else {
        // Use RPC signature crawl for large gaps
        logger.info({ program: program.name, gapSize: gap.gapSize.toString() }, "Using RPC signature crawl for gap-fill");
        try {
          const result = await gapFill(program, this.rpcConnection);
          logger.info({ program: program.name, signatures: result.count }, "RPC gap-fill complete");
        } catch (error) {
          logger.error({ error, program: program.name }, "RPC gap-fill failed");
        }
      }
    }
  }

  private scheduleGeyserReconnect(): void {
    this.reconnectAttempts++;
    const delay = this.calculateReconnectDelay(this.reconnectAttempts);

    logger.info({ delay, attempt: this.reconnectAttempts }, "Scheduling gRPC reconnection");

    this.reconnectTimer = setTimeout(async () => {
      logger.info("Attempting gRPC reconnection");

      const success = await this.startGeyser();

      if (success) {
        logger.info("gRPC reconnected successfully");
        this.stopRpcSubscription();
        this.reconnectAttempts = 0;

        // Trigger gap fill for any missed slots during disconnection
        // Uses DB as source of truth - queries latest processed slot and compares to chain
        if (this.autoGapFill && this.rpcConnection) {
          this.handleGeyserReconnectGapFill();
        }
      } else {
        logger.warn("gRPC reconnection failed, staying on RPC");
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
    stats += `Total Events: ${getEventCount()}\n`;
    stats += `Total Account Updates: ${getAccountUpdateCount()}\n`;
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

  // ==================== Backfill Methods ====================

  /**
   * Start backfill for all registered programs in parallel with streaming
   * This runs independently of Geyser/RPC subscriptions
   */
  private async startBackfillForAllPrograms(): Promise<void> {
    const programs = getAllPrograms();

    logger.info({
      programCount: programs.length,
      programs: programs.map(p => p.name)
    }, "Starting backfill for all programs");

    // Start backfill for each program (don't await - run in parallel with streaming)
    for (const program of programs) {
      if (program.backfillConfig) {
        this.runProgramBackfill(program);
      } else {
        logger.info({ program: program.name }, "No backfillConfig, skipping backfill");
      }
    }
  }

  /**
   * Run the full backfill process for a single program
   * Phase 1: Snapshot current account state via .all()
   * Phase 2: Historical signature crawl
   */
  private async runProgramBackfill(indexer: ProgramIndexer): Promise<void> {
    const programId = indexer.programId.toString();

    // Check if already running
    if (this.backfillRunning.get(programId)) {
      logger.info({ program: indexer.name }, "Backfill already running, skipping");
      return;
    }

    this.backfillRunning.set(programId, true);

    try {
      logger.info({ program: indexer.name }, "Starting program backfill");

      // Phase 1: Snapshot current state (fast)
      if (indexer.backfillConfig?.snapshotAccounts) {
        logger.info({ program: indexer.name }, "Phase 1: Running account snapshot");
        try {
          await indexer.backfillConfig.snapshotAccounts();
          logger.info({ program: indexer.name }, "Phase 1: Account snapshot complete");
        } catch (error) {
          logger.error({ error, program: indexer.name }, "Phase 1: Snapshot failed, continuing with signature backfill");
        }
      }

      // Phase 2: Historical signature crawl
      if (this.rpcConnection) {
        logger.info({ program: indexer.name }, "Phase 2: Starting historical signature backfill");
        const result = await backfillHistorical(indexer, this.rpcConnection);

        if (result.error) {
          logger.error({ error: result.error, program: indexer.name }, "Phase 2: Backfill encountered error");
        } else {
          logger.info({ program: indexer.name, signatures: result.count }, "Phase 2: Historical backfill complete");
        }
      }
    } catch (error) {
      logger.error({ error, program: indexer.name }, "Backfill failed");
    } finally {
      this.backfillRunning.set(programId, false);
    }
  }

  /**
   * Handle gap fill when Geyser reconnects after a disconnection
   * Uses DB as source of truth for gap detection
   */
  private async handleGeyserReconnectGapFill(): Promise<void> {
    if (!this.autoGapFill || !this.rpcConnection) {
      return;
    }

    const programs = getAllPrograms();
    const currentSlot = BigInt(await this.rpcConnection.getSlot());

    for (const program of programs) {
      if (!program.backfillConfig) continue;

      const programId = program.programId.toString();
      // Use indexer name for gap detection (queries indexers table)
      const gap = await detectGapFromDb(program.name, currentSlot);

      if (gap.hasGap) {
        logger.info({
          program: program.name,
          fromSlot: gap.fromSlot.toString(),
          toSlot: gap.toSlot.toString(),
          gapSize: gap.gapSize.toString()
        }, "Gap detected, starting gap fill");

        // Use smart gap-fill strategy
        if (gap.gapSize <= 3000n && this.heliusProvider) {
          try {
            await this.heliusProvider.replayFromSlot(
              [programId],
              gap.fromSlot,
              async (data) => {
                await this.handleHeliusData(data);
              }
            );
            logger.info({ program: program.name }, "Backup gRPC replay gap-fill complete");
          } catch (error) {
            logger.error({ error, program: program.name }, "Backup gRPC replay failed, using RPC");
            const result = await gapFill(program, this.rpcConnection);
            logger.info({ program: program.name, signatures: result.count }, "RPC gap fill complete");
          }
        } else {
          try {
            const result = await gapFill(program, this.rpcConnection);
            logger.info({ program: program.name, signatures: result.count }, "Gap fill complete");
          } catch (error) {
            logger.error({ error, program: program.name }, "Gap fill failed");
          }
        }
      }
    }
  }
}

// Export singleton instance
export const subscriptionManager = new SubscriptionManager();
