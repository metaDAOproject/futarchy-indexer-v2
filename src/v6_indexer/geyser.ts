import Client, {
  CommitmentLevel,
  SubscribeRequest,
  SubscribeUpdate,
  SubscribeUpdateTransaction,
} from "@triton-one/yellowstone-grpc";

import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from 'bs58';
import assert from "assert";
import {
  LAUNCHPAD_PROGRAM_ID,
  FUTARCHY_PROGRAM_ID,
  CONDITIONAL_VAULT_PROGRAM_ID,
  FutarchyClient,
  FutarchyEvent,
 } from "@metadaoproject/futarchy/v0.6";
 import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
 import * as anchor from "@coral-xyz/anchor";
import { processFutarchyEvent } from "./processor";
import { insertSignatures } from "./filler";

import { connection, provider, futarchyClient, conditionalVaultClient, launchpadClient } from "./connection";

let eventCounter = 0;

// Event counters per program
const futarchyEventCounts = new Map<string, number>();
const launchpadEventCounts = new Map<string, number>();
const vaultEventCounts = new Map<string, number>();

// Account update counters per account type
const accountUpdateCounts = new Map<string, number>();
let totalAccountUpdates = 0;

// Helper function to serialize objects for readable logging
function serializeForLogging(obj: any, depth = 0, maxDepth = 10): any {
  // Handle null/undefined
  if (obj === null || obj === undefined) return obj;

  // Handle BigNumber (BN) - check BEFORE depth limit
  if (obj && obj.constructor && obj.constructor.name === 'BN') {
    return obj.toString();
  }

  // Handle PublicKey - check BEFORE depth limit
  if (obj && typeof obj === 'object' && obj._bn && typeof obj.toBase58 === 'function') {
    return obj.toBase58();
  }

  // Handle bigint
  if (typeof obj === 'bigint') {
    return obj.toString();
  }

  // NOW check depth limit (after handling BN/PublicKey)
  if (depth > maxDepth) return '[Max Depth Reached]';

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => serializeForLogging(item, depth + 1, maxDepth));
  }

  // Handle objects
  if (typeof obj === 'object') {
    const serialized: any = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        serialized[key] = serializeForLogging(obj[key], depth + 1, maxDepth);
      }
    }
    return serialized;
  }

  // Return primitives as-is
  return obj;
}

async function main() {
  const GRPC_TOKEN = process.env.GRPC_TOKEN;
  const GRPC_ENDPOINT = process.env.GRPC_ENDPOINT;

  if (!GRPC_TOKEN) {
    throw new Error("GRPC_TOKEN is not set");
  }

  if (!GRPC_ENDPOINT) {
    throw new Error("GRPC_ENDPOINT is not set");
  }

  const client = new Client(GRPC_ENDPOINT, GRPC_TOKEN, {});

  const version = await client.getVersion();
  console.log("Connected to Yellowstone gRPC:", version);

  // Create subscription stream
  const stream = await client.subscribe();

  // Handle all incoming data
  stream.on("data", async (data: SubscribeUpdate) => {
    // Handle pong responses
    if (data.pong) {
      console.log(`[${new Date().toISOString()}] Pong | Events: ${eventCounter}`);
      return;
    }

    // Process transactions
    if (data.transaction) {
      try {
        await processTransaction(data.transaction);
      } catch (error) {
        console.error("Error processing transaction:", error);
      }
    }

    // Process account updates
    if (data.account) {
      try {
        await processAccountUpdate(data.account);
      } catch (error) {
        console.error("Error processing account update:", error);
      }
    }
  });

  stream.on("error", (error) => {
    console.error("Stream error:", error);
  });

  stream.on("end", () => {
    console.log("Stream ended");
  });

  // Create subscription request
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

  // Send subscription request
  await new Promise<void>((resolve, reject) => {
    stream.write(request, (err: Error | null | undefined) => {
      if (err === null || err === undefined) {
        resolve();
      } else {
        reject(err);
      }
    });
  }).catch((reason) => {
    console.error("Failed to subscribe:", reason);
    throw reason;
  });

  console.log("Subscribed to programs:");
  console.log("  - Futarchy:", FUTARCHY_PROGRAM_ID.toString());
  console.log("  - Launchpad:", LAUNCHPAD_PROGRAM_ID.toString());
  console.log("  - Vault:", CONDITIONAL_VAULT_PROGRAM_ID.toString());

  // Ping keepalive and stats logging
  const PING_INTERVAL_MILLISECONDS = 30000;
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

  setInterval(async () => {
    // Send ping
    await new Promise<void>((resolve, reject) => {
      stream.write(pingRequest, (err: Error | null | undefined) => {
        if (err === null || err === undefined) {
          resolve();
        } else {
          reject(err);
        }
      });
    }).catch((reason) => {
      console.error("Ping failed:", reason);
    });

    // Print stats every ping interval
    printStats();
  }, PING_INTERVAL_MILLISECONDS);
}

function printStats() {
  console.log("\n" + "=".repeat(60));
  console.log("GEYSER STATISTICS");
  console.log("=".repeat(60));
  console.log(`Total Events: ${eventCounter}`);
  console.log(`Total Account Updates: ${totalAccountUpdates}`);
  console.log("");

  // Futarchy events
  if (futarchyEventCounts.size > 0) {
    console.log("FUTARCHY EVENTS:");
    const sortedFutarchy = Array.from(futarchyEventCounts.entries()).sort((a, b) => b[1] - a[1]);
    for (const [eventName, count] of sortedFutarchy) {
      console.log(`  ${eventName.padEnd(30)} ${count}`);
    }
    console.log("");
  }

  // Launchpad events
  if (launchpadEventCounts.size > 0) {
    console.log("LAUNCHPAD EVENTS:");
    const sortedLaunchpad = Array.from(launchpadEventCounts.entries()).sort((a, b) => b[1] - a[1]);
    for (const [eventName, count] of sortedLaunchpad) {
      console.log(`  ${eventName.padEnd(30)} ${count}`);
    }
    console.log("");
  }

  // Vault events
  if (vaultEventCounts.size > 0) {
    console.log("VAULT EVENTS:");
    const sortedVault = Array.from(vaultEventCounts.entries()).sort((a, b) => b[1] - a[1]);
    for (const [eventName, count] of sortedVault) {
      console.log(`  ${eventName.padEnd(30)} ${count}`);
    }
    console.log("");
  }

  // Account updates
  if (accountUpdateCounts.size > 0) {
    console.log("ACCOUNT UPDATES:");
    const sortedAccounts = Array.from(accountUpdateCounts.entries()).sort((a, b) => b[1] - a[1]);
    for (const [accountType, count] of sortedAccounts) {
      console.log(`  ${accountType.padEnd(30)} ${count}`);
    }
    console.log("");
  }

  console.log("=".repeat(60) + "\n");
}

async function processTransaction(transaction: SubscribeUpdateTransaction) {
    if (!transaction.transaction || !transaction.transaction.meta) {
        return;
    }

    const innerInstructions = transaction.transaction.meta.innerInstructions;

    const signature = bs58.encode(Buffer.from(transaction.transaction.signature));
    console.log("Processing transaction", signature, "at ", new Date().toISOString());

    for (const innerInstruction of innerInstructions) {
        for (const innerInnerInstruction of innerInstruction.instructions) {
            let addresses: Uint8Array[] = [];
            // TODO: throw errors instead of returning
            addresses = addresses.concat(transaction.transaction.transaction?.message?.accountKeys ?? []);
            addresses = addresses.concat(transaction.transaction.meta?.loadedWritableAddresses ?? []);
            addresses = addresses.concat(transaction.transaction.meta?.loadedReadonlyAddresses ?? []);

            assert(innerInnerInstruction.programIdIndex < addresses.length, "programIdIndex is out of bounds");

            const programId = new PublicKey(addresses[innerInnerInstruction.programIdIndex]);

            // Process Futarchy events
            if (programId.equals(FUTARCHY_PROGRAM_ID)) {
                const eventData = anchor.utils.bytes.base64.encode(Buffer.from(innerInnerInstruction.data).slice(8));
                const event = futarchyClient.autocrat.coder.events.decode(eventData);

                if (event) {
                    eventCounter++;
                    const count = (futarchyEventCounts.get(event.name) || 0) + 1;
                    futarchyEventCounts.set(event.name, count);

                    console.log(`\n=== FUTARCHY EVENT #${eventCounter} ===`);
                    console.log("Event Name:", event.name, `(Count: ${count})`);
                    console.log("Signature:", signature);
                    console.log("Slot:", transaction.slot);
                    console.log("Data:", JSON.stringify(serializeForLogging(event.data), null, 2));
                    console.log("========================\n");
                }
            }

            // Process Launchpad events
            if (programId.equals(LAUNCHPAD_PROGRAM_ID)) {
                const eventData = anchor.utils.bytes.base64.encode(Buffer.from(innerInnerInstruction.data).slice(8));
                try {
                    const event = launchpadClient.launchpad.coder.events.decode(eventData);
                    if (event) {
                        eventCounter++;
                        const count = (launchpadEventCounts.get(event.name) || 0) + 1;
                        launchpadEventCounts.set(event.name, count);

                        console.log(`\n=== LAUNCHPAD EVENT #${eventCounter} ===`);
                        console.log("Event Name:", event.name, `(Count: ${count})`);
                        console.log("Signature:", signature);
                        console.log("Slot:", transaction.slot);
                        console.log("Data:", JSON.stringify(serializeForLogging(event.data), null, 2));
                        console.log("========================\n");
                    }
                } catch (error) {
                }
            }

            // Process Vault events
            if (programId.equals(CONDITIONAL_VAULT_PROGRAM_ID)) {
                const eventData = anchor.utils.bytes.base64.encode(Buffer.from(innerInnerInstruction.data).slice(8));
                try {
                    const event = conditionalVaultClient.vaultProgram.coder.events.decode(eventData);
                    if (event) {
                        eventCounter++;
                        const count = (vaultEventCounts.get(event.name) || 0) + 1;
                        vaultEventCounts.set(event.name, count);

                        console.log(`\n=== VAULT EVENT #${eventCounter} ===`);
                        console.log("Event Name:", event.name, `(Count: ${count})`);
                        console.log("Signature:", signature);
                        console.log("Slot:", transaction.slot);
                        console.log("Data:", JSON.stringify(serializeForLogging(event.data), null, 2));
                        console.log("========================\n");
                    }
                } catch (error) {
                }
            }
        }
    }
}

async function processAccountUpdate(accountUpdate: any) {
    totalAccountUpdates++;

    if (!accountUpdate.account) {
        return;
    }

    const account = accountUpdate.account;
    const accountPubkey = bs58.encode(Buffer.from(account.pubkey));
    const owner = new PublicKey(account.owner);
    const slot = accountUpdate.slot;
    const writeVersion = account.writeVersion;

    // Deserialize based on owner
    let accountType = "Unknown";
    let deserializedData: any = null;

    try {
        if (owner.equals(FUTARCHY_PROGRAM_ID)) {
            // Try to deserialize as different Futarchy account types
            try {
                deserializedData = futarchyClient.autocrat.coder.accounts.decode("dao", Buffer.from(account.data));
                accountType = "DAO";
            } catch {
                try {
                    deserializedData = futarchyClient.autocrat.coder.accounts.decode("proposal", Buffer.from(account.data));
                    accountType = "Proposal";
                } catch {
                    try {
                        deserializedData = futarchyClient.autocrat.coder.accounts.decode("stakeAccount", Buffer.from(account.data));
                        accountType = "StakeAccount";
                    } catch {
                        accountType = "Futarchy_Unknown";
                    }
                }
            }
        } else if (owner.equals(LAUNCHPAD_PROGRAM_ID)) {
            // Try to deserialize as Launch or FundingRecord
            try {
                deserializedData = launchpadClient.launchpad.coder.accounts.decode("launch", Buffer.from(account.data));
                accountType = "Launch";
            } catch {
                try {
                    deserializedData = launchpadClient.launchpad.coder.accounts.decode("fundingRecord", Buffer.from(account.data));
                    accountType = "FundingRecord";
                } catch {
                    accountType = "Launchpad_Unknown";
                }
            }
        } else if (owner.equals(CONDITIONAL_VAULT_PROGRAM_ID)) {
            // Try to deserialize as Vault or Question
            try {
                deserializedData = conditionalVaultClient.vaultProgram.coder.accounts.decode("conditionalVault", Buffer.from(account.data));
                accountType = "ConditionalVault";
            } catch {
                try {
                    deserializedData = conditionalVaultClient.vaultProgram.coder.accounts.decode("question", Buffer.from(account.data));
                    accountType = "Question";
                } catch {
                    accountType = "Vault_Unknown";
                }
            }
        }

        // Update counter
        const count = (accountUpdateCounts.get(accountType) || 0) + 1;
        accountUpdateCounts.set(accountType, count);

        // Log account update
        console.log(`\n=== ACCOUNT UPDATE #${totalAccountUpdates} ===`);
        console.log("Account Type:", accountType, `(Count: ${count})`);
        console.log("Account Pubkey:", accountPubkey);
        console.log("Owner:", owner.toString());
        console.log("Slot:", slot);
        console.log("Write Version:", writeVersion);

        if (deserializedData) {
            const serialized = JSON.stringify(serializeForLogging(deserializedData), null, 2);
            console.log("Key Fields:", serialized.slice(0, 1000) + (serialized.length > 1000 ? '...' : ''));
        }

        console.log("===========================\n");

    } catch (error) {
        console.error("Error deserializing account:", error);
    }
}


main();
