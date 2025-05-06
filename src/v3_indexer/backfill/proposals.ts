import { Dao, ProposalAccountWithKey } from "@metadaoproject/futarchy-sdk/dist/types";
import { conditionalVaultClient, connection, provider, rpcReadClient } from "../connection";
import { ConditionalVaultRecord, DaoRecord, MarketRecord, MarketType, ProposalRecord, ProposalStatus, TokenAcctRecord, TokenRecord, UserPerformanceRecord } from "@metadaoproject/indexer-db/lib/schema";
import { eq, schema, db, sql, or, inArray, and, lte, gt, desc } from "@metadaoproject/indexer-db";
import { log } from "src/logger/logger";
import { getAccount, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { enrichTokenMetadata } from "@metadaoproject/futarchy-sdk/dist";
import pLimit from "p-limit";
import { alias } from "@metadaoproject/indexer-db";
import { PriceMath } from "@metadaoproject/futarchy/v0.3";

const passImgUrl = "https://imagedelivery.net/HYEnlujCFMCgj6yA728xIw/f38677ab-8ec6-4706-6606-7d4e0a3cfc00/public";
const failImgUrl = "https://imagedelivery.net/HYEnlujCFMCgj6yA728xIw/d9bfd8de-2937-419a-96f6-8d6a3a76d200/public";
const logger = log.child({
  module: "backfill-proposals-v3"
});

const limit = pLimit(5);

/**
 * Backfills all on-chain proposals to the database.
 * 
 * This inserts all of the proposals, with an onconflict that updates the proposal.
 * 
 * Proposals that are missing from the database are added to the backfill list to get old historical data
 */
export async function backfillProposals(): Promise<{message:string, error: Error|undefined}> {

  const startTime = performance.now();
  logger.info("Backfilling proposals");

  //grab the db proposals so we can see what ones need to be inserted or updated
  const dbProposals: ProposalRecord[] = await db.select().from(schema.proposals);
  if (dbProposals.length === 0) {
    logger.info("No proposals found in db, if this was not a fresh start, then the database may need to be checked");
  } else {
    logger.info(`Found ${dbProposals.length} proposals in db`);
  }

  //only doing v0.3
  const protocolV0_3 = rpcReadClient.futarchyProtocols.find(
    (protocol) => protocol.deploymentVersion == "V0.3"
  );

  if (!protocolV0_3) {
    return {message: "Protocol V0.3 not found", error: new Error("Protocol V0.3 not found")};
  }

  //get the proposals from the chain
  const onChainProposals = await protocolV0_3.autocrat.account.proposal.all();
  if (!onChainProposals || onChainProposals.length === 0) {
    return {message: "Failed to fetch on-chain proposals", error: new Error("Failed to fetch on-chain proposals")};
  }
  logger.info(`Found ${onChainProposals.length} proposals on chain`);

  const proposalsToInsert = [];
  const proposalsToUpdate = [];
  for (const proposal of onChainProposals) {
    //just making two lists, one for insert and one for update
    const dbProposal = dbProposals.find((dbProposal) => dbProposal.proposalAcct == proposal.publicKey.toString());
    if (dbProposal) {
      //if this proposal is not ended, then we need to update it
      if (dbProposal.completedAt == null) {
        proposalsToUpdate.push(proposal);
      }
    } else {
      //if this proposal is not in the db, then we need to insert it
      proposalsToInsert.push(proposal);
    }
  }

  //if there are no proposals to insert, then we are done
  if (!proposalsToInsert.length && !proposalsToUpdate.length) {
    const message = `No proposals to insert or update`;
    logger.info(message);
    return {message: message, error: undefined};
  } 

  let message = `Inserting ${proposalsToInsert.length} proposals`;
  message += `\nUpdating ${proposalsToUpdate.length} proposals`;

  logger.info(`Inserting ${proposalsToInsert.length} proposals`);
  logger.info(`Updating ${proposalsToUpdate.length} proposals`);

  //processProposals is a helper function that uses pLimit to limit the number of proposals we are processing at once
  //but does a promise.all to execute them faster (base on limit at the top of the file)
  await processProposals(proposalsToInsert, insertProposal);
  await processProposals(proposalsToUpdate, updateProposal);

  const endTime = performance.now()
  message += `<br>Backfilling proposals complete - took ${(endTime - startTime) / 1000} seconds`;
  logger.info(`Backfilling proposals complete - took ${(endTime - startTime) / 1000} seconds`);

  return {message: message, error: undefined};
}



/********************************************************************************
 * 
 *  Private functions
 * 
 */

/**
 * Processes a list of proposals using a limit to avoid overwhelming the RPC
 * @param proposals the proposals to process
 * @param processFn the function to process the proposals (insert or update)
 */
async function processProposals(proposals: ProposalAccountWithKey[], processFn: (p: ProposalAccountWithKey, currentSlot: BN) => Promise<Error | null>) {
  const currentSlot = await connection.getSlot();

  const tasks = proposals.map(proposal => limit(() => processFn(proposal, new BN(currentSlot))));
  const errors = await Promise.all(tasks);
  errors.forEach(err => {
    if (err) logger.error(err);
  });
}

/**
 * Inserts a proposal into the database
 * @param proposal 
 */
async function insertProposal(proposal: ProposalAccountWithKey, currentSlot: BN): Promise<Error | null> {

  let vaultStatus = "active";
  let status = ProposalStatus.Pending;
  if ('pending' in proposal.account.state) {
    status = ProposalStatus.Pending;
  } else if ('passed' in proposal.account.state) {
    status = ProposalStatus.Passed;
    vaultStatus = "finalized";
  } else if ('failed' in proposal.account.state) {
    status = ProposalStatus.Failed;
    vaultStatus = "reverted";
  }

  await insertVault(proposal.account.baseVault, vaultStatus);
  await insertVault(proposal.account.quoteVault, vaultStatus);

  const proposalAcct = proposal.account;
  const daoAcct = proposalAcct.dao;
  if (!daoAcct) return new Error("No dao found for proposal");

  const passAmm = proposalAcct.passAmm;
  const failAmm = proposalAcct.failAmm;
  if (!passAmm || !failAmm) return new Error("No pass or fail amm found for proposal");


  const dbDao: DaoRecord | undefined = (
    await db.select()
      .from(schema.daos)
      .where(eq(schema.daos.daoAcct, daoAcct.toBase58()))
  )?.[0];

  if (!dbDao) return new Error("No dao found for proposal in db");


  const endedAt = getProposalEndTime(currentSlot, proposal.account.slotEnqueued, new BN(dbDao.slotsPerProposal?.toString() ?? '0'));

  const dbProposal: ProposalRecord = {
    proposalAcct: proposal.publicKey.toString(),
    proposalNum: BigInt(proposal.account.number.toString()),
    autocratVersion: 0.3,
    daoAcct: daoAcct.toString(),
    proposerAcct: proposal.account.proposer.toString(),
    status: status,
    endedAt: endedAt,
    completedAt: status !== ProposalStatus.Pending ? endedAt : null,
    descriptionURL: proposal.account.descriptionUrl,
    initialSlot: proposal.account.slotEnqueued.toString(),
    passMarketAcct: passAmm.toString(),
    failMarketAcct: failAmm.toString(),
    baseVault: proposal.account.baseVault.toString(),
    quoteVault: proposal.account.quoteVault.toString(),
    endSlot:
      proposal.account.slotEnqueued
        .add(new BN(dbDao.slotsPerProposal?.toString() ?? '0'))
        .toString()
    ,
    durationInSlots: dbDao.slotsPerProposal,
    minBaseFutarchicLiquidity: dbDao.minBaseFutarchicLiquidity ?? null,
    minQuoteFutarchicLiquidity: dbDao.minQuoteFutarchicLiquidity ?? null,
    passThresholdBps: dbDao.passThresholdBps,
    twapInitialObservation: dbDao.twapInitialObservation ?? null,
    twapMaxObservationChangePerUpdate:
      dbDao.twapMaxObservationChangePerUpdate ?? null,
  };

  await insertAssociatedAccountsDataForProposal(proposal, dbDao);

  try {
    await db.insert(schema.proposals)
      .values([dbProposal])
      .onConflictDoNothing();
  } catch (e) {
    logger.warn(e, "Error inserting the proposal");
  }

  try {
    await db.update(schema.proposalDetails)
      .set({ state: "deployed" })
      .where(eq(schema.proposalDetails.proposalAcct, dbProposal.proposalAcct));
  } catch (e) {
    logger.error(e, `Error updating Proposal Details ${dbProposal.proposalAcct} with proposal`);
  }

  //technically this can just check if it is not "" but this is more readable
  if (vaultStatus == "finalized" || vaultStatus == "reverted") {
    await calculateUserPerformance(proposal);
  }
  

  return null;

}

/**
 * Updates a proposal in the database
 * @param proposal 
 */
async function updateProposal(proposal: ProposalAccountWithKey, currentSlot: BN): Promise<Error | null> {

  if (!proposal.account.dao) return new Error(`No dao found for proposal ${proposal.publicKey.toString()}`);
  const dbDao: DaoRecord | undefined = (
    await db.select()
      .from(schema.daos)
      .where(eq(schema.daos.daoAcct, proposal.account.dao.toBase58()))
  )?.[0];

  if (!dbDao) return new Error(`No dao found for proposal in db ${proposal.publicKey.toString()}`);


  //update the proposal
  let vaultStatus = "";
  let status = ProposalStatus.Pending;
  if ('pending' in proposal.account.state) {
    status = ProposalStatus.Pending;
  } else if ('passed' in proposal.account.state) {
    status = ProposalStatus.Passed;
    vaultStatus = "finalized";
  } else if ('failed' in proposal.account.state) {
    status = ProposalStatus.Failed;
    vaultStatus = "reverted";
  }

  const endedAt = getProposalEndTime(currentSlot, proposal.account.slotEnqueued, new BN(dbDao.slotsPerProposal?.toString() ?? '0'));

  const currentTime = new Date();
  try {
    await db.update(schema.proposals)
      .set({
        status,
        endedAt: endedAt,
        completedAt: status !== ProposalStatus.Pending ? currentTime : null,
        updatedAt: sql`NOW()`
      })
      .where(
        eq(schema.proposals.proposalAcct, proposal.publicKey.toString())
      );


    if (vaultStatus) {
      await db.update(schema.conditionalVaults)
        .set({ status: vaultStatus })
        .where(
          or(
            eq(
              schema.conditionalVaults.condVaultAcct,
              proposal.account.quoteVault.toString()
            ),
            eq(
              schema.conditionalVaults.condVaultAcct,
              proposal.account.baseVault.toString()
            )
          )
      );
      await calculateUserPerformance(proposal);

    }
    await updateMarketsWithProposal(proposal);
  } catch (e) {
    logger.error(e, "Error updating the proposal");
  }
  return null;
}

async function insertVault(vaultAcct: PublicKey, vaultStatus: string) {

  const storedBaseVault = await conditionalVaultClient.getVault(
    vaultAcct
  );

  const passMint: PublicKey = storedBaseVault.conditionalOnFinalizeTokenMint;
  const failMint: PublicKey = storedBaseVault.conditionalOnRevertTokenMint;

  let vault: ConditionalVaultRecord = {
    condVaultAcct: vaultAcct.toString(),
    settlementAuthority: storedBaseVault.settlementAuthority.toString(),
    underlyingMintAcct: storedBaseVault.underlyingTokenMint.toString(),
    underlyingTokenAcct: storedBaseVault.underlyingTokenAccount.toString(),
    condFinalizeTokenMintAcct: passMint.toString(),
    condRevertTokenMintAcct: failMint.toString(),
    status: vaultStatus,
  };

  try {
    await db.insert(schema.conditionalVaults)
      .values(vault)
      .onConflictDoNothing();
  } catch (e) {
    logger.warn(e, "Error inserting the vault");
  }

}


async function insertAssociatedAccountsDataForProposal(
  proposal: ProposalAccountWithKey,
  dao: DaoRecord
): Promise<Error | null> {

  const currentTime = new Date();
  const daoAcct = proposal.account.dao;
  if (!daoAcct) return new Error("No dao found for proposal");

  let daoDetails;

  const daoId = dao.daoId;
  if (daoId) {
    const daoDetailsRes = await db.select()
      .from(schema.daoDetails)
      .where(eq(schema.daoDetails.daoId, daoId));

    if (daoDetailsRes && daoDetailsRes.length) {
      daoDetails = daoDetailsRes[0];
    }
  }

  const baseTokenMetadata = await enrichTokenMetadata(
    new PublicKey(dao.baseAcct),
    provider
  );


  //get our vaults so we can get the pass and fail mints
  const storedBaseVault = await conditionalVaultClient.getVault(proposal.account.baseVault);
  const storedQuoteVault = await conditionalVaultClient.getVault(proposal.account.quoteVault);

  //get our pass and fail mints
  const basePass: PublicKey = storedBaseVault.conditionalOnFinalizeTokenMint;
  const baseFail: PublicKey = storedBaseVault.conditionalOnRevertTokenMint;
  const quotePass: PublicKey = storedQuoteVault.conditionalOnFinalizeTokenMint;
  const quoteFail: PublicKey = storedQuoteVault.conditionalOnRevertTokenMint;

  //insert our tokens
  let tokensToInsert: TokenRecord[] = [];
  for (const token of [basePass, baseFail, quotePass, quoteFail]) {
    const isQuote = [quoteFail, quotePass].includes(token);
    const isFail = [quoteFail, baseFail].includes(token);

    await insertTokenAcct(token, isQuote, isFail, baseTokenMetadata.symbol, proposal.account.number, daoDetails);
  }

  //insert our token accounts
  let tokenAcctsToInsert: TokenAcctRecord[] = [];
  for (const [mint, owner] of [
    [basePass, proposal.account.passAmm],
    [baseFail, proposal.account.failAmm],
    [quotePass, proposal.account.passAmm],
    [quoteFail, proposal.account.failAmm],
  ]) {
    if (!mint || !owner) continue;
    let tokenAcct: TokenAcctRecord = {
      mintAcct: mint.toString(),
      updatedAt: currentTime,
      tokenAcct: getAssociatedTokenAddressSync(mint, owner, true).toString(),
      ownerAcct: owner.toString(),
      amount: await getAccount(
        provider.connection,
        getAssociatedTokenAddressSync(mint, owner, true)
      ).then((account) => account.amount.toString()),
    };
    tokenAcctsToInsert.push(tokenAcct);
  }

  try {
    await db.insert(schema.tokenAccts)
      .values(tokenAcctsToInsert)
      .onConflictDoNothing();
  } catch (e) {
    logger.warn(e, "Error inserting the token accounts");
  }

  //done with token accounts

  //check if we have pass and fail amms
  if (!proposal.account.passAmm || !proposal.account.failAmm) return new Error("Missing pass or fail amm");

  //insert our markets
  let passMarket: MarketRecord = {
    marketAcct: proposal.account.passAmm.toString(),
    //proposalAcct: proposal.publicKey.toString(),
    marketType: MarketType.FUTARCHY_AMM,
    createTxSig: "",
    baseMintAcct: storedBaseVault.conditionalOnFinalizeTokenMint.toString(),
    quoteMintAcct: storedQuoteVault.conditionalOnFinalizeTokenMint.toString(),
    baseLotSize: "1",
    quoteLotSize: "1",
    quoteTickSize: "1",
    bidsTokenAcct: getAssociatedTokenAddressSync(quotePass, proposal.account.passAmm, true).toString(),
    asksTokenAcct: getAssociatedTokenAddressSync(basePass, proposal.account.passAmm, true).toString(),
    baseMakerFee: 0,
    baseTakerFee: 100,
    quoteMakerFee: 0,
    quoteTakerFee: 100,
  };

  let failMarket: MarketRecord = {
    marketAcct: proposal.account.failAmm.toString(),
    //proposalAcct: proposal.publicKey.toString(),
    marketType: MarketType.FUTARCHY_AMM,
    createTxSig: "",
    baseMintAcct: storedBaseVault.conditionalOnRevertTokenMint.toString(),
    quoteMintAcct: storedQuoteVault.conditionalOnRevertTokenMint.toString(),
    baseLotSize: "1",
    quoteLotSize: "1",
    quoteTickSize: "1",
    bidsTokenAcct: getAssociatedTokenAddressSync(quoteFail, proposal.account.failAmm, true).toString(),
    asksTokenAcct: getAssociatedTokenAddressSync(baseFail, proposal.account.failAmm, true).toString(),
    baseMakerFee: 0,
    baseTakerFee: 100,
    quoteMakerFee: 0,
    quoteTakerFee: 100,
  };

  try {
    await db
      .insert(schema.markets)
      .values(passMarket)
      .onConflictDoNothing();

    await db
      .insert(schema.markets)
      .values(failMarket)
      .onConflictDoNothing();
  } catch (e) {
    logger.warn(e, "Error inserting the markets");
  }

  return null;
}


async function insertTokenAcct(token: PublicKey, isQuote: boolean, isFail: boolean, baseTokenSymbol: string, proposalAccountNumber: number, daoDetails?: any) {

  const metadata = await enrichTokenMetadata(token, provider);
  const storedMint = await getMint(provider.connection, token);

  // NOTE: THIS IS ONLY FOR PROPOSALS AND ONLY FOR BASE / QUOTE CONDITIONAL
  let imageUrl, defaultSymbol, defaultName;

  let passOrFailPrefix = isFail ? "f" : "p";
  // TODO: This MAY have issue with devnet...
  let baseSymbol = isQuote ? "USDC" : baseTokenSymbol;
  defaultSymbol = passOrFailPrefix + baseSymbol;
  defaultName = `Proposal ${proposalAccountNumber}: ${defaultSymbol}`;

  if (isQuote) {
    // Fail / Pass USDC
    imageUrl = isFail ? failImgUrl : passImgUrl;
  } else if (daoDetails) {
    // Base Token
    imageUrl = isFail ? daoDetails.fail_token_image_url : daoDetails.pass_token_image_url;
  }

  let tokenToInsert: TokenRecord = {
    symbol: metadata.symbol && !metadata.isFallback ? metadata.symbol : defaultSymbol,
    name: metadata.name && !metadata.isFallback ? metadata.name : defaultName,
    decimals: metadata.decimals,
    mintAcct: token.toString(),
    supply: storedMint.supply.toString(),
    imageUrl: imageUrl ? imageUrl : "",
    updatedAt: new Date(),
  };

  try {
    await db
      .insert(schema.tokens)
      .values(tokenToInsert)
      .onConflictDoNothing();
  } catch (e) {
    logger.warn(e, "Error inserting the token");
  }

}

function getProposalEndTime(currentSlot: BN, initialSlot: BN, slotsPerProposal: BN): Date {
  const currentTime = new Date();
  const slotDifference = initialSlot
    .add(slotsPerProposal)
    .sub(currentSlot);

  // Setup time to add to the date..
  const timeLeftSecondsEstimate = (slotDifference.toNumber() * 400) / 1000 // MS to seconds
  const endedAt = new Date(currentTime.toUTCString());

  endedAt.setSeconds(endedAt.getSeconds() + timeLeftSecondsEstimate); // setSeconds accepts float and will increase to hours etc.
  return endedAt;

}

async function updateMarketsWithProposal(
  proposal: ProposalAccountWithKey,
) {

  if (!proposal.account.passAmm || !proposal.account.failAmm) {
    logger.error(new Error(`Missing pass or fail amm for proposal ${proposal.publicKey.toString()}`));
    return;
  }

  try {
    await db.update(schema.markets)
      .set({
        proposalAcct: proposal.publicKey.toString(),
      })
    .where(
      or(
        eq(schema.markets.marketAcct, proposal.account.passAmm.toString()),
        eq(schema.markets.marketAcct, proposal.account.failAmm.toString())
      )
    )
      .execute();
  } catch (e) {
    logger.error(e, "Error updating the markets");
  }
}



type UserPerformanceTotals = {
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


async function calculateUserPerformance(onChainProposal: ProposalAccountWithKey) {
  const quoteTokens = alias(schema.tokens, "quote_tokens"); // NOTE: This should be USDC for now
  const baseTokens = alias(schema.tokens, "base_tokens");
  // calculate performance
  const [proposal] = await db.select()
        .from(schema.proposals)
        .where(
          eq(
            schema.proposals.proposalAcct,
            onChainProposal.publicKey.toString()
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

  if (!proposal) return;

  const { proposals, daos, quote_tokens, base_tokens } = proposal;

  let proposalDaoAcct = daos?.daoAcct;

  if (!proposals) return;

  if (!proposalDaoAcct) {
    proposalDaoAcct = proposals.daoAcct;
  }

  if (!proposalDaoAcct) {
    logger.error("No daoAcct found");
    return;
  }

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

    // NOTE: Directionally orients our last leg
    const needsSellToExit = values.tokensBoughtResolvingMarket > values.tokensSoldResolvingMarket; // boolean

    // We need to complete the round trip / final leg
    if (tradeSizeDelta !== 0) {
      // TODO: This needs to be revised given the spot price can't be null or 0 if we want to really do this
      const lastLegNotional = tradeSizeDelta * Number(spotPrice[0]?.price ?? "0");

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
      proposalAcct: onChainProposal.publicKey.toString(),
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
