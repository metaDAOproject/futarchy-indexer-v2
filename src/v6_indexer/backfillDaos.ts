import { schema, db, DBTransaction, inArray } from "@metadaoproject/indexer-db";
import {
  futarchyClient,
} from "./connection";
import { PublicKey } from "@solana/web3.js";
import * as token from "@solana/spl-token";
import { insertTokenIfNotExists } from "./utils";
  
import { log } from "../logger/logger";

const logger = log.child({
  module: "v6_backfillDaos"
});

export async function backfillDaos(): Promise<{message:string, error: Error | undefined}> {
  logger.info(`Backfilling all DAOs from chain`);
  
  // Fetch all DAOs from chain
  const daos = await futarchyClient.autocrat.account.dao.all();
  
  logger.info(`Found ${daos.length} DAOs on chain`);

  if (daos.length === 0) {
    return { message: `No DAOs found on chain`, error: undefined };
  }

  // Extract DAO addresses for bulk queries
  const daoAddrs = daos.map(dao => dao.publicKey.toBase58());

  // Bulk fetch existing DAOs
  const existingDaos = await db.select()
    .from(schema.v0_6_daos)
    .where(inArray(schema.v0_6_daos.daoAddr, daoAddrs));

  // Create lookup map for efficient comparison
  const existingDaosMap = new Map(existingDaos.map(dao => [dao.daoAddr, dao]));

  // Prepare data for batch operations
  const daosToInsert: any[] = [];

  let count = 0;
  // Process each DAO
  for (const dao of daos) {
    count++;
    logger.info(`Processing DAO ${count} of ${daos.length}: ${dao.publicKey.toBase58()}`);
    
    const daoAddr = dao.publicKey.toBase58();
    const existingDao = existingDaosMap.get(daoAddr);

    if (existingDao) {
      logger.debug(`DAO already exists: ${daoAddr}`);
    } else {
      // New DAO to insert
      logger.info(`Preparing to insert new DAO ${daoAddr}`);
      
      // Ensure tokens exist first
      await insertTokenIfNotExists(db, dao.account.baseMint);
      await insertTokenIfNotExists(db, dao.account.quoteMint);
      
      daosToInsert.push({
        daoAddr,
        nonce: BigInt(dao.account.nonce.toString()),
        daoCreator: dao.account.daoCreator.toString(),
        pdaBump: dao.account.pdaBump,
        squadsMultisig: dao.account.squadsMultisig.toString(),
        squadsMultisigVault: dao.account.squadsMultisigVault.toString(),
        baseMintAcct: dao.account.baseMint.toString(),
        quoteMintAcct: dao.account.quoteMint.toString(),
        proposalCount: 0,
        passThresholdBps: dao.account.passThresholdBps,
        secondsPerProposal: dao.account.secondsPerProposal,
        twapInitialObservation: dao.account.twapInitialObservation.toString(),
        twapMaxObservationChangePerUpdate: dao.account.twapMaxObservationChangePerUpdate.toString(),
        twapStartDelaySeconds: dao.account.twapStartDelaySeconds,
        minQuoteFutarchicLiquidity: BigInt(dao.account.minQuoteFutarchicLiquidity.toString()),
        minBaseFutarchicLiquidity: BigInt(dao.account.minBaseFutarchicLiquidity.toString()),
        baseToStake: BigInt(dao.account.baseToStake?.toString() || '0'),
        seqNum: BigInt(dao.account.seqNum.toString()),
        initialSpendingLimit: dao.account.initialSpendingLimit || null,
        ammBaseAmount: 0n,
        ammQuoteAmount: 0n, 
        ammVaultAtaBase: token.getAssociatedTokenAddressSync(
          dao.account.baseMint,
          new PublicKey(dao.account.amm.ammBaseVault.toString()),
          true
        ).toString(),
        ammVaultAtaQuote: token.getAssociatedTokenAddressSync(
          dao.account.quoteMint,
          new PublicKey(dao.account.amm.ammQuoteVault.toString()),
          true
        ).toString(),
        createdAt: new Date(),
      });
    }
  }

  // Execute batch operations
  let insertedCount = 0;

  if (daosToInsert.length > 0) {
    await db.transaction(async (trx: DBTransaction) => {
      // Batch insert new DAOs
      await trx.insert(schema.v0_6_daos).values(daosToInsert).onConflictDoNothing();
      insertedCount = daosToInsert.length;
      logger.info(`Inserted ${insertedCount} new DAOs`);
    });
  }

  logger.info(`DAO backfill completed: ${insertedCount} inserted, ${daos.length - insertedCount} already existed`);

  return { 
    message: `DAO backfill completed: ${insertedCount} inserted, ${daos.length - insertedCount} already existed`, 
    error: undefined 
  };
}