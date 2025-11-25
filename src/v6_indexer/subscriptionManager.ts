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
import {
  LAUNCHPAD_PROGRAM_ID,
  FUTARCHY_PROGRAM_ID,
  CONDITIONAL_VAULT_PROGRAM_ID,
  FutarchyEvent,
  LaunchpadEvent,
  ConditionalVaultEvent
} from "@metadaoproject/futarchy/v0.6";

import { futarchyClient, conditionalVaultClient, launchpadClient } from "./connection";
import { processFutarchyEvent, processLaunchpadEvent, processVaultEvent } from "./processor";
import { upsertV06Dao, upsertV06Proposal } from "./utils";
import { subscribeAll } from "../txLogHandler";
import { log } from "../logger/logger";
import { db, schema, eq } from "@metadaoproject/indexer-db";

const logger = log.child({ module: "subscriptionManager" });

// Account discriminators (first 8 bytes identify account type)
// These are derived from sha256("account:<AccountName>")[0..8]
const DISCRIMINATORS = {
  // Futarchy program accounts
  dao: futarchyClient.autocrat.coder.accounts.memcmp("dao").bytes,
  proposal: futarchyClient.autocrat.coder.accounts.memcmp("proposal").bytes,
  stakeAccount: futarchyClient.autocrat.coder.accounts.memcmp("stakeAccount").bytes,
  // Launchpad program accounts
  launch: launchpadClient.launchpad.coder.accounts.memcmp("launch").bytes,
  fundingRecord: launchpadClient.launchpad.coder.accounts.memcmp("fundingRecord").bytes,
  // Vault program accounts
  conditionalVault: conditionalVaultClient.vaultProgram.coder.accounts.memcmp("conditionalVault").bytes,
  question: conditionalVaultClient.vaultProgram.coder.accounts.memcmp("question").bytes,
};

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

  // Reconnection settings
  private readonly INITIAL_RECONNECT_DELAY = 1000; // 1 second
  private readonly MAX_RECONNECT_DELAY = 60000; // 60 seconds
  private readonly PONG_TIMEOUT = 60000; // 60 seconds
  private readonly PING_INTERVAL = 30000; // 30 seconds

  setHealthCallback(callback: (health: SubscriptionHealth) => void) {
    this.healthCallback = callback;
  }

  async start(): Promise<void> {
    logger.info("Starting subscription manager");

    // Try Geyser first
    const geyserStarted = await this.startGeyser();

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

  // ==================== Geyser Methods ====================

  private async startGeyser(): Promise<boolean> {
    const GRPC_TOKEN = process.env.GRPC_TOKEN;
    const GRPC_ENDPOINT = process.env.GRPC_ENDPOINT;

    if (!GRPC_TOKEN || !GRPC_ENDPOINT) {
      logger.warn("GRPC_TOKEN or GRPC_ENDPOINT not set, skipping Geyser");
      return false;
    }

    try {
      this.geyserClient = new Client(GRPC_ENDPOINT, GRPC_TOKEN, {});

      const version = await this.geyserClient.getVersion();
      logger.info({ version }, "Connected to Yellowstone gRPC");

      // Create subscription stream
      this.geyserStream = await this.geyserClient.subscribe();

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
      logger.info("Geyser subscription active");

      return true;
    } catch (error) {
      logger.error({ error }, "Failed to start Geyser");
      return false;
    }
  }

  private async sendGeyserSubscription(): Promise<void> {
    const request: SubscribeRequest = {
      transactions: {
        metadao_programs: {
          accountInclude: [
            FUTARCHY_PROGRAM_ID.toString(),
            LAUNCHPAD_PROGRAM_ID.toString(),
            CONDITIONAL_VAULT_PROGRAM_ID.toString(),
          ],
          accountExclude: [],
          accountRequired: [],
          failed: false,
        },
      },
      accounts: {
        futarchy_accounts: {
          owner: [FUTARCHY_PROGRAM_ID.toString()],
          account: [],
          filters: [],
        },
        launchpad_accounts: {
          owner: [LAUNCHPAD_PROGRAM_ID.toString()],
          account: [],
          filters: [],
        },
        vault_accounts: {
          owner: [CONDITIONAL_VAULT_PROGRAM_ID.toString()],
          account: [],
          filters: [],
        },
      },
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
    logger.info(`  - Futarchy: ${FUTARCHY_PROGRAM_ID.toString()}`);
    logger.info(`  - Launchpad: ${LAUNCHPAD_PROGRAM_ID.toString()}`);
    logger.info(`  - Vault: ${CONDITIONAL_VAULT_PROGRAM_ID.toString()}`);
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

    // Handle pong
    if (data.pong) {
      this.lastPongTime = new Date();
      logger.debug(`Pong received | Events: ${eventCounter} | Account Updates: ${accountUpdateCounter}`);
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

    // Insert signature record
    try {
      await db.insert(schema.signatures).values({
        signature,
        slot: slot.toString(),
        didErr: transaction.transaction.meta.err !== null,
        err: transaction.transaction.meta.err ? JSON.stringify(transaction.transaction.meta.err) : null,
        blockTime: null, // Geyser doesn't provide blockTime in transaction update
      }).onConflictDoNothing().execute();
    } catch (e) {
      logger.warn({ error: e }, "Error inserting signature");
    }

    // Skip if transaction had an error
    if (transaction.transaction.meta.err) {
      return;
    }

    for (const innerInstruction of innerInstructions) {
      for (const ix of innerInstruction.instructions) {
        let addresses: Uint8Array[] = [];
        addresses = addresses.concat(transaction.transaction.transaction?.message?.accountKeys ?? []);
        addresses = addresses.concat(transaction.transaction.meta?.loadedWritableAddresses ?? []);
        addresses = addresses.concat(transaction.transaction.meta?.loadedReadonlyAddresses ?? []);

        assert(ix.programIdIndex < addresses.length, "programIdIndex is out of bounds");
        const programId = new PublicKey(addresses[ix.programIdIndex]);

        // Process Futarchy events (NO FILTERING - process all including SpotSwap)
        if (programId.equals(FUTARCHY_PROGRAM_ID)) {
          const eventData = anchor.utils.bytes.base64.encode(Buffer.from(ix.data).slice(8));
          try {
            const event = futarchyClient.autocrat.coder.events.decode(eventData);
            if (event) {
              eventCounter++;
              logger.info({ eventName: event.name, signature, slot }, `Futarchy event #${eventCounter}`);

              // Create a minimal transaction response for the processor
              const txResponse = {
                slot: Number(slot),
                blockTime: null,
                transaction: { signatures: [signature] },
                meta: transaction.transaction.meta,
              } as any;

              await processFutarchyEvent({ name: event.name, data: event.data as FutarchyEvent }, signature, txResponse);
            }
          } catch (decodeError) {
            // Not all instructions are events, this is expected
          }
        }

        // Process Launchpad events
        if (programId.equals(LAUNCHPAD_PROGRAM_ID)) {
          const eventData = anchor.utils.bytes.base64.encode(Buffer.from(ix.data).slice(8));
          try {
            const event = launchpadClient.launchpad.coder.events.decode(eventData);
            if (event) {
              eventCounter++;
              logger.info({ eventName: event.name, signature, slot }, `Launchpad event #${eventCounter}`);

              const txResponse = {
                slot: Number(slot),
                blockTime: null,
                transaction: { signatures: [signature] },
                meta: transaction.transaction.meta,
              } as any;

              await processLaunchpadEvent({ name: event.name, data: event.data as LaunchpadEvent }, signature, txResponse);
            }
          } catch (decodeError) {
            // Not all instructions are events
          }
        }

        // Process Vault events
        if (programId.equals(CONDITIONAL_VAULT_PROGRAM_ID)) {
          const eventData = anchor.utils.bytes.base64.encode(Buffer.from(ix.data).slice(8));
          try {
            const event = conditionalVaultClient.vaultProgram.coder.events.decode(eventData);
            if (event) {
              eventCounter++;
              logger.info({ eventName: event.name, signature, slot }, `Vault event #${eventCounter}`);

              const txResponse = {
                slot: Number(slot),
                blockTime: null,
                transaction: { signatures: [signature] },
                meta: transaction.transaction.meta,
              } as any;

              await processVaultEvent({ name: event.name, data: event.data as ConditionalVaultEvent }, signature, txResponse);
            }
          } catch (decodeError) {
            // Not all instructions are events
          }
        }
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

    // Get discriminator (first 8 bytes) to identify account type
    const discriminator = bs58.encode(data.slice(0, 8));

    // Process Futarchy accounts
    if (owner.equals(FUTARCHY_PROGRAM_ID)) {
      if (discriminator === DISCRIMINATORS.dao) {
        const dao = futarchyClient.autocrat.coder.accounts.decode("dao", data);
        logger.debug({ pubkey, slot: slot.toString() }, "DAO account update");
        await upsertV06Dao(dao, new PublicKey(pubkey), db, slot);
        return;
      }

      if (discriminator === DISCRIMINATORS.proposal) {
        const proposal = futarchyClient.autocrat.coder.accounts.decode("proposal", data);
        logger.debug({ pubkey, slot: slot.toString() }, "Proposal account update");
        await upsertV06Proposal(proposal, new PublicKey(pubkey), slot, null, db);
        return;
      }

      if (discriminator === DISCRIMINATORS.stakeAccount) {
        const stakeAccount = futarchyClient.autocrat.coder.accounts.decode("stakeAccount", data);
        logger.debug({ pubkey, slot: slot.toString() }, "StakeAccount update");
        await db.update(schema.v0_6_staking_record).set({
          totalStaked: stakeAccount.amount.toString(),
          updatedAtSlot: slot,
        }).where(eq(schema.v0_6_staking_record.stakeAddr, pubkey));
        return;
      }

      logger.debug({ pubkey, discriminator }, "Unknown Futarchy account type");
      return;
    }

    // Process Launchpad accounts
    if (owner.equals(LAUNCHPAD_PROGRAM_ID)) {
      if (discriminator === DISCRIMINATORS.launch) {
        const launch = launchpadClient.launchpad.coder.accounts.decode("launch", data);
        logger.debug({ pubkey, slot: slot.toString() }, "Launch account update");
        // TODO: Add upsertLaunch function
        return;
      }

      if (discriminator === DISCRIMINATORS.fundingRecord) {
        const fundingRecord = launchpadClient.launchpad.coder.accounts.decode("fundingRecord", data);
        logger.debug({ pubkey, slot: slot.toString() }, "FundingRecord update");
        // TODO: Add upsertFundingRecord function
        return;
      }

      logger.debug({ pubkey, discriminator }, "Unknown Launchpad account type");
      return;
    }

    // Process Vault accounts
    if (owner.equals(CONDITIONAL_VAULT_PROGRAM_ID)) {
      if (discriminator === DISCRIMINATORS.conditionalVault) {
        const vault = conditionalVaultClient.vaultProgram.coder.accounts.decode("conditionalVault", data);
        logger.debug({ pubkey, slot: slot.toString() }, "ConditionalVault update");
        // TODO: Add upsertVault function
        return;
      }

      if (discriminator === DISCRIMINATORS.question) {
        const question = conditionalVaultClient.vaultProgram.coder.accounts.decode("question", data);
        logger.debug({ pubkey, slot: slot.toString() }, "Question update");
        // TODO: Add upsertQuestion function
        return;
      }

      logger.debug({ pubkey, discriminator }, "Unknown Vault account type");
      return;
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
    logger.info({
      state: this.state,
      events: eventCounter,
      accountUpdates: accountUpdateCounter,
      reconnectAttempts: this.reconnectAttempts,
    }, "Subscription stats");
  }
}

// Export singleton instance
export const subscriptionManager = new SubscriptionManager();
