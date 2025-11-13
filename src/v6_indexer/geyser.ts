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
  FutarchyClient,
  FutarchyEvent,
 } from "@metadaoproject/futarchy/v0.6";
 import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
 import * as anchor from "@coral-xyz/anchor";
import { processFutarchyEvent } from "./processor";
import { insertSignatures } from "./filler";

import { connection, provider, futarchyClient } from "./connection";

const GRPC_TOKEN = process.env.GRPC_TOKEN;

if (!GRPC_TOKEN) {
  throw new Error("GRPC_TOKEN is not set");
}

async function main() {
  const client = new Client(
    `${connection.rpcEndpoint}:443`,
    GRPC_TOKEN,
    undefined,
  );
  client.ping(1);
  const version = await client.getVersion(); 
  console.log(version);

  const stream = await client.subscribe();

  const request: SubscribeRequest = {
    transactions: {
      metadao_programs: {
        // accountInclude: ["9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump"],
        accountInclude: [FUTARCHY_PROGRAM_ID.toString()],
        accountExclude: [],
        accountRequired: [],
      },
    },
    slots: {},
    accounts: {},
    blocks: {},
    blocksMeta: {},
    accountsDataSlice: [],
    commitment: CommitmentLevel.CONFIRMED,
    entry: {},
    transactionsStatus: {},
  };

  stream.write(request);

  stream.on("data", async (data: SubscribeUpdate) => {
    if (!data.filters.includes("metadao_programs")) {
        return;
    }

    if (data.transaction) {
        try {
            await processTransaction(data.transaction);
        } catch (error) {
            console.error(error);
        }
    }
  });
}

async function processTransaction(transaction: SubscribeUpdateTransaction) {
    const innerInstructions = transaction.transaction.meta.innerInstructions;

    if (!transaction.transaction) {
        return;
    }

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

                const eventData = anchor.utils.bytes.base64.encode(Buffer.from(innerInnerInstruction.data).slice(8));
                // console.log(eventData);

                const event = futarchyClient.autocrat.coder.events.decode(eventData);
                console.log(event);

                if (event) {
                    console.log("Inserting signature", signature);
                    await insertSignatures([{ signature, slot: Number(transaction.slot), blockTime: null, memo: null, err: null }], FUTARCHY_PROGRAM_ID);
                    console.log("Signature inserted");
                    await processFutarchyEvent({ name: event.name, data: event.data as FutarchyEvent }, signature, transaction.transaction as VersionedTransactionResponse);
                }
            }
        }
    }
}


main();
