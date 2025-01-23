import { db, eq, schema } from "@metadaoproject/indexer-db";
import { OrdersRecord, TakesRecord, TokenRecord, TransactionRecord } from "@metadaoproject/indexer-db/lib/schema";
import { log } from "../../logger/logger";
import { PersistableTransaction } from "./persistableTransaction";


const logger = log.child({
  module: "swap"
});

export class SwapTransaction implements PersistableTransaction {
  protected ordersRecord: OrdersRecord;
  protected takesRecord: TakesRecord;
  protected transactionRecord: TransactionRecord;
  constructor(
    ordersRecord: OrdersRecord,
    takesRecord: TakesRecord,
    transactionRecord: TransactionRecord,    
  ) {
    
    this.ordersRecord = ordersRecord;
    this.takesRecord = takesRecord;
    this.transactionRecord = transactionRecord;
    //this.priceRecord = priceRecord;
  }

  async persist(): Promise<boolean> {
    try {
      // First insert the transaction record
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
        logger.warn(
          `Failed to upsert ${this.transactionRecord.txSig}. ${JSON.stringify(
            this.transactionRecord
          )}`
        );
      }

      // Insert user if they aren't already in the database
      await db.insert(schema.users)
        .values({ userAcct: this.ordersRecord.actorAcct })
        .onConflictDoNothing()
        .returning({ userAcct: schema.users.userAcct });
        

      const orderInsertRes = await db.insert(schema.orders)
        .values(this.ordersRecord)
        .onConflictDoNothing()
        .returning({ txSig: schema.orders.orderTxSig });
        
      if (orderInsertRes.length > 0) {
        console.log( "successfully inserted swap order record", orderInsertRes[0].txSig );
      }
      
      const takeInsertRes = await db.insert(schema.takes)
        .values(this.takesRecord)
        .onConflictDoNothing()
        .returning({ txSig: schema.takes.orderTxSig });
        
      if (takeInsertRes.length > 0) {
        logger.info(`successfully inserted swap take record. ${takeInsertRes[0].txSig}` );
      }
    } catch (e) {
      logger.error(e, `error with persisting swap: ${e}`);
      return false;
    }

    return true;
  }
}
