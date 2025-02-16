import { getTransaction, serialize, SERIALIZED_TRANSACTION_LOGIC_VERSION } from "./serializer";
import { log } from "../../logger/logger";
import { TransactionRecord } from "@metadaoproject/indexer-db/lib/schema";
import { Logs, PublicKey } from "@solana/web3.js";
import { getMainIxTypeFromTransaction } from "./utils";
import { MarketTransaction } from "./marketTransaction";
import { db, eq, schema } from "@metadaoproject/indexer-db";
import { ErrorTransaction } from "./errorTransaction";
import { BaseTransaction } from "./baseTransaction";
import { createAmmSwapTransaction } from "./ammSwapTransaction";
import { UnprocessedTransaction } from "./unprocessedTransaction";
export const logger = log.child({
  module: "persistable"
});


/*
* This creates a PersistableTransaction from a signature and slot
*
* it can be a swap or a market transaction
*/
export async function ptFromSignatureAndSlot(signature: string, slot:number, logs: Logs|undefined=undefined, reprocess: boolean): Promise<BaseTransaction | null > {

  try {

    if (!reprocess) {
      //first lets see if we have this in the db
      const dbTx = await db.select({ txSig: schema.transactions.txSig })
        .from(schema.transactions)
        .where(eq(schema.transactions.txSig, signature))
        .execute();
    
      if (dbTx.length > 0) {
        logger.info(`${signature} already in db`);
        return null;
      }
    }

    const result = await getTransaction(signature);
    if (!result) {
      if (logs && logs.err) {
        return new ErrorTransaction({
          txSig: signature,
          slot: slot.toString(),
          blockTime: new Date(),
          failed: true,
          payload: logs.logs.join("\n"),
          serializerLogicVersion: SERIALIZED_TRANSACTION_LOGIC_VERSION,
        }, reprocess);
      }
      logger.error(signature, "no tx for signature");
      const unprocessedTransaction: UnprocessedTransaction = new UnprocessedTransaction({
        txSig: signature,
        slot: slot.toString(),
        blockTime: new Date(),
        failed: false,
        payload: "",
        serializerLogicVersion: SERIALIZED_TRANSACTION_LOGIC_VERSION,
      }, reprocess);
      
      return unprocessedTransaction;
    }
    const {tx, rawTx} = result;

    //everything saves a tx record from this point on
    const blockTime = new Date(tx.blockTime * 1000);
    const transactionRecord: TransactionRecord = {
      txSig: signature,
      slot: slot.toString(),
      blockTime: blockTime,
      failed: tx.err !== undefined,
      payload: serialize(tx),
      serializerLogicVersion: SERIALIZED_TRANSACTION_LOGIC_VERSION,
      mainIxType: getMainIxTypeFromTransaction(tx),
    };

    if (tx.err) {
      //return an error tx so we save it but stop further processing
      const errorTransaction = new ErrorTransaction(transactionRecord, reprocess);
      return errorTransaction;
    }

    const swapIx = tx.instructions.find((ix) => ix.name === "swap");
    if (swapIx) {
      return createAmmSwapTransaction(tx, swapIx, signature, blockTime, transactionRecord, rawTx, reprocess);
    } else {
      // handle non-swap transactions (add/remove liquidity, crank, etc)
      // find market account from instructions
      
      let marketAccts: PublicKey[] = [];
      for (const ix of tx.instructions) {
        const candidate = ix.accountsWithData.find((a) => a.name === "amm");
        if (candidate) {
          const marketAcct = new PublicKey(candidate.pubkey);
          marketAccts.push(marketAcct);
        }
      }
      
      if (marketAccts.length > 0) {
        const marketTransaction = new MarketTransaction(marketAccts, transactionRecord, reprocess);
        return marketTransaction;
      } else {
        logger.info(signature,"no market account found for non swap txn");
      }

    }
    //logger.info("no swap found for txn", signature);
    return new UnprocessedTransaction(transactionRecord, reprocess);

  } catch (e: any) {
    console.log(e);
    logger.error(e);
    return new UnprocessedTransaction({
      txSig: signature,
      slot: slot.toString(),
      blockTime: new Date(),
      failed: false,
      payload: "",
      serializerLogicVersion: SERIALIZED_TRANSACTION_LOGIC_VERSION,
    }, reprocess);
  }
}

