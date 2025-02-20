import { BaseTransaction } from "./baseTransaction";
import { PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
import { Instruction } from "@coral-xyz/anchor";
import { OrderSide, OrdersRecord, TakesRecord, TransactionRecord } from "@metadaoproject/indexer-db/lib/schema";
import { Transaction } from "./serializer";
import { MessageAccountKeys } from "@solana/web3.js";
import { db, eq, schema } from "@metadaoproject/indexer-db";
import { log } from "../../logger/logger";

import { connection } from "../connection";
import { MarketTransaction } from "./marketTransaction";

const logger = log.child({
  module: "arbTransaction"
});

export async function createAmmSwapTransaction(
  tx: Transaction,
  swapIx: Instruction,
  signature: string,
  blockTime: Date,
  transactionRecord: TransactionRecord,
  rawTx: VersionedTransactionResponse,
  reprocess: boolean
): Promise<BaseTransaction | null> {

  const ts = tx.blockTime;
  const slot = tx.slot;
  let now = new Date();
  if (blockTime) {
    now = blockTime;
  }

  const actor = tx.accounts[0];
  const writableAddresses = rawTx.meta?.loadedAddresses?.writable ?? [];
  const preTokenBalances = rawTx.meta?.preTokenBalances ?? [];
  const postTokenBalances = rawTx.meta?.postTokenBalances ?? [];

  //using a map to remove duplicates
  //between writable and accounts
  const addressMap = new Map<string, boolean>();

  // Add account keys
  tx.accounts.forEach(acct => {
    if (acct) {
      addressMap.set(acct.pubkey, true);
    }
  });

  // Add writable addresses
  //i think this is redundant
  //but there may be an edge case
  //where it's not
  writableAddresses.forEach(acct => {
    addressMap.set(acct.toBase58(), true);
  });

  //we now have just the unique addresses
  const allAddresses = Array.from(addressMap.keys());

  //get all of our known markets
  const dbMarkets = await getMarketTokensFromDb();

  const orders: OrdersRecord[] = [];
  const takes: TakesRecord[] = [];
  const marketAccts: PublicKey[] = [];

  for (const marketAcct of allAddresses) {

    let preBaseBalance = BigInt(0);
    let preQuoteBalance = BigInt(0);
    let baseDecimals = BigInt(0);
    let quoteDecimals = BigInt(0);

    let postBaseBalance = BigInt(0);
    let postQuoteBalance = BigInt(0);

    /*
    * We calculate balance changes
    * by looking at the pre and post token balances
    * and comparing them using our known mint addresses
    * 
    * This lets us know the trade
    */
    for (const preTokenBalance of preTokenBalances) {
      //fisrt are we dealing with the right account
      if (preTokenBalance.owner === marketAcct) {
        //now we need to see if this is a base or quote token
        if (preTokenBalance.mint === dbMarkets.get(marketAcct)?.baseToken) {
          preBaseBalance = BigInt(preTokenBalance.uiTokenAmount.amount);
          baseDecimals = BigInt(preTokenBalance.uiTokenAmount.decimals);
        } else if (preTokenBalance.mint === dbMarkets.get(marketAcct)?.quoteToken) {
          preQuoteBalance = BigInt(preTokenBalance.uiTokenAmount.amount);
          quoteDecimals = BigInt(preTokenBalance.uiTokenAmount.decimals);
        }
      }
    }
    for (const postTokenBalance of postTokenBalances) {
      //fisrt are we dealing with the right account 
      if (postTokenBalance.owner === marketAcct) {
        //now we need to see if this is a base or quote token
        if (postTokenBalance.mint === dbMarkets.get(marketAcct)?.baseToken) {
          postBaseBalance = BigInt(postTokenBalance.uiTokenAmount.amount);
        } else if (postTokenBalance.mint === dbMarkets.get(marketAcct)?.quoteToken) {
          postQuoteBalance = BigInt(postTokenBalance.uiTokenAmount.amount);
        }
      }
    }

    // this is a sanity check but also is wrong
    // as if all balances were taken out (or it was empty before) 
    // this would bail.  This should really not happen though
    if (preBaseBalance === BigInt(0) || preQuoteBalance === BigInt(0) || postBaseBalance === BigInt(0) || postQuoteBalance === BigInt(0)) {
      //we dont have any balances
      if (preBaseBalance != BigInt(0) || preQuoteBalance != BigInt(0) || postBaseBalance != BigInt(0) || postQuoteBalance != BigInt(0)) {
        //we should not run into this scenario where one is 0 and the other is not
        //so if we do, this may need to be investigated
        logger.error("no balance found for market", marketAcct);
        logger.info(`preBaseBalance  ${preBaseBalance}`);
        logger.info(`preQuoteBalance ${preQuoteBalance}`);
        logger.info(`postBaseBalance ${postBaseBalance}`);
        logger.info(`postQuoteBalance ${postQuoteBalance}`);
      }
      continue;
    }

    try {
      //we now have the data for a trade, so lets make one
      const isBid = postBaseBalance < preBaseBalance;
      const baseAmount = preBaseBalance > postBaseBalance ? preBaseBalance - postBaseBalance : postBaseBalance - preBaseBalance;
      const quoteAmount = preQuoteBalance > postQuoteBalance ? preQuoteBalance - postQuoteBalance : postQuoteBalance - preQuoteBalance;
      const humanBaseAmount = Number(baseAmount) / Math.pow(10, Number(baseDecimals));
      const humanQuoteAmount = Number(quoteAmount) / Math.pow(10, Number(quoteDecimals));

      //this is the price that the AMM internally calculated, it does not include fees
      let price = Number(humanQuoteAmount) / Number(humanBaseAmount);
      if (!isFinite(price)) {
        price = 0;
      }

      let baseFee = BigInt(0);
      let quoteFee = BigInt(0);

      const feeAdjust = process.env.FEE_ADJUST ? Number(process.env.FEE_ADJUST) : 0.01;

      //figure out our fees
      //NOTE: this is rounded ----- should it be floored? -------
      if (isBid) {
        //The fee comes off the input quote amount
        quoteFee = quoteAmount * BigInt(Math.round(feeAdjust * 100)) / 100n;
      } else {
        //The fee comes off the input base amount
        baseFee = baseAmount * BigInt(Math.round(feeAdjust * 100)) / 100n;
      }

      if (process.env.DEPLOY_ENVIRONMENT == "DEVELOPMENT") {
        console.log("--------------------------------");
        console.log("marketAcct", marketAcct);
        console.log("baseAmount", baseAmount);
        console.log("quoteAmount", quoteAmount);
        console.log("humanBaseAmount", humanBaseAmount);
        console.log("humanQuoteAmount", humanQuoteAmount);
        console.log("price", price);
        console.log("isBid", isBid);
        console.log("baseAmount", baseAmount);
        console.log("quoteAmount", quoteAmount);
        console.log("baseFee", baseFee);
        console.log("quoteFee", quoteFee);
        console.log("--------------------------------");
      }

      const swapOrder: OrdersRecord = {
        marketAcct: marketAcct,
        orderBlock: tx.slot.toString(),
        orderTime: now,
        orderTxSig: signature,
        quotePrice: price?.toString() ?? "0",
        actorAcct: actor.pubkey,
        filledBaseAmount: baseAmount.toString(),
        isActive: false,
        side: isBid ? OrderSide.BID : OrderSide.ASK,
        unfilledBaseAmount: "0",
        updatedAt: now,
      };

      const swapTake: TakesRecord = {
        marketAcct: marketAcct,
        baseAmount: baseAmount.toString(),
        orderBlock: tx.slot.toString(),
        orderTime: now,
        orderTxSig: signature,
        quotePrice: price?.toString() ?? "0",
        takerBaseFee: baseFee,
        takerQuoteFee: quoteFee,
        base_decimals: Number(baseDecimals),
        quote_decimals: Number(quoteDecimals),
      };

      marketAccts.push(new PublicKey(marketAcct));
      orders.push(swapOrder);
      takes.push(swapTake);
    } catch (e) {
      logger.error(e, `error with creating swap: ${e}`);
    }
  }

  const ammSwapTransaction = new AmmSwapTransaction(orders, takes, transactionRecord, marketAccts, reprocess);

  return ammSwapTransaction;
}

export class AmmSwapTransaction extends MarketTransaction {
  protected orders: OrdersRecord[];
  protected takes: TakesRecord[];

  constructor(orders: OrdersRecord[], takes: TakesRecord[], transactionRecord: TransactionRecord, marketAccts: PublicKey[], reprocess: boolean) {
    super(marketAccts, transactionRecord, reprocess );
    this.orders = orders;
    this.takes = takes;
  }

  async persist(): Promise<boolean> {

    try {

      await db.transaction(async (trx) => {
        if (this.reprocess) {
          //delete all orders and takes for this tx
          await trx.delete(schema.takes).where(eq(schema.takes.orderTxSig, this.transactionRecord.txSig)).execute();
          await trx.delete(schema.orders).where(eq(schema.orders.orderTxSig, this.transactionRecord.txSig)).execute();     
          
          //save the transaction record first
          await this.saveRecord();
        }

        //save the market and transaction record first
        await super.persist();

        for (const order of this.orders) {
          // Insert user if they aren't already in the database
          await trx.insert(schema.users)
            .values({ userAcct: order.actorAcct })
            .onConflictDoNothing()
            .returning({ userAcct: schema.users.userAcct });

          const orderInsertRes = await trx.insert(schema.orders)
            .values(order)
            .onConflictDoNothing()
            .returning({ txSig: schema.orders.orderTxSig });

          if (orderInsertRes.length > 0) {
            console.log("successfully inserted swap order record", orderInsertRes[0].txSig);
          }
        }

        for (const take of this.takes) {
          if (take.orderTxSig) {
            const takeInsertRes = await trx.insert(schema.takes)
              .values(take)
              .onConflictDoNothing()
              .returning({ txSig: schema.takes.orderTxSig });

            if (takeInsertRes.length > 0) {
              logger.info(`successfully inserted swap take record. ${takeInsertRes[0].txSig}`);
            }
          }
        }
      });
    } catch (e) {
      logger.error(e, `error with persisting swap: ${e}`);
      return false;
    }
    return true;
  }


  //this function is only used for testing
  //it verifies that the data is correct 
  //compared to the db
  async verify(): Promise<boolean> {

    let missing = 0;
    let issues = 0;
    for (const order of this.orders) {
      // Insert user if they aren't already in the database
      const dbOrder = await db.select()
        .from(schema.orders)
        .where(eq(schema.orders.orderTxSig, order.orderTxSig));

      if (dbOrder.length <= 0) {
        console.log("order not found", order.orderTxSig);
        missing++;
        continue;
      }

      if (dbOrder[0].marketAcct !== order.marketAcct) {
        console.log("ORDER marketAcct mismatch - db:", dbOrder[0].marketAcct, " - tx:", order.marketAcct);
        issues++;
      }

      if (dbOrder[0].actorAcct !== order.actorAcct) {
        console.log("ORDER actorAcct mismatch - db:", dbOrder[0].actorAcct, " - tx:", order.actorAcct);
        issues++;
      }

      if (dbOrder[0].side !== order.side) {
        console.log("ORDER side mismatch - db:", dbOrder[0].side, " - tx:", order.side);
        issues++;
      }

      if (dbOrder[0].filledBaseAmount !== order.filledBaseAmount) {
        console.log("ORDER filledBaseAmount mismatch - db:", dbOrder[0].filledBaseAmount, " - tx:", order.filledBaseAmount);
        issues++;
      }

      //allow a small amount of precision error
      const epsilon = 0.000001; // 6 decimal places of precision
      const price1 = parseFloat(dbOrder[0].quotePrice);
      const price2 = parseFloat(order.quotePrice);
      if (Math.abs(price1 - price2) > epsilon) {
        console.log("ORDER quotePrice mismatch - db:", dbOrder[0].quotePrice, " - tx:", order.quotePrice, "for order ", order.orderTxSig);
        issues++;
      }
    }

    for (const take of this.takes) {
      const dbTake = await db.select()
        .from(schema.takes)
        .where(eq(schema.takes.orderTxSig, take.orderTxSig ?? ""));

      if (dbTake.length <= 0) {
        console.log("take not found", take.orderTxSig);
        missing++;
        continue;
      }

      if (dbTake[0].marketAcct !== take.marketAcct) {
        console.log("TAKE marketAcct mismatch - db:", dbTake[0].marketAcct, " - tx:", take.marketAcct);
        issues++;
      }

      if (dbTake[0].baseAmount !== take.baseAmount) {
        console.log("TAKE baseAmount mismatch - db:", dbTake[0].baseAmount, " - tx:", take.baseAmount);
        issues++;
      }

      //allow a small amount of precision error
      const epsilon = 0.000001; // 6 decimal places of precision
      const price1 = parseFloat(dbTake[0].quotePrice);
      const price2 = parseFloat(take.quotePrice);
      if (Math.abs(price1 - price2) > epsilon) {
        console.log("TAKE quotePrice mismatch - db:", dbTake[0].quotePrice, " - tx:", take.quotePrice);
        issues++;
      }
      
    }
    
    if (missing > 0 || issues > 0) {
      console.log("missing", missing);
      console.log("issues", issues);
      return false;
    }
    return true;
  }
}


async function getMarketTokensFromDb(): Promise<Map<string, { baseToken: string, quoteToken: string }>> {
  const marketAcctRecord = await db.select({ market_acct: schema.markets.marketAcct, base_mint_acct: schema.markets.baseMintAcct, quote_mint_acct: schema.markets.quoteMintAcct })
    .from(schema.markets)
    .execute();

  const marketTokens = new Map<string, { baseToken: string, quoteToken: string }>();
  for (const record of marketAcctRecord) {

    marketTokens.set(record.market_acct, { baseToken: record.base_mint_acct, quoteToken: record.quote_mint_acct });
  }
  return marketTokens;
}