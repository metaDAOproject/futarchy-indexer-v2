import { db, DBTransaction } from "@metadaoproject/indexer-db";
import type { VersionedTransactionResponse } from "@solana/web3.js";
import { log } from "../../logger/logger";

const logger = log.child({ module: "event-handler" });

/**
 * Wraps an event handler with transaction and error handling boilerplate.
 * Use this for event handlers that need database transactions.
 *
 * @example
 * export const processMyEvent = withEventHandler("MyEvent", async (event, sig, tx, trx) => {
 *   await trx.insert(schema.my_table).values({ ... });
 * });
 */
export function withEventHandler<T>(
  name: string,
  handler: (
    event: T,
    signature: string,
    txResponse: VersionedTransactionResponse,
    trx: DBTransaction
  ) => Promise<void>
) {
  return async (
    event: { name: string; data: T },
    signature: string,
    txResponse: VersionedTransactionResponse
  ): Promise<void> => {
    try {
      await db.transaction(async (trx) => {
        await handler(event.data, signature, txResponse, trx);
      });
    } catch (error) {
      logger.error({ error, signature, event: name }, `Error handling ${name}`);
    }
  };
}

/**
 * Wraps an event handler without transaction wrapping.
 * Use this when you need custom transaction control or no transaction.
 *
 * @example
 * export const processMyEvent = withEventHandlerNoTx("MyEvent", async (event, sig, tx) => {
 *   // Handle without automatic transaction
 * });
 */
export function withEventHandlerNoTx<T>(
  name: string,
  handler: (
    event: T,
    signature: string,
    txResponse: VersionedTransactionResponse
  ) => Promise<void>
) {
  return async (
    event: { name: string; data: T },
    signature: string,
    txResponse: VersionedTransactionResponse
  ): Promise<void> => {
    try {
      await handler(event.data, signature, txResponse);
    } catch (error) {
      logger.error({ error, signature, event: name }, `Error handling ${name}`);
    }
  };
}
