import { CONDITIONAL_VAULT_PROGRAM_ID, LAUNCHPAD_PROGRAM_ID, FUTARCHY_PROGRAM_ID } from "@metadaoproject/futarchy/v0.6";
import * as anchor from "@coral-xyz/anchor";
import { CompiledInnerInstruction, PublicKey, TransactionResponse, VersionedTransactionResponse, Context, Logs, } from "@solana/web3.js";

import { schema, db } from "@metadaoproject/indexer-db";
import { connection, conditionalVaultClient, launchpadClient, futarchyClient } from "./connection";

import { log } from "../logger/logger";

import { 
  processFutarchyEvent, 
  processLaunchpadEvent, 
  //processVaultEvent 
  } from "./processor";

const logger = log.child({
  module: "v6_indexer"
});
type DBConnection = any; // TODO: Fix typing..

const parseEvents = (transactionResponse: VersionedTransactionResponse | TransactionResponse): { futarchyEvents: any, vaultEvents: any, launchpadEvents: any } => {
  const futarchyEvents: { name: string; data: any }[] = [];
  const vaultEvents: { name: string; data: any }[] = [];
  const launchpadEvents: { name: string; data: any }[] = [];

  try {
    const inner: CompiledInnerInstruction[] =
      transactionResponse?.meta?.innerInstructions ?? [];
    const futarchyIdlProgramId = futarchyClient.autocrat.programId;
    const vaultIdlProgramId = conditionalVaultClient.vaultProgram.programId;
    const launchpadIdlProgramId = launchpadClient.launchpad.programId;

    for (let i = 0; i < inner.length; i++) {
      for (let j = 0; j < inner[i].instructions.length; j++) {
        const ix = inner[i].instructions[j];
        const programPubkey =
          transactionResponse?.transaction.message.staticAccountKeys[
          ix.programIdIndex
          ];
        if (!programPubkey) {
          logger.debug("No program pubkey");
          continue;
        }

        // get which program the instruction belongs to
        let program: any;
        
        if (programPubkey.equals(futarchyIdlProgramId)) {
          program = futarchyClient.autocrat;
          const ixData = anchor.utils.bytes.bs58.decode(
            ix.data
          );
          const eventData = anchor.utils.bytes.base64.encode(ixData.slice(8));
          try {
            const event = program.coder.events.decode(eventData);
            if (event) {
              futarchyEvents.push(event);
            }
          } catch (decodeError) {
            logger.warn(`Failed to decode futarchy event: ${decodeError instanceof Error ? decodeError.message : 'Unknown error'}`);
          }
        } else if (programPubkey.equals(vaultIdlProgramId)) {
          program = conditionalVaultClient.vaultProgram;
          const ixData = anchor.utils.bytes.bs58.decode(
            ix.data
          );
          const eventData = anchor.utils.bytes.base64.encode(ixData.slice(8));
          try {
            const event = program.coder.events.decode(eventData);
            if (event) {
              vaultEvents.push(event);
            }
          } catch (decodeError) {
            logger.warn(`Failed to decode vault event: ${decodeError instanceof Error ? decodeError.message : 'Unknown error'}`);
          }
        } else if (programPubkey.equals(launchpadIdlProgramId)){
          program = launchpadClient.launchpad;
          const ixData = anchor.utils.bytes.bs58.decode(
            ix.data
          );
          const eventData = anchor.utils.bytes.base64.encode(ixData.slice(8));
          try {
            const event = program.coder.events.decode(eventData);
            if (event) {
              launchpadEvents.push(event);
            }
          } catch (decodeError) {
            logger.warn(`Failed to decode launchpad event: ${decodeError instanceof Error ? decodeError.message : 'Unknown error'}`);
          }
        } 
      }
    }
  } catch (error) {
    logger.error(
      error instanceof Error
        ? `Error parsing events: ${error.message}`
        : "Unknown error parsing events"
    );
  }

  return {
    futarchyEvents,
    vaultEvents,
    launchpadEvents,
  };
}

//indexes signature
export async function index(signature: string, programId: PublicKey) {
  try {
    if (!programId.equals(FUTARCHY_PROGRAM_ID) || !programId.equals(LAUNCHPAD_PROGRAM_ID)) {
      logger.info("Unknown program id: ", programId.toBase58());
      return;
    }

    const transactionResponse = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
    if (!transactionResponse) {
      logger.info("No transaction response");
      return;
    }

    //insert signature to db
    try {
      await db.insert(schema.signatures).values({
          signature: transactionResponse.transaction.signatures[0],
          slot: transactionResponse.slot.toString(),
        didErr: transactionResponse.meta?.err !== null,
        err: transactionResponse.meta?.err ? JSON.stringify(transactionResponse.meta.err) : null,
        blockTime: transactionResponse.blockTime ? new Date(transactionResponse.blockTime * 1000) : null,
    }).onConflictDoNothing().execute();
    
    await db.insert(schema.signature_accounts).values({
      signature: transactionResponse.transaction.signatures[0],
        account: programId.toString()
      }).onConflictDoNothing().execute();
    } catch (e) {
      logger.warn(e, "Error inserting the signatures");
    }

    if (transactionResponse.meta?.err) {
      logger.info(transactionResponse.meta.err, `Error in transaction ${signature}, skipping indexing.`);
      return;
    }

    const events = parseEvents(transactionResponse);
    
    const { futarchyEvents, vaultEvents, launchpadEvents  } = events;

    Promise.all(futarchyEvents.map(async (event: any) => {
      await processFutarchyEvent(event, signature, transactionResponse);
    }));

    // Promise.all(vaultEvents.map(async (event: any) => {
    //   await processVaultEvent(event, signature, transactionResponse);
    // }));

    Promise.all(launchpadEvents.map(async (event: any) => {
      await processLaunchpadEvent(event, signature, transactionResponse);
    }));
  } catch (error) {
    logger.error(
      error instanceof Error
        ? `Error processing signature: ${error.message}`
        : "Unknown error processing signature"
    );
  }
}

//indexes signature from logs
export async function v6IndexFromLogs(logs: Logs, ctx: Context, programId: PublicKey) {
  try {
    let signature = logs.signature;
    if (!signature) {
      logger.error( new Error("No signature found in logs"));
      return;
    }
    await index(signature, programId);
  } catch (error) {
    logger.error(
      error instanceof Error
        ? `Error processing signature: ${error.message}`
        : "Unknown error processing signature"
    );
  }
}

