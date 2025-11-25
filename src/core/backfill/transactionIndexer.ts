import { Connection, PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { db, schema } from "@metadaoproject/indexer-db";
import { log } from "../../logger/logger";
import { ProgramIndexer, getProgramByOwner } from "../registry";

const logger = log.child({ module: "transactionIndexer" });

/**
 * Fetch and index a transaction by signature
 * Uses the registry to find the correct indexer for each program in the transaction
 */
export async function indexTransaction(
  signature: string,
  indexer: ProgramIndexer,
  connection: Connection
): Promise<void> {
  try {
    const transactionResponse = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 1
    });

    if (!transactionResponse) {
      logger.debug({ signature }, "No transaction response");
      return;
    }

    // Insert signature to DB
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
        account: indexer.programId.toString()
      }).onConflictDoNothing().execute();
    } catch (e) {
      logger.warn(e, "Error inserting signature");
    }

    // Skip if transaction had an error
    if (transactionResponse.meta?.err) {
      logger.debug({ signature, error: transactionResponse.meta.err }, "Transaction had error, skipping");
      return;
    }

    // Parse and process events
    await parseAndProcessEvents(transactionResponse, signature, indexer);
  } catch (error) {
    logger.error({ error, signature }, "Error indexing transaction");
  }
}

/**
 * Parse events from a transaction and process them through the appropriate indexer
 */
async function parseAndProcessEvents(
  transactionResponse: VersionedTransactionResponse,
  signature: string,
  primaryIndexer: ProgramIndexer
): Promise<void> {
  const innerInstructions = transactionResponse.meta?.innerInstructions ?? [];

  for (const innerInstruction of innerInstructions) {
    for (const ix of innerInstruction.instructions) {
      // Get the program ID for this instruction
      const accountKeys = transactionResponse.transaction.message.staticAccountKeys;
      if (ix.programIdIndex >= accountKeys.length) {
        continue;
      }
      const programId = accountKeys[ix.programIdIndex];

      // Find the indexer for this program
      const indexer = getProgramByOwner(programId);
      if (!indexer) {
        continue;
      }

      // Try to decode as an event
      try {
        const ixData = anchor.utils.bytes.bs58.decode(ix.data);
        const eventData = Buffer.from(ixData.slice(8));
        const event = indexer.decodeEvent(eventData);

        if (event) {
          logger.debug({
            signature,
            program: indexer.name,
            eventName: event.name
          }, "Processing event from backfill");

          await indexer.processEvent(event, signature, transactionResponse as any);
        }
      } catch (decodeError) {
        // Not all instructions are events, this is expected
        logger.trace({ error: decodeError }, "Failed to decode instruction as event");
      }
    }
  }
}

/**
 * Index a transaction from RPC logs (for real-time processing via RPC fallback)
 * This is used when Geyser is unavailable
 */
export async function indexFromLogs(
  signature: string,
  logs: string[],
  indexer: ProgramIndexer,
  connection: Connection
): Promise<void> {
  // For now, just delegate to the full transaction indexing
  // In the future, we could optimize by filtering based on logs
  await indexTransaction(signature, indexer, connection);
}
