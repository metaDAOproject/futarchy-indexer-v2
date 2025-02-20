import { db, schema, eq } from "@metadaoproject/indexer-db";
import { TransactionRecord } from "@metadaoproject/indexer-db/lib/schema";
import { log } from "../../logger/logger";

const logger = log.child({
  module: "baseTransaction"
});

export abstract class BaseTransaction { 
  abstract persist(): Promise<boolean>;
  protected transactionRecord: TransactionRecord;
  protected reprocess: boolean;

  constructor(transactionRecord: TransactionRecord, reprocess: boolean) {
    this.transactionRecord = transactionRecord;
    this.reprocess = reprocess;
  }

  async saveRecord(): Promise<boolean> {
    // First insert the transaction record
    if (this.reprocess) {
      //we dont want to mess up prices for reprocessed txns
      try{
        await db.insert(schema.transactions)
          .values(this.transactionRecord)
          .onConflictDoNothing();
        return true;
      } catch (e) {
        logger.warn(e, `error saving transaction record ${this.transactionRecord.txSig}`);
        return false;
      }
    }

    try {
      const upsertResult = await db.insert(schema.transactions)
        .values(this.transactionRecord)
      .onConflictDoUpdate({
        target: schema.transactions.txSig,
        set: this.transactionRecord,
      })
      .returning({ txSig: schema.transactions.txSig });
      
      if (
        upsertResult.length !== 1 ||
        upsertResult[0].txSig !== this.transactionRecord.txSig
      ) {
        logger.warn(`Failed to upsert ${this.transactionRecord.txSig}. ${JSON.stringify(this.transactionRecord)}`);
      }

      //remove the transaction record from the unprocessed table
      await db.$client.query(
        `DELETE FROM unprocessed_transactions WHERE tx_sig = $1`,
        [this.transactionRecord.txSig]
      );
    } catch (e) {
      logger.warn(e, `error saving transaction record ${this.transactionRecord.txSig}`);
      return false;
    }
    return true;
  }
}