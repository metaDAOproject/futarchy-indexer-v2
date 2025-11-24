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

import { connection, provider, futarchyClient } from "./connection";

let eventCounter = 0;

async function main() {
  const GRPC_TOKEN = process.env.GRPC_TOKEN;
  const GRPC_ENDPOINT = process.env.RPC_ENDPOINT;

  if (!GRPC_TOKEN) {
    throw new Error("GRPC_TOKEN is not set");
  }

  if (!GRPC_ENDPOINT) {
    throw new Error("GRPC_ENDPOINT is not set");
  }

  const client = new Client(
    GRPC_ENDPOINT,
    GRPC_TOKEN,
    {},
  );
  
  client.ping(1);
  console.log("Client created");

  console.log("Getting version...");
  const version = await client.getVersion();
  console.log("Connected to Yellowstone gRPC:", version);

  // Create subscription stream
  console.log("Creating subscription stream...");
  const stream = await client.subscribe();
  console.log("Stream created");

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

    // Process accounts
    // if (data.account) {
    //   console.log("\n=== ACCOUNT UPDATE ===");
    //   console.log(JSON.stringify(data.account.account?.data, null, 2));
    //   console.log("======================\n");
    // }
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
          // LAUNCHPAD_PROGRAM_ID.toString(),
          // CONDITIONAL_VAULT_PROGRAM_ID.toString(),
        ],
        accountExclude: [],
        accountRequired: [],
        failed: false,
      },
    },
    accounts: {},
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

  console.log("Subscribed to Futarchy program:", FUTARCHY_PROGRAM_ID.toString());

  // Ping keepalive to prevent idle stream closure
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
  }, PING_INTERVAL_MILLISECONDS);
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
            let addresses: Uint8Array<ArrayBufferLike>[] = [];
            // TODO: throw errors instead of returning
            addresses = addresses.concat(transaction.transaction.transaction?.message?.accountKeys ?? []);
            addresses = addresses.concat(transaction.transaction.meta?.loadedWritableAddresses ?? []);
            addresses = addresses.concat(transaction.transaction.meta?.loadedReadonlyAddresses ?? []);

            assert(innerInnerInstruction.programIdIndex < addresses.length, "programIdIndex is out of bounds");

            const programId = new PublicKey(addresses[innerInnerInstruction.programIdIndex]);

            if (programId.equals(FUTARCHY_PROGRAM_ID)) {
                // console.log(innerInnerInstruction.data);

                // TODO: check the discriminator for security purposes in case someone figures out how to inject data

                const eventData = anchor.utils.bytes.base64.encode(Buffer.from(innerInnerInstruction.data).subarray(8));
                // console.log(eventData);

                const event = futarchyClient.autocrat.coder.events.decode(eventData);

                if (event) {
                    eventCounter++;
                    console.log(`\n=== FUTARCHY EVENT #${eventCounter} ===`);
                    console.log("Event Name:", event.name);
                    console.log("Signature:", signature);
                    console.log("Slot:", transaction.slot);
                    console.log("Data:", event.data);
                    console.log("========================\n");
                }

                // if (event) {
                //     console.log("Inserting signature", signature);
                //     await insertSignatures([{ signature, slot: Number(transaction.slot), blockTime: null, memo: null, err: null }], FUTARCHY_PROGRAM_ID);
                //     console.log("Signature inserted");
                //     await processFutarchyEvent({ name: event.name, data: event.data as FutarchyEvent }, signature, transaction.transaction as VersionedTransactionResponse);
                // }
            }
        }
    }
}


main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
