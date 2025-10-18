import { schema, db, and, DBTransaction, eq, inArray } from "@metadaoproject/indexer-db";
import {
  launchpadClient,
} from "./connection";
  
import { log } from "../logger/logger";

const logger = log.child({
  module: "v6_backfillMissing"
});

type DBConnection = any; // TODO: Fix typing..

export async function backfillMissing(launchAddr: string): Promise<{message:string, error: Error | undefined}> {
  logger.info(`Backfilling funding records for launch ${launchAddr}`);
  
  // Fetch all funding records from chain
  const fundingRecords = await launchpadClient.launchpad.account.fundingRecord.all();
  const filteredFundingRecords = fundingRecords.filter(fundingRecord => fundingRecord.account.launch.toBase58() === launchAddr);

  logger.info(`Found ${filteredFundingRecords.length} funding records for launch ${launchAddr}`);

  if (filteredFundingRecords.length === 0) {
    return { message: `No funding records found for launch ${launchAddr}`, error: undefined };
  }

  // Extract funding record addresses for bulk queries
  const fundingRecordAddrs = filteredFundingRecords.map(fr => fr.publicKey.toBase58());

  // Bulk fetch existing data
  const [existingFunds, existingFundingRecords, existingLaunch] = await Promise.all([
    // Get all existing funds for these funding records
    db.select()
      .from(schema.v0_6_funds)
      .where(inArray(schema.v0_6_funds.fundingRecordAddr, fundingRecordAddrs)),
    
    // Get all existing funding records
    db.select()
      .from(schema.v0_6_funding_records)
      .where(inArray(schema.v0_6_funding_records.fundingRecordAddr, fundingRecordAddrs)),
    
    // Check if launch exists
    db.select()
      .from(schema.v0_6_launches)
      .where(eq(schema.v0_6_launches.launchAddr, launchAddr))
      .limit(1)
  ]);

  if (existingLaunch.length === 0) {
    logger.warn(`Launch ${launchAddr} does not exist, manual intervention needed`);
    return { message: `Launch ${launchAddr} does not exist`, error: new Error("Launch not found") };
  }

  // TODO: Check the funding records too...

  // Create lookup maps for efficient comparison
  const existingFundsMap = new Map(existingFunds.map(fund => [fund.fundingRecordAddr, fund]));
  const existingFundingRecordsMap = new Map(existingFundingRecords.map(record => [record.fundingRecordAddr, record]));

  // Prepare data for batch operations
  const fundingRecordsToInsert: any[] = [];
  const fundingRecordsToUpdate: any[] = [];

  let count = 0;
  // Process each funding record
  for (const fundingRecord of filteredFundingRecords) {
    count++;
    logger.debug(`Processing funding record ${count} of ${filteredFundingRecords.length} for launch ${launchAddr}`);
    const fundingRecordAddr = fundingRecord.publicKey.toBase58();
    const existingFund = existingFundsMap.get(fundingRecordAddr);
    const existingFundingRecord = existingFundingRecordsMap.get(fundingRecordAddr);

    if (existingFund) {
      logger.debug(`Fund already exists for funding record ${fundingRecordAddr}`);
      
      if (existingFundingRecord) {
        const newCommittedAmount = BigInt(fundingRecord.account.committedAmount.toString());
        
        // Check if we need to update the committed amount
        if (
          existingFundingRecord.committedAmount !== newCommittedAmount &&
          existingFundingRecord.committedAmount <= newCommittedAmount
        ) {
          logger.info(`Committed amount for funding record ${fundingRecordAddr} needs to be updated from ${existingFundingRecord.committedAmount} to ${newCommittedAmount}`);
          
          fundingRecordsToUpdate.push({
            fundingRecordAddr,
            committedAmount: newCommittedAmount,
            isTokensClaimed: fundingRecord.account.isTokensClaimed,
            isUsdcRefunded: fundingRecord.account.isUsdcRefunded,
          });
        } else {
          logger.debug(`Committed amount for funding record ${fundingRecordAddr} is up to date`);
        }
      } else {
        logger.warn(`Funding record ${fundingRecordAddr} does not exist, manual intervention needed`);
      }
    } else {
      
      if (existingFundingRecord) {
        const newCommittedAmount = BigInt(fundingRecord.account.committedAmount.toString());
        
        // Check if we need to update the committed amount
        if (
          existingFundingRecord.committedAmount !== newCommittedAmount &&
          existingFundingRecord.committedAmount <= newCommittedAmount
        ) {
          logger.info(`Committed amount for funding record ${fundingRecordAddr} needs to be updated from ${existingFundingRecord.committedAmount} to ${newCommittedAmount}`);
          
          fundingRecordsToUpdate.push({
            fundingRecordAddr,
            committedAmount: newCommittedAmount,
            isTokensClaimed: fundingRecord.account.isTokensClaimed,
            isUsdcRefunded: fundingRecord.account.isUsdcRefunded,
          });
        } else {
          logger.debug(`Committed amount for funding record ${fundingRecordAddr} is up to date`);
        }
      } else {
        // New funding record to insert
        logger.info(`Preparing to insert new funding record ${fundingRecordAddr}`);
        fundingRecordsToInsert.push({
          fundingRecordAddr,
          launchAddr: fundingRecord.account.launch.toBase58(),
          funderAddr: fundingRecord.account.funder.toBase58(),
          committedAmount: BigInt(fundingRecord.account.committedAmount.toString()),
          seqNum: BigInt(0),
          isTokensClaimed: fundingRecord.account.isTokensClaimed,
          isUsdcRefunded: fundingRecord.account.isUsdcRefunded,
          updatedAtSlot: BigInt(0),
        });
      }
      
    }
  }

  // Execute batch operations
  let insertedCount = 0;
  let updatedCount = 0;

  if (fundingRecordsToInsert.length > 0 || fundingRecordsToUpdate.length > 0) {
    await db.transaction(async (trx: DBTransaction) => {
      // Batch insert new funding records
      if (fundingRecordsToInsert.length > 0) {
        await trx.insert(schema.v0_6_funding_records).values(fundingRecordsToInsert).onConflictDoNothing();
        insertedCount = fundingRecordsToInsert.length;
        logger.info(`Inserted ${insertedCount} new funding records`);
      }

      // Batch update existing funding records
      if (fundingRecordsToUpdate.length > 0) {
        for (const updateData of fundingRecordsToUpdate) {
          await trx.update(schema.v0_6_funding_records)
            .set({
              committedAmount: updateData.committedAmount,
              isTokensClaimed: updateData.isTokensClaimed,
              isUsdcRefunded: updateData.isUsdcRefunded,
            })
            .where(eq(schema.v0_6_funding_records.fundingRecordAddr, updateData.fundingRecordAddr));
        }
        updatedCount = fundingRecordsToUpdate.length;
        logger.info(`Updated ${updatedCount} existing funding records`);
      }
    });
  }

  const totalProcessed = insertedCount + updatedCount;
  logger.info(`Backfill completed: ${insertedCount} inserted, ${updatedCount} updated, ${totalProcessed} total processed`);

  return { 
    message: `Backfill completed for launch ${launchAddr}: ${insertedCount} inserted, ${updatedCount} updated`, 
    error: undefined 
  };
}