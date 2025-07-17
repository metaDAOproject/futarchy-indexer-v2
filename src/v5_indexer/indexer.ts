import { AMM_PROGRAM_ID, CONDITIONAL_VAULT_PROGRAM_ID, LAUNCHPAD_PROGRAM_ID, AUTOCRAT_PROGRAM_ID } from "@metadaoproject/futarchy/v0.5";
import * as anchor from "@coral-xyz/anchor";
import { CompiledInnerInstruction, PublicKey, TransactionResponse, VersionedTransactionResponse, Context, Logs, } from "@solana/web3.js";

import { schema, db } from "@metadaoproject/indexer-db";
import { connection, ammClient, conditionalVaultClient, launchpadClient, autocratClient } from "./connection";

import { log } from "../logger/logger";

import { processAmmEvent, processAutocratEvent, processLaunchpadEvent, processVaultEvent } from "./processor";

const logger = log.child({
  module: "v5_indexer"
});
type DBConnection = any; // TODO: Fix typing..

const parseEvents = (transactionResponse: VersionedTransactionResponse | TransactionResponse): { ammEvents: any, vaultEvents: any, launchpadEvents: any, autocratEvents: any } => {
  const ammEvents: { name: string; data: any }[] = [];
  const vaultEvents: { name: string; data: any }[] = [];
  const launchpadEvents: { name: string; data: any }[] = [];
  const autocratEvents: { name: string; data: any }[] = [];

  try {
    const inner: CompiledInnerInstruction[] =
      transactionResponse?.meta?.innerInstructions ?? [];
    const ammIdlProgramId = ammClient.program.programId;
    const vaultIdlProgramId = conditionalVaultClient.vaultProgram.programId;
    const launchpadIdlProgramId = launchpadClient.launchpad.programId;
    const autocratIdlProgramId = autocratClient.autocrat.programId;

    for (let i = 0; i < inner.length; i++) {
      for (let j = 0; j < inner[i].instructions.length; j++) {
        const ix = inner[i].instructions[j];
        const programPubkey =
          transactionResponse?.transaction.message.staticAccountKeys[
          ix.programIdIndex
          ];
        if (!programPubkey) {
          logger.info("No program pubkey");
          continue;
        }

        // get which program the instruction belongs to
        let program: any;
        
        if (programPubkey.equals(ammIdlProgramId)) {
          program = ammClient.program;
          const ixData = anchor.utils.bytes.bs58.decode(
            ix.data
          );
          const eventData = anchor.utils.bytes.base64.encode(ixData.slice(8));
          const event = program.coder.events.decode(eventData);
          
          if (event) {
            ammEvents.push(event);
          }
        } else if (programPubkey.equals(vaultIdlProgramId)) {
          program = conditionalVaultClient.vaultProgram;
          const ixData = anchor.utils.bytes.bs58.decode(
            ix.data
          );
          const eventData = anchor.utils.bytes.base64.encode(ixData.slice(8));
          const event = program.coder.events.decode(eventData);
          
          if (event) {
            vaultEvents.push(event);
          }
        } else if (programPubkey.equals(launchpadIdlProgramId)){
          program = launchpadClient.launchpad;
          const ixData = anchor.utils.bytes.bs58.decode(
            ix.data
          );
          const eventData = anchor.utils.bytes.base64.encode(ixData.slice(8));
          const event = program.coder.events.decode(eventData);
          
          if (event) {
            launchpadEvents.push(event);
          }
        } else if (programPubkey.equals(autocratIdlProgramId)) {
          program = autocratClient.autocrat;
          const ixData = anchor.utils.bytes.bs58.decode(
            ix.data
          );
          const eventData = anchor.utils.bytes.base64.encode(ixData.slice(8));
          const event = program.coder.events.decode(eventData);

          if (event) {
            autocratEvents.push(event);
          }
        } else {
          logger.info(`Unknown program pubkey  ${programPubkey.toBase58()}`);
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
    ammEvents,
    vaultEvents,
    launchpadEvents,
    autocratEvents
  };
}

//indexes signature
export async function index(signature: string, programId: PublicKey) {
  try {
    if (!programId.equals(AMM_PROGRAM_ID) && !programId.equals(CONDITIONAL_VAULT_PROGRAM_ID) && !programId.equals(LAUNCHPAD_PROGRAM_ID) && !programId.equals(AUTOCRAT_PROGRAM_ID)) {
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
    
    const { ammEvents, vaultEvents, launchpadEvents, autocratEvents } = events;

    Promise.all(ammEvents.map(async (event: any) => {
      await processAmmEvent(event, signature, transactionResponse);
    }));

    Promise.all(vaultEvents.map(async (event: any) => {
      await processVaultEvent(event, signature, transactionResponse);
    }));

    Promise.all(launchpadEvents.map(async (event: any) => {
      await processLaunchpadEvent(event, signature, transactionResponse);
    }));

    Promise.all(autocratEvents.map(async (event: any) => {
      await processAutocratEvent(event, signature, transactionResponse);
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
export async function v5IndexFromLogs(logs: Logs, ctx: Context, programId: PublicKey) {
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

