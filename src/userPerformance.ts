import { eq, schema, db, sql, and, lte, gt, desc, asc } from "@metadaoproject/indexer-db";
import { alias } from "@metadaoproject/indexer-db/node_modules/drizzle-orm/pg-core";
import { log } from "./logger/logger";
import { ProposalStatus } from "@metadaoproject/indexer-db/lib/schema";
import { PriceMath } from "@metadaoproject/futarchy/v0.3";
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

  const allTraders = await db.selectDistinct({ actorAcct: schema.takes.actorAcct })
    .from(schema.takes)
    .where(
      sql`${schema.takes.marketAcct} IN (${proposal.passMarketAcct}, ${proposal.failMarketAcct})`
    )
    .execute() ?? [];


  // Get the spot price at the time of the proposal finalization
  const proposalFinalizedAt = proposal.completedAt ?? new Date();
  const proposalFinalizedAtMinus10Minutes = new Date(proposalFinalizedAt);
  proposalFinalizedAtMinus10Minutes.setMinutes(proposalFinalizedAt.getMinutes() - 10);

  const spotPriceAtFinalization = await db.select()
    .from(schema.prices)
    .where(
      and(
        eq(schema.prices.marketAcct, base_token?.mintAcct ?? ""),
        lte(schema.prices.createdAt, proposalFinalizedAt),
        gt(schema.prices.createdAt, proposalFinalizedAtMinus10Minutes)
      )
    )
    .limit(1)
    .orderBy(asc(schema.prices.createdAt))
    .execute() ?? [];

  const lastSpotPrice = Number(spotPriceAtFinalization[0]?.price ?? 0);
  if (lastSpotPrice === 0) {
    logger.error("No spot price found at finalization for proposal " + publicKey + " NO USER PERFORMANCE CALCULATED");
    return;
  }

  for (const trader of allTraders) {
    if (!trader.actorAcct) continue;
    try {
      const value = await calculateUserPerformance(trader.actorAcct, proposal, lastSpotPrice, base_token.decimals);

      const upr: UserPerformanceRecord = {
        proposalAcct: publicKey,
        daoAcct: proposalDaoAcct,
        userAcct: trader.actorAcct,
        tokensBought: value.tokensBought.toString(),
        tokensSold: value.tokensSold.toString(),
        volumeBought: value.volumeBought.toString(),
        volumeSold: value.volumeSold.toString(),
        tokensBoughtResolvingMarket: value.tokensBoughtResolvingMarket.toString(),
        tokensSoldResolvingMarket: value.tokensSoldResolvingMarket.toString(),
        volumeBoughtResolvingMarket: value.volumeBoughtResolvingMarket.toString(),
        volumeSoldResolvingMarket: value.volumeSoldResolvingMarket.toString(),
        buyOrdersCount: value.buyOrderCount as unknown as bigint,
        sellOrdersCount: value.sellOrderCount as unknown as bigint,
      };
      await db.insert(schema.users)
        .values(
          { userAcct: trader.actorAcct }
        )
        .onConflictDoNothing();

      await db.insert(schema.userPerformance).values(upr)
        .onConflictDoUpdate({
          target: [
            schema.userPerformance.proposalAcct,
            schema.userPerformance.userAcct,
          ],
          set: {
            tokensBought: upr.tokensBought,
            tokensSold: upr.tokensSold,
            volumeBought: upr.volumeBought,
            volumeSold: upr.volumeSold,
            tokensBoughtResolvingMarket: upr.tokensBoughtResolvingMarket,
            tokensSoldResolvingMarket: upr.tokensSoldResolvingMarket,
            volumeBoughtResolvingMarket: upr.volumeBoughtResolvingMarket,
            volumeSoldResolvingMarket: upr.volumeSoldResolvingMarket,
            buyOrdersCount: upr.buyOrdersCount,
            sellOrdersCount: upr.sellOrdersCount,
          }
        });
    } catch (e) {
      logger.error(e, "error inserting user_performance record");
    }
  }

}

async function calculateUserPerformance(
  userAcct: string,
  proposal: typeof schema.proposals.$inferSelect,
  spotPriceAtFinalization: number,
  baseDecimals: number
): Promise<UserPerformanceTotals> {

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
    .from(schema.takes)
    .where(
      and(
        eq(schema.takes.actorAcct, userAcct),
        sql`${schema.takes.marketAcct} IN (${proposal.passMarketAcct}, ${proposal.failMarketAcct})`
      )
    )
    .orderBy(desc(schema.takes.orderTime))
    .execute() ?? [];
  const resolvingMarket = proposal.status === ProposalStatus.Passed
    ? proposal.passMarketAcct
    : proposal.failMarketAcct;


  for (const order of allOrders) {
    // Debatable size or quantity, often used interchangably
    const size = PriceMath.getHumanAmount(new BN(order.baseAmount), baseDecimals);

    // Amount or notional
    const amount = Number(order.quotePrice).valueOf() * size;

    // Buy Side
    if (order.side === "BID") {
      userPerformanceTotals.tokensBought = userPerformanceTotals.tokensBought + size;
      userPerformanceTotals.volumeBought = userPerformanceTotals.volumeBought + amount;
      userPerformanceTotals.buyOrderCount++;
      // If this is the resolving market then we want to keep a running tally for that for P&L
      if (order.marketAcct === resolvingMarket) {
        userPerformanceTotals.tokensBoughtResolvingMarket = userPerformanceTotals.tokensBoughtResolvingMarket + size;
        userPerformanceTotals.volumeBoughtResolvingMarket = userPerformanceTotals.volumeBoughtResolvingMarket + amount;
      }
      // Sell Side
    } else if (order.side === "ASK") {
      userPerformanceTotals.tokensSold = userPerformanceTotals.tokensSold + size;
      userPerformanceTotals.volumeSold = userPerformanceTotals.volumeSold + amount;
      userPerformanceTotals.sellOrderCount++;
      // If this is the resolving market then we want to keep a running tally for that for P&L
      if (order.marketAcct === resolvingMarket) {
        userPerformanceTotals.tokensSoldResolvingMarket = userPerformanceTotals.tokensSoldResolvingMarket + size;
        userPerformanceTotals.volumeSoldResolvingMarket = userPerformanceTotals.volumeSoldResolvingMarket + amount;
      }
    }

  }

  // NOTE: this gets us the delta, whereas we need to know the direction at the very end
  const tradeSizeDelta = Math.abs(
    userPerformanceTotals.tokensBoughtResolvingMarket - userPerformanceTotals.tokensSoldResolvingMarket
  );

  // We need to complete the round trip / final leg
  if (tradeSizeDelta !== 0) {
    // TODO: This needs to be revised given the spot price can't be null or 0 if we want to really do this
    const lastLegNotional = tradeSizeDelta * Number(spotPriceAtFinalization);
    // NOTE: Directionally orients our last leg
    const needsSellToExit = userPerformanceTotals.tokensBoughtResolvingMarket > userPerformanceTotals.tokensSoldResolvingMarket; // boolean

    if (needsSellToExit) {
      // We've bought more than we've sold, therefore when we exit the position calulcation
      // we need to count the remaining volume as a sell at spot price when conditional
      // market is finalized.
      userPerformanceTotals.volumeSoldResolvingMarket = userPerformanceTotals.volumeSoldResolvingMarket + lastLegNotional;
    } else {
      userPerformanceTotals.volumeBoughtResolvingMarket = userPerformanceTotals.volumeBoughtResolvingMarket + lastLegNotional;
    }
  }

  return userPerformanceTotals;
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