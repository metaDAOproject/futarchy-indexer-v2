import { Dao } from "@metadaoproject/futarchy-sdk/dist/types";
import { connection, rpcReadClient } from "../connection";
import { DaoRecord, TokenRecord } from "@metadaoproject/indexer-db/lib/schema";
import { schema, db } from "@metadaoproject/indexer-db";
import { log } from "src/logger/logger";
import { getMint } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

const logger = log.child({
  module: "backfill-daos"
});


/********************************************************************************
 * 
 *  These functions are for backfilling data from onchain data via RPC.  
 * 
 * These ensure on startup that data is correct and periodically that data is correct.
 * 
 *********************************************************************************/

/**
 * Backfills all on-chain DAOs to the database.
 * 
 * This inserts all of the daos, with an onconflict that updates the dao.
 * 
 * Daos that are missing from the database are added to the backfill list to get old historical data
 */
export async function backfillDaos():Promise<{message:string, error: Error | undefined}> {

  //get the daos from the chain
  const startTime = performance.now()
  logger.info("Backfilling daos");
  const onChainAggregates = await rpcReadClient.daos.fetchAllDaos();
  logger.info(`Found ${onChainAggregates.length} daos on chain`);

  let errorsResult: Error[] = [];
  
  for (const daoAggregate of onChainAggregates) {
    //daoAggregate is a DAO with multiple daos in it
    //we need to backfill each dao in the aggregate
    let errors = await Promise.all(daoAggregate.daos.map(async (dao) => {
      return await addOrUpdateDao(dao);
    }));
    errors.forEach(err => {
      if (err) {
        logger.error(err);
        errorsResult.push(err);
      }
    });
  }

  const endTime = performance.now()
  const message = `Backfilling daos complete - took ${(endTime - startTime) / 1000} seconds`;
  logger.info(message);
  let errorMessage = "";
  for (const error of errorsResult) {
    errorMessage += error.toString() + '<br>';
  }

  return { message: message, error: errorMessage ? new Error(errorMessage) : undefined };
}

/********************************************************************************
 * 
 *  Private functions
 * 
 *********************************************************************************/

/**
 * Inserts or updates a dao into the database
 * @param dao the dao to insert or update
 * @returns 
 */
async function addOrUpdateDao(dao: Dao): Promise<Error | null> {

  if (
    dao.baseToken.publicKey == null ||
    dao.quoteToken.publicKey == null
  ) {

    const err = new Error("Unable to determine public key for dao tokens " + dao.publicKey.toString());
    logger.error(err);
    return err;
  }

  //insert the tokens
  await insertToken(dao.baseToken);
  await insertToken(dao.quoteToken);

  //build our dao db record
  let minBaseLiquidity = dao.daoAccount.minBaseFutarchicLiquidity ? dao.daoAccount.minBaseFutarchicLiquidity.toString() : 0;
  let minQuoteLiquidity = dao.daoAccount.minQuoteFutarchicLiquidity ? dao.daoAccount.minQuoteFutarchicLiquidity.toString() : 0;
  let twapInitialObservation = dao.daoAccount.twapInitialObservation ? dao.daoAccount.twapInitialObservation.toString() : 0;
  let twapMaxObservationChangePerUpdate = dao.daoAccount.twapMaxObservationChangePerUpdate ? dao.daoAccount.twapMaxObservationChangePerUpdate.toString() : 0;

  let daoToInsert: DaoRecord = {
    daoAcct: dao.publicKey.toBase58(),
    programAcct: dao.protocol.autocrat.programId.toString(),
    baseAcct: dao.baseToken.publicKey,
    quoteAcct: dao.quoteToken.publicKey,
    slotsPerProposal: dao.daoAccount.slotsPerProposal!.toString(),
    treasuryAcct: dao.daoAccount.treasury.toBase58(),
    minBaseFutarchicLiquidity: minBaseLiquidity.toString(),
    minQuoteFutarchicLiquidity: minQuoteLiquidity.toString(),
    passThresholdBps: BigInt(dao.daoAccount.passThresholdBps),
    twapInitialObservation: twapInitialObservation.toString(),
    twapMaxObservationChangePerUpdate: twapMaxObservationChangePerUpdate.toString(),
  };
  
  //bingo bango, insert the dao
  //we use onConflictDoUpdate to update the dao if it already exists
  try {
    let insertRes = await db.insert(schema.daos)
      .values(daoToInsert)
    .onConflictDoUpdate({
      set: {
        minBaseFutarchicLiquidity: daoToInsert.minBaseFutarchicLiquidity,
        minQuoteFutarchicLiquidity: daoToInsert.minQuoteFutarchicLiquidity,
        twapInitialObservation: daoToInsert.twapInitialObservation,
        twapMaxObservationChangePerUpdate: daoToInsert.twapMaxObservationChangePerUpdate,
        passThresholdBps: daoToInsert.passThresholdBps,
      },
      target: schema.daos.daoAcct,
    });
    if (insertRes.rowCount === 0) {
      const err = new Error("Failed to insert or update the dao");
      logger.error(err, "The database may need to be checked", insertRes);
      return err;
    }
  } catch (e) {
    logger.error(e, "Error inserting or updating the dao");
  }
  return null;
}

/**
 * Inserts a token into the database
 * @param token 
 */
async function insertToken(token: any) {
  const baseTokenMint = await getMint(
    connection,
    new PublicKey(token.publicKey)
  );

  // Puts the base tokens into the DB before we try to insert the dao
  let tr: TokenRecord = {
    symbol: token.symbol,
    name: token.name ? token.name : token.symbol,
    decimals: token.decimals,
    mintAcct: token.publicKey,
    supply: baseTokenMint.supply.toString(),
    updatedAt: new Date(),
  };

  //we dont care about the result kind of.   With onclictdonothing, we do not get a row count back
  try {
    await db.insert(schema.tokens).values(tr).onConflictDoNothing();
  } catch (e) {
    logger.warn(e, "Error inserting the token");
  }
}
