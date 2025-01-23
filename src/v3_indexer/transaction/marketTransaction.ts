import { AccountInfo, Context, PublicKey } from "@solana/web3.js";
import { connection, provider, rpcReadClient } from "../connection";
import { PersistableTransaction } from "./persistableTransaction";
import { db, eq, inArray, schema } from "@metadaoproject/indexer-db";
import { enrichTokenMetadata } from "@metadaoproject/futarchy-sdk/dist";
import { getMint } from "@solana/spl-token";
import { PricesRecord, PricesType, TokenRecord, TwapRecord } from "@metadaoproject/indexer-db/lib/schema";
import { BN } from "@coral-xyz/anchor";

import { log } from "../../logger/logger";
import { PriceMath } from "@metadaoproject/futarchy/v0.3";
import { getHumanPrice } from "./utils";

const logger = log.child({
  module: "marketTransaction"
});

export class MarketTransaction implements PersistableTransaction {
  protected marketAccts: PublicKey[];
  constructor(marketAccts: PublicKey[]) {
    this.marketAccts = marketAccts;
  }
  async persist(): Promise<boolean> {
    for (const marketAcct of this.marketAccts) {
      try {
        const accountInfo = await connection.getAccountInfoAndContext(marketAcct);
        if (!accountInfo || !accountInfo.value) {
          logger.error("no account info found", marketAcct);
          return false;
        }
        await this.indexAmmMarketAccountWithContext(accountInfo.value, marketAcct, accountInfo.context);
      } catch (e) {
        logger.error(e, "error indexing market account");
        return false;
      }
    }

    return true;
  }

  async indexAmmMarketAccountWithContext(
    accountInfo: AccountInfo<Buffer>,
    account: PublicKey,
    context: Context
  ): Promise<boolean> {
    const ammMarketAccount = await rpcReadClient.markets.amm.decodeMarket(
      accountInfo
    );

    // TODO: prob need to type these lol
    let baseToken;
    let quoteToken;

    //get base and quote decimals from db
    const tokens = await
      db
        .select()
        .from(schema.tokens)
        .where(inArray(schema.tokens.mintAcct, [ammMarketAccount.baseMint.toString(), ammMarketAccount.quoteMint.toString()]))
        .execute();


    if (!tokens || tokens.length < 2) {
      // fallback if we don't have the tokens in the db for some reason
      baseToken = await enrichTokenMetadata(ammMarketAccount.baseMint, provider);
      quoteToken = await enrichTokenMetadata(ammMarketAccount.quoteMint, provider);

      // get token mints from rpc (needed for fetching supply)
      const baseMintPubKey = new PublicKey(baseToken.publicKey ?? "");
      const baseTokenMint = await getMint(connection, baseMintPubKey);
      const quoteMintPubKey = new PublicKey(quoteToken.publicKey ?? "");
      const quoteTokenMint = await getMint(connection, quoteMintPubKey);
      const baseTokenRecord: TokenRecord = {
        symbol: baseToken.symbol,
        name: baseToken.name ? baseToken.name : baseToken.symbol,
        decimals: baseToken.decimals,
        mintAcct: baseToken.publicKey ?? "",
        supply: baseTokenMint.supply.toString(),
        updatedAt: new Date(),
      }
      const quoteTokenRecord: TokenRecord = {
        symbol: quoteToken.symbol,
        name: quoteToken.name ? quoteToken.name : quoteToken.symbol,
        decimals: quoteToken.decimals,
        mintAcct: quoteToken.publicKey ?? "",
        supply: quoteTokenMint.supply.toString(),
        updatedAt: new Date(),
      }
      const tokensToInsert = [baseTokenRecord, quoteTokenRecord];
      //upsert tokens to db
      try {
        await db.insert(schema.tokens)
          .values(tokensToInsert)
          .onConflictDoNothing() //TODO: probably better to update instead of do nothing on conflict, since supply/name/ticker could've changed
        .execute();
      } catch (e) {
        logger.warn(e, "Error inserting the tokens");
      }

    } else {
      baseToken = tokens.find(token => token.mintAcct === ammMarketAccount.baseMint.toString());
      quoteToken = tokens.find(token => token.mintAcct === ammMarketAccount.quoteMint.toString());
    }

    // if we don't have an oracle.aggregator of 0 let's run this mf
    if (!ammMarketAccount.oracle.aggregator.isZero()) {
      // indexing the twap
      const market = await db.select()
        .from(schema.markets)
        .where(eq(schema.markets.marketAcct, account.toBase58()))
        .execute();

      if (market === undefined || market.length === 0) {
        logger.warn("market not found", account.toBase58());
        return false;
      }

      const twapCalculation: BN = ammMarketAccount.oracle.aggregator.div(
        ammMarketAccount.oracle.lastUpdatedSlot.sub(
          ammMarketAccount.createdAtSlot
        )
      );

      const proposalAcct = market[0].proposalAcct;

      const twapNumber: string = twapCalculation.toString();
      const newTwap: TwapRecord = {
        curTwap: twapNumber,
        marketAcct: account.toBase58(),
        observationAgg: ammMarketAccount.oracle.aggregator.toString(),
        proposalAcct: proposalAcct,
        // alternatively, we could pass in the context of the update here
        updatedSlot: context
          ? context.slot.toString()
          : ammMarketAccount.oracle.lastUpdatedSlot.toString(),
        lastObservation: ammMarketAccount.oracle.lastObservation.toString(),
        lastPrice: ammMarketAccount.oracle.lastPrice.toString(),
      };

      try {
        // TODO batch commits across inserts - maybe with event queue
        const twapUpsertResult = await db.insert(schema.twaps)
          .values(newTwap)
          .onConflictDoNothing()
          .returning({ marketAcct: schema.twaps.marketAcct });

      } catch (e) {
        logger.error("error upserting twap", e);
        return false;
      }
    }

    let priceFromReserves: BN;

    if (ammMarketAccount.baseAmount.isZero() || ammMarketAccount.quoteAmount.isZero()) {
      logger.warn("baseAmount" +  ammMarketAccount.baseAmount.toString() + " quoteAmount" + ammMarketAccount.quoteAmount.toString());
      return false;
    }

    try {
      priceFromReserves = PriceMath.getAmmPriceFromReserves(
        ammMarketAccount.baseAmount,
        ammMarketAccount.quoteAmount
      );
    } catch (e) {
      logger.error("failed to get price from reserves", e);
      return false;
    }

    let conditionalMarketSpotPrice: number;

    if (!baseToken || !quoteToken) {
      logger.error("Missing token information");
      return false;
    }

    try {
      conditionalMarketSpotPrice = getHumanPrice(
        priceFromReserves,
        baseToken.decimals!!,
        quoteToken.decimals!!
      );
    } catch (e) {
      logger.error("failed to get human price", e);
      return false;
    }

    const newAmmConditionaPrice: PricesRecord = {
      marketAcct: account.toBase58(),
      updatedSlot: context
        ? context.slot.toString()
        : ammMarketAccount.oracle.lastUpdatedSlot.toString(),
      price: conditionalMarketSpotPrice.toString(),
      pricesType: PricesType.Conditional,
      createdBy: "amm-market-indexer",
      baseAmount: ammMarketAccount.baseAmount.toString(),
      quoteAmount: ammMarketAccount.quoteAmount.toString(),
    };


    try {
      const pricesInsertResult = await db.insert(schema.prices)
        .values(newAmmConditionaPrice)
        .onConflictDoUpdate({
          target: [schema.prices.createdAt, schema.prices.marketAcct],
          set: newAmmConditionaPrice,
        })
        .returning({ marketAcct: schema.prices.marketAcct });

      if (pricesInsertResult === undefined || pricesInsertResult.length === 0) {
        logger.error("failed to index amm price", newAmmConditionaPrice.marketAcct);
        return false;
      }
    } catch (e) {
      logger.error(e,"error upserting prices");
      return false;
    }


    return true;
  }

}