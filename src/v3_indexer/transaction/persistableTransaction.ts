import { getTransaction, Instruction, parseFormattedInstructionArgsData, serialize, SERIALIZED_TRANSACTION_LOGIC_VERSION, Transaction } from "./serializer";
import { log } from "../../logger/logger";
import { OrderSide, OrdersRecord, TakesRecord, TokenRecord, TransactionRecord } from "@metadaoproject/indexer-db/lib/schema";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getHumanPrice, getMainIxTypeFromTransaction } from "./utils";
import { SwapTransaction } from "./swapTransaction";
import { MarketTransaction } from "./marketTransaction";
import { db, eq, schema } from "@metadaoproject/indexer-db";

const logger = log.child({
  module: "persistable"
});


export interface PersistableTransaction { 
  persist(): Promise<boolean>;
}

class FakePersistableTransaction implements PersistableTransaction {
  async persist(): Promise<boolean> {
    return true;
  }
}



/*
* This creates a PersistableTransaction from a signature and slot
*
* it can be a swap or a market transaction
*/
export async function ptFromSignatureAndSlot(signature: string, slot:number): Promise<PersistableTransaction | null > {

  try {

    //first lets see if we have this in the db
    const dbTx = await db.select({txSig: schema.transactions.txSig})
      .from(schema.transactions)
      .where(eq(schema.transactions.txSig, signature))
      .execute();
    
    if (dbTx.length > 0) {
      logger.info(`${signature} already in db`);
      return null;
    }

    const tx = await getTransaction(signature);
    if (tx === true) {
      //this is a crank and a hack to make the other code cleaner
      return new FakePersistableTransaction();
    }
    if (!tx) {
      //logger.info(signature, "no tx for signature");
      return null;
    }

    const swapIx = tx.instructions.find((ix) => ix.name === "swap");
    if (swapIx) {
      return await createSwapTransaction(tx, swapIx, signature, slot);   
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
        const marketTransaction = new MarketTransaction(marketAccts);
        return marketTransaction;
      } else {
        logger.info(signature,"no market account found for non swap txn");
      }

    }
    //logger.info("no swap found for txn", signature);
    return null;

  } catch (e: any) {
    logger.error(e);
    return null;
  }

  return null;
}

async function createSwapTransaction(
  tx: Transaction, 
  swapIx: Instruction, 
  signature: string, 
  slot: number
): Promise<SwapTransaction | null> {
  const mintIx = tx.instructions?.find(i => i.name === "mintConditionalTokens");
  const mergeIx = tx.instructions?.find(i => i.name === "mergeConditionalTokensForUnderlyingTokens");
  
  if (mergeIx && mintIx) {
    logger.error(new Error("ARB TRANSACTION DETECTED"));
    return null;
  }

  const marketAcct = swapIx.accountsWithData.find(a => a.name === "amm");
  if (!marketAcct) {
    logger.info(signature, "no market account found");
    return null;
  }

  const marketAcctPubKey = new PublicKey(marketAcct.pubkey);
  const marketTransaction = new MarketTransaction([marketAcctPubKey]);
  await marketTransaction.persist();

  const blockTime = new Date(tx.blockTime * 1000);
  const result = await buildOrderFromSwapIx(swapIx, tx, mintIx, marketAcct.pubkey, blockTime);
  if (!result) {
    logger.warn(`${signature} no swap order or swap take found`);
    return null;
  }

  const {swapOrder, swapTake} = result;
  const transactionRecord: TransactionRecord = {
    txSig: signature,
    slot: slot.toString(),
    blockTime: blockTime,
    failed: tx.err !== undefined,
    payload: serialize(tx),
    serializerLogicVersion: SERIALIZED_TRANSACTION_LOGIC_VERSION,
    mainIxType: getMainIxTypeFromTransaction(tx),
  };

  return new SwapTransaction(swapOrder, swapTake, transactionRecord);
}

async function buildOrderFromSwapIx(swapIx: Instruction, tx: Transaction, mintIx: Instruction | undefined, marketAcct: string, blockTime:Date):
  Promise<{ swapOrder: OrdersRecord; swapTake: TakesRecord } | null> {
  
  const funcLog = logger.child({
    func: "buildOrderFromSwapIx"
  });

  if (!swapIx) {
    funcLog.info("no swap ix found");
    return null;
  }

  const userAcct = swapIx.accountsWithData.find((a) => a.name === "user");
  const userBaseAcct = swapIx.accountsWithData.find(
    (a) => a.name === "userBaseAccount"
  );
  const userQuoteAcct = swapIx.accountsWithData.find(
    (a) => a.name === "userQuoteAccount"
  );

  if (!userAcct || !userBaseAcct || !userQuoteAcct) {
    funcLog.info("no user or base info found", userAcct, userBaseAcct, userQuoteAcct);
    return null;
  }

  if (!swapIx.args) {
    funcLog.info("missing swap args");
    return null;
  }
  const swapArgs = swapIx.args.find((a) => a.type === "SwapArgs");
  if (!swapArgs) {
    funcLog.info("no swap args found");
    return null;
  }
  const swapArgsParsed = parseFormattedInstructionArgsData<{
    swapType: string;
    inputAmount: number;
    outputAmount: number;
  }>(swapArgs?.data ?? "");

  const mintAmount = mintIx
    ? mintIx.args.find((a) => a.name === "amount")?.data ?? "0"
    : "0";
  // determine side
  const side =  swapArgsParsed?.swapType === "Buy" ? OrderSide.BID : OrderSide.ASK;

  // get balances
  const userBaseAcctWithBalances = tx.accounts.find(
    (a) => a.pubkey === userBaseAcct.pubkey
  );

  const userBasePreBalance = userBaseAcctWithBalances?.preTokenBalance?.amount ?? BigInt(0);

  const userBasePreBalanceWithPotentialMint =
    side === OrderSide.ASK
      ? userBasePreBalance +BigInt(Number(mintAmount))
      : userBaseAcctWithBalances?.preTokenBalance?.amount;

  const userBasePostBalance =  userBaseAcctWithBalances?.postTokenBalance?.amount;

  const userQuoteAcctWithBalances = tx.accounts.find(
    (a) => a.pubkey === userQuoteAcct.pubkey
  );

  const userQuotePreBalance = userQuoteAcctWithBalances?.preTokenBalance?.amount ?? BigInt(0);

  const userQuotePreBalanceWithPotentialMint =
    side === OrderSide.BID
      ? userQuotePreBalance + BigInt(Number(mintAmount))
      : userQuoteAcctWithBalances?.preTokenBalance?.amount;

  const userQuotePostBalance =  userQuoteAcctWithBalances?.postTokenBalance?.amount;

  const ba = (userBasePostBalance ?? BigInt(0)) - (userBasePreBalanceWithPotentialMint ?? BigInt(0));
  const baseAmount = new BN(ba.toString()).abs();
  
  const qb = (userQuotePostBalance ?? BigInt(0)) - (userQuotePreBalanceWithPotentialMint ?? BigInt(0));
  const quoteAmount = new BN(qb.toString()).abs();

  if (
    !!tx.err &&
    quoteAmount.toString() === "0" &&
    baseAmount.toString() === "0"
  ) {
    funcLog.error(new Error(`failed swap ${tx.signatures[0]} with no quote or base amount`));
    return null;
  }

  // determine price
  // NOTE: This is estimated given the output is a min expected value
  // default is input / output (buying a token with USDC or whatever)
  const { baseToken, quoteToken } = await getMarketTokens(marketAcct);
  if (!baseToken || !quoteToken) {
    logger.error(new Error(`no base or quote token found for market ${marketAcct}`));
    return null;
  }

  let price: number | null = null;

  if (quoteAmount.toString() && baseAmount.toString()) {
    console.log(quoteAmount.toString(), baseAmount.toString());
    try{
      const ammPrice = quoteAmount.mul(new BN(10).pow(new BN(12))).div(baseAmount)

      price = getHumanPrice(
        ammPrice,
        baseToken.decimals,
        quoteToken.decimals
      );
    } catch (e) {
      logger.warn(e, "error getting price");
      return null;
    }
  }
  // TODO: Need to likely handle rounding.....
  // index a swap here

  const signature = tx.signatures[0];
  let now = new Date();
  if (blockTime) {
    now = blockTime;
  }

  const swapOrder: OrdersRecord = {
    marketAcct: marketAcct,
    orderBlock: tx.slot.toString(),
    orderTime: now,
    orderTxSig: signature,
    quotePrice: price?.toString() ?? "0",
    actorAcct: userAcct.pubkey,
    // TODO: If and only if the transaction is SUCCESSFUL does this value equal this..
    filledBaseAmount: baseAmount.toString(),
    isActive: false,
    side: side,
    // TODO: If transaction is failed then this is the output amount...
    unfilledBaseAmount: "0",
    updatedAt: now,
  };

  const swapTake: TakesRecord = {
    marketAcct: marketAcct,
    // This will always be the DAO / proposal base token, so while it may be NICE to have a key
    // to use to reference on data aggregate, it's not directly necessary.
    baseAmount: baseAmount.toString(), // NOTE: This is always the base token given we have a BASE / QUOTE relationship
    orderBlock: tx.slot.toString(),
    orderTime: now,
    orderTxSig: signature,
    quotePrice: price?.toString() ?? "0",
    // TODO: this is coded into the market, in the case of our AMM, it's 1%
    // this fee is based on the INPUT value (so if we're buying its USDC, selling its TOKEN)
    takerBaseFee: BigInt(0),
    takerQuoteFee: BigInt(0),
  };

  return { swapOrder, swapTake };
}

async function getMarketTokens(marketAcctPubKey: string): Promise<{baseToken: TokenRecord | null, quoteToken: TokenRecord | null}> {
  const marketAcctRecord = await db.select()
    .from(schema.markets)
    .where(eq(schema.markets.marketAcct, marketAcctPubKey))
    .execute();
    
  if (marketAcctRecord.length === 0) {
    logger.error( new Error(`no market acct record found for ${marketAcctPubKey}`) );
    return { baseToken: null, quoteToken: null};
  }
  const baseToken = await db.select()
    .from(schema.tokens)
    .where(eq(schema.tokens.mintAcct, marketAcctRecord[0].baseMintAcct))
    .execute();
    
  if (baseToken.length === 0) {
    logger.error( new Error(`No base token found for market ${marketAcctPubKey}`) );
    return {baseToken: null, quoteToken: null};
  }
  const quoteToken = await db.select()
    .from(schema.tokens)
    .where(eq(schema.tokens.mintAcct, marketAcctRecord[0].quoteMintAcct))
    .limit(1)
    .execute();
  if (baseToken.length === 0) {
    logger.error( new Error(`No quote token found for market ${marketAcctPubKey}`) );
    return {baseToken: null, quoteToken: null};
  }

  return {baseToken: baseToken[0], quoteToken: quoteToken[0]};
}