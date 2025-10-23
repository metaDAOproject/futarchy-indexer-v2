import { schema, db, eq, and, or, inArray } from "@metadaoproject/indexer-db";
import { futarchyClient, connection } from "./connection";
import { FUTARCHY_PROGRAM_ID } from "@metadaoproject/futarchy/v0.6";
import { PublicKey, ConfirmedSignatureInfo } from "@solana/web3.js";
import { log } from "../logger/logger";
import { index } from "./indexer";
import pLimit from "p-limit";

const logger = log.child({
  module: "v6_backfillStakingRecords"
});

const limit = pLimit(2); // Rate limiting for RPC calls
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Gap fill historical stake transactions by processing all stake-related signatures
 */
// TODO: if the stakes table grows sufficiently large in size like spot swaps, this will not be performant.
export async function gapFillStakeTransactions(): Promise<{message:string, error: Error | undefined}> {
  logger.info(`Gap filling all historical stake transactions`);
  
  try {
    // Get all stake accounts from chain to identify which proposals have stakes
    const stakeAccounts = await futarchyClient.autocrat.account.stakeAccount.all();
    logger.info(`Found ${stakeAccounts.length} stake accounts on chain`);
    
    // Extract unique proposal addresses that have stakes
    const proposalAddresses = [...new Set(stakeAccounts.map(s => s.account.proposal.toBase58()))];
    logger.info(`Found stakes across ${proposalAddresses.length} unique proposals`);
    
    let totalSignaturesProcessed = 0;
    let totalEventsProcessed = 0;
    
    // For each proposal, fetch all historical signatures
    for (const proposalAddr of proposalAddresses) {
      logger.info(`Processing historical transactions for proposal ${proposalAddr}`);
      
      const proposalPubkey = new PublicKey(proposalAddr);
      let signatures: ConfirmedSignatureInfo[] = [];
      let lastSignature: string | undefined;
      
      // Fetch all signatures for this proposal
      while (true) {
        const batch = await connection.getSignaturesForAddress(
          proposalPubkey,
          { 
            limit: 1000,
            before: lastSignature
          },
          "finalized"
        );
        
        if (batch.length === 0) break;
        
        signatures = signatures.concat(batch);
        lastSignature = batch[batch.length - 1].signature;
        
        logger.info(`Fetched ${signatures.length} signatures so far for proposal ${proposalAddr}`);
      }
      
      logger.info(`Found ${signatures.length} total signatures for proposal ${proposalAddr}`);
      
      // Process each signature to find stake events
      const tasks = [];
      for (const sigInfo of signatures) {
        const task = limit(async () => {
          try {
            // Use the indexer to process this transaction
            // This will run through your processor and handle stake events with correct PDAs
            await index(sigInfo.signature, FUTARCHY_PROGRAM_ID);
            totalSignaturesProcessed++;
            
            // Rate limiting
            await delay(100);
          } catch (error) {
            logger.warn(`Failed to process signature ${sigInfo.signature}: ${error}`);
          }
        });
        tasks.push(task);
      }
      
      await Promise.all(tasks);
      logger.info(`Processed ${totalSignaturesProcessed} signatures for proposal ${proposalAddr}`);
    }
    
    const message = `Gap fill completed: Processed ${totalSignaturesProcessed} signatures across ${proposalAddresses.length} proposals`;
    logger.info(message);
    
    return { 
      message, 
      error: undefined 
    };
  } catch (error) {
    logger.error(`Error in gap fill: ${error}`);
    return {
      message: `Error gap filling stake transactions`,
      error: error as Error
    };
  }
}

export async function backfillStakingRecords(): Promise<{message:string, error: Error | undefined}> {
  logger.info(`Backfilling all staking records from chain`);
  
  try {
    // Fetch all stake accounts from chain
    const stakeAccounts = await futarchyClient.autocrat.account.stakeAccount.all();
    
    logger.info(`Found ${stakeAccounts.length} stake accounts on chain`);

    if (stakeAccounts.length === 0) {
      return { message: `No stake accounts found on chain`, error: undefined };
    }

    let totalInserted = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;

    // Process each stake account
    for (const stakeAccount of stakeAccounts) {
      const stakeAddr = stakeAccount.publicKey.toBase58();
      const proposalAddr = stakeAccount.account.proposal.toBase58();
      const stakerAddr = stakeAccount.account.staker.toBase58();
      const totalStaked = stakeAccount.account.amount.toString();
      
      logger.info(`Processing stake account: ${stakeAddr} for staker ${stakerAddr} on proposal ${proposalAddr}`);
      
      // Check if staking record already exists
      const existingRecord = await db.select()
        .from(schema.v0_6_staking_record)
        .where(eq(schema.v0_6_staking_record.stakeAddr, stakeAddr))
        .limit(1);

      if (existingRecord.length === 0) {
        // Get current slot from the connection
        let latestSlot = 0n;
        try {
          const currentSlot = await connection.getSlot();
          latestSlot = BigInt(currentSlot);
          logger.info(`Using current slot ${latestSlot} for stake account ${stakeAddr}`);
        } catch (error) {
          logger.warn(`Could not fetch current slot for ${stakeAddr}: ${error}`);
        }
        
        // Insert new staking record with actual slot
        try {
          await db.insert(schema.v0_6_staking_record).values({
            stakeAddr,
            proposalAddr,
            stakerAddr,
            totalStaked,
            updatedAtSlot: latestSlot,
            createdAt: new Date(),
          });
          
          totalInserted++;
          logger.info(`Inserted staking record for ${stakerAddr} on proposal ${proposalAddr} at slot ${latestSlot}`);
        } catch (error) {
          logger.error(`Failed to insert staking record ${stakeAddr}: ${error}`);
        }
      } else {
        // Check if we need to update the total staked amount
        const existingAmount = existingRecord[0].totalStaked;
        if (existingAmount !== totalStaked) {
          // Get current slot from the connection
          let latestSlot = existingRecord[0].updatedAtSlot || 0n;
          try {
            const currentSlot = await connection.getSlot();
            latestSlot = BigInt(currentSlot);
          } catch (error) {
            logger.warn(`Could not fetch current slot for update of ${stakeAddr}: ${error}`);
          }
          
          await db.update(schema.v0_6_staking_record)
            .set({ 
              totalStaked,
              updatedAtSlot: latestSlot
            })
            .where(eq(schema.v0_6_staking_record.stakeAddr, stakeAddr));
          
          totalUpdated++;
          logger.info(`Updated staking record for ${stakerAddr} on proposal ${proposalAddr}: ${existingAmount} -> ${totalStaked} at slot ${latestSlot}`);
        } else {
          totalSkipped++;
          logger.debug(`Staking record already up to date for ${stakerAddr} on proposal ${proposalAddr}`);
        }
      }
    }

    const message = `Staking records backfill completed: ${totalInserted} inserted, ${totalUpdated} updated, ${totalSkipped} skipped`;
    logger.info(message);

    return { 
      message, 
      error: undefined 
    };
  } catch (error) {
    logger.error(`Error in backfillStakingRecords: ${error}`);
    return {
      message: `Error backfilling staking records`,
      error: error as Error
    };
  }
}

/**
 * Complete backfill and gap fill for all staking data
 * This ensures we have:
 * 1. All current stake account states from chain (backfill)
 * 2. All historical stake/unstake transactions (gap fill)
 */
export async function completeStakingDataRecovery(): Promise<{message:string, error: Error | undefined}> {
  logger.info(`Starting complete staking data recovery (backfill + gap fill)`);
  
  try {
    // First, backfill current state from chain
    logger.info(`Step 1: Backfilling current stake states from chain`);
    const backfillResult = await backfillStakingRecords();
    if (backfillResult.error) {
      return {
        message: `Backfill failed: ${backfillResult.message}`,
        error: backfillResult.error
      };
    }
    
    // Then, gap fill historical transactions
    logger.info(`Step 2: Gap filling historical stake transactions`);
    const gapFillResult = await gapFillStakeTransactions();
    if (gapFillResult.error) {
      return {
        message: `Gap fill failed: ${gapFillResult.message}`,
        error: gapFillResult.error
      };
    }
    
    const message = `Complete staking data recovery successful!\n${backfillResult.message}\n${gapFillResult.message}`;
    logger.info(message);
    
    return {
      message,
      error: undefined
    };
  } catch (error) {
    logger.error(`Error in complete staking data recovery: ${error}`);
    return {
      message: `Error in complete staking data recovery`,
      error: error as Error
    };
  }
}