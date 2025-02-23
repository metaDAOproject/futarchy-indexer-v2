import { eq, schema, db, sql, or, inArray, and, lte, gt, desc } from "@metadaoproject/indexer-db";
import { alias } from "@metadaoproject/indexer-db/node_modules/drizzle-orm/pg-core";
import { log } from "./logger/logger";
import { proposals, ProposalStatus } from "@metadaoproject/indexer-db/lib/schema";
import { PriceMath, Proposal } from "@metadaoproject/futarchy/v0.3";
import { BN } from "@coral-xyz/anchor";
import { UserPerformanceRecord } from "@metadaoproject/indexer-db/lib/schema";


const logger = log.child({
  module: "userperformance"
});


type UserPerformanceTotals = {
  userAcct: string;
  tokensBought: number;
  tokensSold: number;
  volumeBought: number;
  volumeSold: number;
  tokensBoughtResolvingMarket: number;
  tokensSoldResolvingMarket: number;
  volumeBoughtResolvingMarket: number;
  volumeSoldResolvingMarket: number;
  buyOrderCount: number;
  sellOrderCount: number;
};

export async function calculateProposalPerformance(publicKey: string) {
  const quoteTokens = alias(schema.tokens, "quote_tokens"); // NOTE: This should be USDC for now
  const baseTokens = alias(schema.tokens, "base_tokens");
  // calculate performance
  const [proposalData] = await db.select({
    proposal: schema.proposals,
    daos: schema.daos,
    quote_token: quoteTokens,
    base_token: baseTokens
  })
    .from(schema.proposals)
    .where(
      eq(
        schema.proposals.proposalAcct,
        publicKey
      )
    )
    .leftJoin(
      schema.daos,
      eq(schema.proposals.daoAcct, schema.daos.daoAcct)
    )
    .leftJoin(quoteTokens, eq(schema.daos.quoteAcct, quoteTokens.mintAcct))
    .leftJoin(baseTokens, eq(schema.daos.baseAcct, baseTokens.mintAcct))
    .limit(1)
    .execute() ?? [];

  if (!proposalData) return;

  const { proposal, daos, quote_token, base_token } = proposalData;
  
  let proposalDaoAcct = daos?.daoAcct;

  if (!proposal || !quote_token || !base_token) {
    logger.error(`No proposal found for ${publicKey}`);
    return;
  }

  if (!proposalDaoAcct) {
    proposalDaoAcct = proposal.daoAcct;
  }

  if (!proposalDaoAcct) {
    logger.error("No daoAcct found");
    return;
  }

  const allTraders = await db.selectDistinct({ actorAcct: schema.orders.actorAcct })
    .from(schema.orders)
    .where(
      sql`${schema.orders.marketAcct} IN (${proposal.passMarketAcct}, ${proposal.failMarketAcct})`
    )
    .execute() ?? [];
  
  
  // Get the spot price at the time of the proposal finalization
  const proposalFinalizedAt = proposal.completedAt ?? new Date();
  const proposalFinalizedAtMinus2Minutes = new Date(proposalFinalizedAt);
  proposalFinalizedAtMinus2Minutes.setMinutes( proposalFinalizedAt.getMinutes() - 2 );
  
  const spotPriceAtFinalization = await db.select()
    .from(schema.prices)
    .where(
      and(
        eq(schema.prices.marketAcct, base_token?.mintAcct ?? ""),
        lte(schema.prices.createdAt, proposalFinalizedAt),
        gt(schema.prices.createdAt, proposalFinalizedAtMinus2Minutes)
      )
    )
    .limit(1)
    .orderBy(desc(schema.prices.createdAt))
    .execute() ?? [];
  
  const lastSpotPrice = Number(spotPriceAtFinalization[0]?.price ?? 0);
  
  for (const trader of allTraders) {
    await calculateUserPerformance(trader.actorAcct, proposal, lastSpotPrice, quote_token, base_token);
  }

}

async function calculateUserPerformance(
  userAcct: string, 
  proposal: typeof schema.proposals.$inferSelect,
  spotPriceAtFinalization: number,
  quote_token: typeof schema.tokens.$inferSelect,
  base_token: typeof schema.tokens.$inferSelect
) {

  const userPerformanceTotals: UserPerformanceTotals = {
    userAcct: userAcct,
    tokensBought: 0,
    tokensSold: 0,
    volumeBought: 0,
    volumeSold: 0,
    tokensBoughtResolvingMarket: 0,
    tokensSoldResolvingMarket: 0,
    volumeBoughtResolvingMarket: 0,
    volumeSoldResolvingMarket: 0,
    buyOrderCount: 0,
    sellOrderCount: 0,
  }

  const allOrders = await db.select()
        .from(schema.orders)
        .where(
          and(
            eq(schema.orders.actorAcct, userAcct),
            sql`${schema.orders.marketAcct} IN (${proposal.passMarketAcct}, ${proposal.failMarketAcct})`
          )
        )
    .execute() ?? [];
  const resolvingMarket = proposal.status === ProposalStatus.Passed
      ? proposal.passMarketAcct
    : proposal.failMarketAcct;

  

}

 

/*
  return;
  const allOrders = await db.select()
        .from(schema.orders)
        .where(
          sql`${schema.orders.marketAcct} IN (${proposals.passMarketAcct}, ${proposals.failMarketAcct})`
        )
        .execute() ?? [];

  // Get the time for us to search across the price space for spot
  const proposalFinalizedAt = proposals.completedAt ?? new Date();
  const proposalFinalizedAtMinus2Minutes = new Date(proposalFinalizedAt);
  proposalFinalizedAtMinus2Minutes.setMinutes( proposalFinalizedAt.getMinutes() - 2 );

  const resolvingMarket =  proposals.status === ProposalStatus.Passed
      ? proposals.passMarketAcct
      : proposals.failMarketAcct;
  
  // TODO: Get spot price at proposal finalization or even current spot price
  // if the proposal is still active (this would be UNREALISED P&L)
  // TODO: If this is 0 we really need to throw and error and alert someone, we shouldn't have missing spot data
  const spotPrice = await db.select()
        .from(schema.prices)
        .where(
          and(
            eq(schema.prices.marketAcct, base_tokens?.mintAcct ?? ""),
            lte(schema.prices.createdAt, proposalFinalizedAt),
            gt(schema.prices.createdAt, proposalFinalizedAtMinus2Minutes)
          )
        )
        .limit(1)
        .orderBy(desc(schema.prices.createdAt))
        .execute() ?? [];

  let actors = allOrders.reduce((current, next) => {
    const actor = next.actorAcct;
    let totals = current.get(actor);

    if (!totals) {
      totals = <UserPerformanceTotals>{
        tokensBought: 0, // Aggregate value for reporting
        tokensSold: 0,
        volumeBought: 0,
        volumeSold: 0,
        tokensBoughtResolvingMarket: 0, // P/F market buy quantity
        tokensSoldResolvingMarket: 0, // P/F market sell quantity
        volumeBoughtResolvingMarket: 0, // P/F market buy volume
        volumeSoldResolvingMarket: 0, // P/F market sell volume
        buyOrderCount: 0,
        sellOrderCount: 0,
      };
    }

    // Token Decimals used for nomalizing results
    const baseTokenDecimals = base_tokens?.decimals;
    const quoteTokenDecimals = quote_tokens?.decimals ?? 6; // NOTE: Safe for now

    if (!baseTokenDecimals || !quoteTokenDecimals) {
      return current;
    }

    // Debatable size or quantity, often used interchangably
    const size = PriceMath.getHumanAmount( new BN(next.filledBaseAmount), baseTokenDecimals );

    // Amount or notional
    const amount = Number(next.quotePrice).valueOf() * size;

    // Buy Side
    if (next.side === "BID") {
      totals.tokensBought = totals.tokensBought + size;
      totals.volumeBought = totals.volumeBought + amount;
      totals.buyOrderCount = totals.buyOrderCount + 1;
      // If this is the resolving market then we want to keep a running tally for that for P&L
      if (next.marketAcct === resolvingMarket) {
        totals.tokensBoughtResolvingMarket = totals.tokensBoughtResolvingMarket + size;
        totals.volumeBoughtResolvingMarket = totals.volumeBoughtResolvingMarket + amount;
      }
      // Sell Side
    } else if (next.side === "ASK") {
      totals.tokensSold = totals.tokensSold + size;
      totals.volumeSold = totals.volumeSold + amount;
      totals.sellOrderCount = totals.sellOrderCount + 1;
      // If this is the resolving market then we want to keep a running tally for that for P&L
      if (next.marketAcct === resolvingMarket) {
        totals.tokensSoldResolvingMarket = totals.tokensSoldResolvingMarket + size;
        totals.volumeSoldResolvingMarket = totals.volumeSoldResolvingMarket + amount;
      }
    }

    current.set(actor, totals);

    return current;
  }, new Map<string, UserPerformanceTotals>());

  const toInsert: Array<UserPerformanceRecord> = Array.from(actors.entries()).map<UserPerformanceRecord>((k) => {
    const [actor, values] = k;

    // NOTE: this gets us the delta, whereas we need to know the direction at the very end
    const tradeSizeDelta = Math.abs(
      values.tokensBoughtResolvingMarket - values.tokensSoldResolvingMarket
    );

    

    // We need to complete the round trip / final leg
    if (tradeSizeDelta !== 0) {
      // TODO: This needs to be revised given the spot price can't be null or 0 if we want to really do this
      const lastLegNotional = tradeSizeDelta * Number(spotPrice[0]?.price ?? "0");
      // NOTE: Directionally orients our last leg
      const needsSellToExit = values.tokensBoughtResolvingMarket > values.tokensSoldResolvingMarket; // boolean
      
      if (needsSellToExit) {
        // We've bought more than we've sold, therefore when we exit the position calulcation
        // we need to count the remaining volume as a sell at spot price when conditional
        // market is finalized.
        values.volumeSoldResolvingMarket = values.volumeSoldResolvingMarket + lastLegNotional;
      } else {
        values.volumeBoughtResolvingMarket = values.volumeBoughtResolvingMarket + lastLegNotional;
      }
    }

    return <UserPerformanceRecord>{
      proposalAcct: publicKey,
      daoAcct: proposalDaoAcct,
      userAcct: actor,
      tokensBought: values.tokensBought.toString(),
      tokensSold: values.tokensSold.toString(),
      volumeBought: values.volumeBought.toString(),
      volumeSold: values.volumeSold.toString(),
      tokensBoughtResolvingMarket: values.tokensBoughtResolvingMarket.toString(),
      tokensSoldResolvingMarket: values.tokensSoldResolvingMarket.toString(),
      volumeBoughtResolvingMarket: values.volumeBoughtResolvingMarket.toString(),
      volumeSoldResolvingMarket: values.volumeSoldResolvingMarket.toString(),
      buyOrdersCount: values.buyOrderCount as unknown as bigint,
      sellOrdersCount: values.sellOrderCount as unknown as bigint,
    };
  });

  if (toInsert.length > 0) {
    await db.transaction(async (tx) => {
      await tx.insert(schema.users)
        .values(
          toInsert.map((i) => {
            return { userAcct: i.userAcct };
          })
        )
        .onConflictDoNothing();

      await Promise.all(
        toInsert.map(async (insert) => {
          try {
            await tx.insert(schema.userPerformance)
              .values(insert)
              .onConflictDoUpdate({
                target: [
                  schema.userPerformance.proposalAcct,
                  schema.userPerformance.userAcct,
                ],
                set: {
                  tokensBought: insert.tokensBought,
                  tokensSold: insert.tokensSold,
                  volumeBought: insert.volumeBought,
                  volumeSold: insert.volumeSold,
                  tokensBoughtResolvingMarket: insert.tokensBoughtResolvingMarket,
                  tokensSoldResolvingMarket: insert.tokensSoldResolvingMarket,
                  volumeBoughtResolvingMarket: insert.volumeBoughtResolvingMarket,
                  volumeSoldResolvingMarket: insert.volumeSoldResolvingMarket,
                  buyOrdersCount: insert.buyOrdersCount,
                  sellOrdersCount: insert.sellOrdersCount,
                },
              });
          } catch (e) {
            logger.error("error inserting user_performance record", e);
          }
        })
      );
    });
  }
}
*/