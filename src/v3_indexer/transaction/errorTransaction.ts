import { db, eq, schema } from "@metadaoproject/indexer-db";
import { OrdersRecord, TakesRecord, TokenRecord, TransactionRecord } from "@metadaoproject/indexer-db/lib/schema";
import { log } from "../../logger/logger";
import { BaseTransaction } from "./baseTransaction";


const logger = log.child({
  module: "swap"
});


//this is just an error transaction.  It just saves the transaction record and stops further processing
//it only exists to have persistable be abstract.
export class ErrorTransaction extends BaseTransaction {
  constructor( transactionRecord: TransactionRecord, reprocess: boolean) {
    super(transactionRecord, reprocess);
  }

  async persist(): Promise<boolean> {

    if (this.reprocess) {
      //we dont want to mess up prices for reprocessed txns
      return true;
    }

     //save the transaction record first
    return this.saveRecord();
  }
}
