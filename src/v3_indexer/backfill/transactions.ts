import { ConfirmedSignatureInfo, PublicKey } from "@solana/web3.js";
import { log } from "../../logger/logger";
import pLimit from "p-limit";
import { connection } from "../connection";
import { ptFromSignatureAndSlot } from "../transaction/persistableTransaction";
import { db, eq, schema } from "@metadaoproject/indexer-db";


const AMM_KEY = new PublicKey("AMM5G2nxuKUwCLRYTW7qqEwuoqCtNSjtbipwEmm2g8bH");

const logger = log.child({
  module: "backfill-transactions"
});

const limit = pLimit(20);

export async function backfillTransactions(): Promise<{message:string, error: Error|undefined}> {

  const startTime = performance.now()

  const hist = await getTransactionHistory(AMM_KEY);
  await processTransactions(hist);

  const endTime = performance.now()
  const message = `Backfilling ${hist.length} transactions complete - took ${(endTime - startTime) / 1000} seconds`;
  logger.info(message);

  return {message: message, error: undefined};
}

async function processTransactions(transactions: ConfirmedSignatureInfo[]) {
  const currentSlot = await connection.getSlot();

  const tasks = transactions.map(tx => limit(() => processTx(tx)));
  await Promise.all(tasks);
}

async function processTx(tx: ConfirmedSignatureInfo) {
  const pt = await ptFromSignatureAndSlot(tx.signature, tx.slot);
  if (pt) {
    const res = await pt.persist();
    if (!res) {
      logger.error(tx, "failed to persist pt");
    } else {
      //logger.info(tx, "successfully persisted pt");

      try {
        //save that we have checked up to this slot
        await db.update(schema.transactionWatchers).set({
          latestTxSig: tx.signature,          
          checkedUpToSlot: tx.slot.toString()
        }).where(eq(schema.transactionWatchers.acct, AMM_KEY.toString()));
      } catch (e) {
        logger.error(e, "Error updating the transaction watcher");
      }
    }
  }


}

/**
 * TODO CLEAN THIS UP
 * @param account 
 * @param range 
 * @returns 
 */
async function getTransactionHistory(account: PublicKey, after?: string): Promise<ConfirmedSignatureInfo[]> {
  
  const history: ConfirmedSignatureInfo[] = [];

  let earliestSig: string | undefined;
  let latestSig: string | undefined;
  
  //grab the latest transaction
  const latestTx = await db.select().from(schema.transactionWatchers).where(eq(schema.transactionWatchers.acct, account.toString()));
  if (latestTx.length > 0 && latestTx[0].latestTxSig) {
    latestSig = latestTx[0].latestTxSig;
  }

  let page = 1;

  //we walk backwards, starting at the latest transaction
  //each loop, earliestSig gets updated until we hit after or run out of transactions
  while (true) {
    // The Solana RPC tx API has us do a backwards walk
    const transactions = await connection.getSignaturesForAddress(account, { before: earliestSig }, "confirmed");
    if (transactions.length === 0) {
      break;
    }
    
    let reachedLatest = false;
    for (let i = 0; i < transactions.length; ++i) {
      const cur = transactions[i];

      if (cur.signature === latestSig) {
        reachedLatest = true;
        break;
      }

      history.push(cur);
      earliestSig = cur.signature;
    }

    logger.info(`page ${page} for ${account.toBase58()} (${history.length} total)`);
    page++;
    if (reachedLatest) {
      break;
    }
  }

  history.reverse(); // Now earliest transaction comes first.

  return history;
}