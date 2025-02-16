import { db } from "@metadaoproject/indexer-db";
import { TransactionRecord } from "@metadaoproject/indexer-db/lib/schema";
import { log } from "../../logger/logger";
import { BaseTransaction } from "./baseTransaction";


const logger = log.child({
  module: "unprocessed Transaction"
});


//this is just an error transaction.  It just saves the transaction record and stops further processing
//it only exists to have persistable be abstract.
export class UnprocessedTransaction extends BaseTransaction {
  constructor( transactionRecord: TransactionRecord, reprocess: boolean) {
    super(transactionRecord, reprocess);
  }

  async persist(): Promise<boolean> {

     //save the transaction record first
    this.saveRecord();
    if (this.transactionRecord.mainIxType === "vault_mint_conditional_tokens") {
      //we dont need to save these, they are normal transactions
      return true;
    }

    try {
      const text = `INSERT INTO unprocessed_transactions (tx_sig) values($1) ON CONFLICT (tx_sig) DO NOTHING`;
     await db.$client.query(text, [this.transactionRecord.txSig]);
    } catch (e) {
      logger.warn(e, `error saving transaction record ${this.transactionRecord.txSig}`);
      return false;
    }
    return true;
  }
}
