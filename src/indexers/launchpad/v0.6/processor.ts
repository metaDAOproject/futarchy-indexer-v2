import {
  LaunchpadEvent,
  LaunchInitializedEvent,
  LaunchClaimEvent,
  LaunchCompletedEvent,
  LaunchFundedEvent,
  LaunchRefundedEvent,
  LaunchStartedEvent,
  LaunchCloseEvent,
  v0_6_0_LaunchpadEvent,
  v0_6_0_LaunchInitializedEvent,
  v0_6_0_LaunchClaimEvent,
  v0_6_0_LaunchCompletedEvent,
  v0_6_0_LaunchFundedEvent,
  v0_6_0_LaunchRefundedEvent,
  v0_6_0_LaunchStartedEvent,
  v0_6_0_LaunchCloseEvent,
} from "@metadaoproject/futarchy/v0.6";
import { schema, db, eq, and, sql, DBTransaction } from "@metadaoproject/indexer-db";
import { PublicKey } from "@solana/web3.js";
import type { VersionedTransactionResponse } from "@solana/web3.js";
import { V06LaunchState } from "@metadaoproject/indexer-db/lib/schema";
import * as token from "@solana/spl-token";
import { futarchyClient, launchpadClient } from "../../../connections/v0.6";
import { insertTokenIfNotExists } from "../../shared/utils";
import { log } from "../../../logger/logger";
import { BN } from "@coral-xyz/anchor";

const logger = log.child({
  module: "launchpad-v0.6-processor"
});

type DBConnection = any;

export async function processLaunchpadEvent(
  event: { name: string; data: LaunchpadEvent | v0_6_0_LaunchpadEvent },
  signature: string,
  transactionResponse: VersionedTransactionResponse
) {
  switch (event.name) {
    case "LaunchClaimEvent":
      await handleLaunchClaimEvent(event.data as LaunchClaimEvent | v0_6_0_LaunchClaimEvent, signature, transactionResponse);
      break;
    case "LaunchCompletedEvent":
      await handleLaunchCompletedEvent(event.data as LaunchCompletedEvent | v0_6_0_LaunchCompletedEvent, signature, transactionResponse);
      break;
    case "LaunchFundedEvent":
      await handleLaunchFundedEvent(event.data as LaunchFundedEvent | v0_6_0_LaunchFundedEvent, signature, transactionResponse);
      break;
    case "LaunchInitializedEvent":
      await handleLaunchInitializedEvent(event.data as LaunchInitializedEvent | v0_6_0_LaunchInitializedEvent, signature, transactionResponse);
      break;
    case "LaunchRefundedEvent":
      await handleLaunchRefundedEvent(event.data as LaunchRefundedEvent | v0_6_0_LaunchRefundedEvent, signature, transactionResponse);
      break;
    case "LaunchStartedEvent":
      await handleLaunchStartedEvent(event.data as LaunchStartedEvent | v0_6_0_LaunchStartedEvent, signature, transactionResponse);
      break;
    case "LaunchCloseEvent":
      await handleLaunchCloseEvent(event.data as LaunchCloseEvent | v0_6_0_LaunchCloseEvent, signature, transactionResponse);
      break;
    default:
      logger.info({ eventName: event.name }, "Unknown Launchpad event");
  }
}

async function handleLaunchClaimEvent(event: LaunchClaimEvent | v0_6_0_LaunchClaimEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      const [existingClaim] = await trx.select()
        .from(schema.v0_6_claims)
        .where(and(
          eq(schema.v0_6_claims.launchAddr, event.launch.toString()),
          eq(schema.v0_6_claims.funderAddr, event.funder.toString()),
          eq(schema.v0_6_claims.slot, BigInt(event.common.slot.toString()))
        ))
        .limit(1);

      if (existingClaim) {
        logger.info(`Claim already exists for launch ${event.launch.toString()} by ${event.funder.toString()} at slot ${existingClaim.slot.toString()}`);
        return;
      }

      await trx.insert(schema.v0_6_claims).values({
        fundingRecordAddr: event.fundingRecord.toString(),
        launchAddr: event.launch.toString(),
        funderAddr: event.funder.toString(),
        tokensClaimed: event.tokensClaimed.toString(),
        slot: BigInt(event.common.slot.toString()),
        timestamp: new Date(event.common.unixTimestamp.mul(new BN(1000)).toNumber()),
      }).onConflictDoNothing();

      await trx.update(schema.v0_6_funding_records).set({
        isTokensClaimed: true,
        updatedAtSlot: BigInt(event.common.slot.toString()),
      }).where(eq(schema.v0_6_funding_records.fundingRecordAddr, event.fundingRecord.toString()));
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchClaimEvent");
  }
}

async function handleLaunchCompletedEvent(event: LaunchCompletedEvent | v0_6_0_LaunchCompletedEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      const [existingLaunch] = await trx.select()
        .from(schema.v0_6_launches)
        .where(eq(schema.v0_6_launches.launchAddr, event.launch.toString()))
        .limit(1);

      if (existingLaunch && existingLaunch.updatedAtSlot > BigInt(event.common.slot.toString())) {
        logger.info(`Launch ${event.launch.toString()} already updated at slot ${existingLaunch.updatedAtSlot.toString()}`);
        return;
      }

      // Check if the launch is complete or refunding (Anchor enum variant check)
      const launchState = 'complete' in event.finalState ? V06LaunchState.Complete : V06LaunchState.Refunding;

      if (launchState === V06LaunchState.Complete && event.dao) {
        // Delay to allow chain state to settle
        await new Promise(resolve => setTimeout(resolve, 5000));
        const dao = await futarchyClient.fetchDao(event.dao);

        if (dao) {
          const [existingDao] = await trx.select()
            .from(schema.v0_6_daos)
            .where(eq(schema.v0_6_daos.daoAddr, event.dao.toString()))
            .limit(1);

          if (existingDao) {
            logger.info(`DAO ${event.dao.toString()} already exists, skipping creation`);
          } else {
            await insertTokenIfNotExists(trx, dao.quoteMint);
            await insertTokenIfNotExists(trx, dao.baseMint);

            await trx.insert(schema.v0_6_daos).values({
              daoAddr: event.dao.toString(),
              nonce: BigInt(dao.nonce.toString()),
              daoCreator: dao.daoCreator.toString(),
              pdaBump: dao.pdaBump,
              squadsMultisig: dao.squadsMultisig.toString(),
              squadsMultisigVault: dao.squadsMultisigVault.toString(),
              baseMintAcct: dao.baseMint.toString(),
              quoteMintAcct: dao.quoteMint.toString(),
              proposalCount: 0,
              passThresholdBps: dao.passThresholdBps,
              secondsPerProposal: dao.secondsPerProposal,
              twapInitialObservation: dao.twapInitialObservation.toString(),
              twapMaxObservationChangePerUpdate: dao.twapMaxObservationChangePerUpdate.toString(),
              twapStartDelaySeconds: dao.twapStartDelaySeconds,
              minQuoteFutarchicLiquidity: BigInt(dao.minQuoteFutarchicLiquidity.toString()),
              minBaseFutarchicLiquidity: BigInt(dao.minBaseFutarchicLiquidity.toString()),
              baseToStake: BigInt(dao.baseToStake?.toString() || '0'),
              seqNum: BigInt(dao.seqNum.toString()),
              initialSpendingLimit: dao.initialSpendingLimit || null,
              teamSponsoredPassThresholdBps: dao.teamSponsoredPassThresholdBps ?? 0,
              teamAddress: dao.teamAddress?.toString() ?? "",
              ammBaseAmount: 0n,
              ammQuoteAmount: 0n,
              ammVaultAtaBase: token.getAssociatedTokenAddressSync(
                dao.baseMint,
                new PublicKey(dao.amm.ammBaseVault.toString()),
                true
              ).toString(),
              ammVaultAtaQuote: token.getAssociatedTokenAddressSync(
                dao.quoteMint,
                new PublicKey(dao.amm.ammQuoteVault.toString()),
                true
              ).toString(),
              createdAt: new Date(),
            }).onConflictDoNothing();
          }
        }
      }

      // Fetch the launch account to get additional fields
      let launchUpdateData: Partial<typeof schema.v0_6_launches.$inferInsert> = {
        totalCommittedAmount: BigInt(event.totalCommitted.toString()),
        state: launchState,
        seqNum: BigInt(event.common.launchSeqNum.toString()),
        daoAddr: launchState === V06LaunchState.Complete ? event.dao?.toString() : null,
        updatedAtSlot: BigInt(event.common.slot.toString()),
      };

      // If launch is complete, fetch additional data from the launch account
      if (launchState === V06LaunchState.Complete) {
        try {
          const launchAccount = await launchpadClient.getLaunch(event.launch);
          if (launchAccount) {
            launchUpdateData = {
              ...launchUpdateData,
              finalRaiseAmount: launchAccount.finalRaiseAmount ? BigInt(launchAccount.finalRaiseAmount.toString()) : null,
              daoVault: launchAccount.daoVault?.toString(),
              performancePackageGrantee: launchAccount.performancePackageGrantee?.toString(),
              performancePackageTokenAmount: BigInt(launchAccount.performancePackageTokenAmount.toString()),
              monthsUntilInsidersCanUnlock: launchAccount.monthsUntilInsidersCanUnlock,
              monthlySpendingLimitAmount: BigInt(launchAccount.monthlySpendingLimitAmount.toString()),
              monthlySpendingLimitMembers: launchAccount.monthlySpendingLimitMembers?.map(pk => pk.toString()),
            };
          }
        } catch (fetchError) {
          logger.warn(`Could not fetch launch account data for ${event.launch.toString()}: ${fetchError}`);
        }
      }

      await trx.update(schema.v0_6_launches).set(launchUpdateData).where(eq(schema.v0_6_launches.launchAddr, event.launch.toString()));
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchCompletedEvent");
  }
}

async function handleLaunchFundedEvent(event: LaunchFundedEvent | v0_6_0_LaunchFundedEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      const [existingFund] = await trx.select()
        .from(schema.v0_6_funds)
        .where(and(
          eq(schema.v0_6_funds.fundingRecordAddr, event.fundingRecord.toString()),
          eq(schema.v0_6_funds.txSignature, signature)
        ))
        .limit(1);

      if (existingFund) {
        logger.info(`Fund already exists for funding record ${event.fundingRecord.toString()} with signature: ${signature}`);
        return;
      }

      let highestSquenceNumber = BigInt(event.common.launchSeqNum.toString())

      // Ensure the launch exists before inserting funding record
      const [existingLaunch] = await trx.select()
        .from(schema.v0_6_launches)
        .where(eq(schema.v0_6_launches.launchAddr, event.launch.toString()))
        .limit(1);

      if (!existingLaunch) {
        logger.warn(`Launch ${event.launch.toString()} does not exist, creating minimal record for funding event`);
        await trx.insert(schema.v0_6_launches).values({
          launchAddr: event.launch.toString(),
          seqNum: BigInt(event.common.launchSeqNum.toString()),
          state: V06LaunchState.Live, // Assume live since we're getting funding
          updatedAtSlot: BigInt(event.common.slot.toString()),
          minimumRaiseAmount: 0n,
          monthlySpendingLimitAmount: 0n,
          monthlySpendingLimitMembers: [],
          launchAuthority: "",
          launchSigner: "",
          launchSignerPdaBump: 0,
          launchQuoteVault: "",
          launchBaseVault: "",
          totalCommittedAmount: 0n,
          baseMintAcct: "",
          quoteMintAcct: "",
          pdaBump: 0,
          secondsForLaunch: 0,
          performancePackageGrantee: "",
          performancePackageTokenAmount: 0n,
          monthsUntilInsidersCanUnlock: 0,
        }).onConflictDoNothing();
      }

      await trx.insert(schema.v0_6_funding_records).values({
        fundingRecordAddr: event.fundingRecord.toString(),
        launchAddr: event.launch.toString(),
        funderAddr: event.funder.toString(),
        committedAmount: BigInt(event.totalCommittedByFunder.toString()),
        seqNum: BigInt(event.common.launchSeqNum.toString()),
        isTokensClaimed: false,
        isUsdcRefunded: false,
        updatedAtSlot: BigInt(event.common.slot.toString()),
      }).onConflictDoUpdate({
        target: schema.v0_6_funding_records.fundingRecordAddr,
        set: {
          committedAmount: sql`CASE WHEN ${BigInt(event.common.slot.toString())} >= ${schema.v0_6_funding_records.updatedAtSlot} THEN ${BigInt(event.totalCommittedByFunder.toString())} ELSE ${schema.v0_6_funding_records.committedAmount} END`,
          seqNum: sql`CASE WHEN ${BigInt(event.common.slot.toString())} >= ${schema.v0_6_funding_records.updatedAtSlot} THEN ${BigInt(event.common.launchSeqNum.toString())} ELSE ${schema.v0_6_funding_records.seqNum} END`,
          updatedAtSlot: sql`GREATEST(${BigInt(event.common.slot.toString())}, ${schema.v0_6_funding_records.updatedAtSlot})`
        }
      });

      await trx.insert(schema.v0_6_funds).values({
        fundingRecordAddr: event.fundingRecord.toString(),
        txSignature: signature,
        launchAddr: event.launch.toString(),
        funderAddr: event.funder.toString(),
        slot: BigInt(event.common.slot.toString()),
        timestamp: new Date(event.common.unixTimestamp.mul(new BN(1000)).toNumber()),
        quoteAmount: event.amount.toString(),
      }).onConflictDoNothing({
        target: [schema.v0_6_funds.fundingRecordAddr, schema.v0_6_funds.txSignature]
      });

      if (existingLaunch && highestSquenceNumber > existingLaunch.seqNum) {
        await trx.update(schema.v0_6_launches).set({
          totalCommittedAmount: BigInt(event.totalCommitted.toString()),
          seqNum: BigInt(event.common.launchSeqNum.toString()),
        }).where(eq(schema.v0_6_launches.launchAddr, event.launch.toString()));
      }
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchFundedEvent");
  }
}

async function handleLaunchInitializedEvent(event: LaunchInitializedEvent | v0_6_0_LaunchInitializedEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      const [existingLaunch] = await trx.select()
        .from(schema.v0_6_launches)
        .where(eq(schema.v0_6_launches.launchAddr, event.launch.toString()))
        .limit(1);

      if (existingLaunch && existingLaunch.updatedAtSlot > BigInt(event.common.slot.toString())) {
        logger.info(`Launch ${event.launch.toString()} already exists with last updated slot ${existingLaunch.updatedAtSlot.toString()}`);
        return;
      }

      await insertTokenIfNotExists(trx, event.baseMint);

      // Check if this is the newer event format with additional fields
      const hasNewerFields = 'monthlySpendingLimitAmount' in event;

      await trx.insert(schema.v0_6_launches).values({
        launchAddr: event.launch.toString(),
        minimumRaiseAmount: BigInt(event.minimumRaiseAmount.toString()),
        monthlySpendingLimitAmount: hasNewerFields ? BigInt((event as LaunchInitializedEvent).monthlySpendingLimitAmount.toString()) : 0n,
        monthlySpendingLimitMembers: hasNewerFields ? (event as LaunchInitializedEvent).monthlySpendingLimitMembers.map(pk => pk.toString()) : [],
        launchAuthority: event.launchAuthority.toString(),
        launchSigner: event.launchSigner.toString(),
        launchSignerPdaBump: event.launchSignerPdaBump,
        launchQuoteVault: event.launchUsdcVault.toString(),
        launchBaseVault: event.launchTokenVault.toString(),
        baseMintAcct: event.baseMint.toString(),
        quoteMintAcct: event.quoteMint.toString(),
        totalCommittedAmount: 0n,
        state: V06LaunchState.Initialized,
        seqNum: 0n,
        secondsForLaunch: event.secondsForLaunch,
        performancePackageGrantee: hasNewerFields ? (event as LaunchInitializedEvent).performancePackageGrantee.toString() : "",
        performancePackageTokenAmount: hasNewerFields ? BigInt((event as LaunchInitializedEvent).performancePackageTokenAmount.toString()) : 0n,
        monthsUntilInsidersCanUnlock: hasNewerFields ? (event as LaunchInitializedEvent).monthsUntilInsidersCanUnlock : 0,
        pdaBump: event.pdaBump,
      }).onConflictDoNothing();
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchInitializedEvent");
  }
}

async function handleLaunchRefundedEvent(event: LaunchRefundedEvent | v0_6_0_LaunchRefundedEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      const [existingRefund] = await trx.select()
        .from(schema.v0_6_refunds)
        .where(and(
          eq(schema.v0_6_refunds.funderAddr, event.funder.toString()),
          eq(schema.v0_6_refunds.launchAddr, event.launch.toString()),
          eq(schema.v0_6_refunds.slot, BigInt(event.common.slot.toString()))
        ))
        .limit(1);

      if (existingRefund) {
        logger.info(`Refund already exists for launch ${event.launch.toString()} by ${event.funder.toString()} at slot ${existingRefund.slot.toString()}`);
        return;
      }

      await trx.insert(schema.v0_6_refunds).values({
        fundingRecordAddr: event.fundingRecord.toString(),
        launchAddr: event.launch.toString(),
        funderAddr: event.funder.toString(),
        slot: BigInt(event.common.slot.toString()),
        timestamp: new Date(event.common.unixTimestamp.mul(new BN(1000)).toNumber()),
        quoteAmount: event.usdcRefunded.toString(),
      }).onConflictDoNothing();

      await trx.update(schema.v0_6_funding_records).set({
        isUsdcRefunded: true,
        updatedAtSlot: BigInt(event.common.slot.toString()),
      }).where(eq(schema.v0_6_funding_records.fundingRecordAddr, event.fundingRecord.toString()));
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchRefundedEvent");
  }
}

async function handleLaunchStartedEvent(event: LaunchStartedEvent | v0_6_0_LaunchStartedEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      const [existingLaunch] = await trx.select()
        .from(schema.v0_6_launches)
        .where(eq(schema.v0_6_launches.launchAddr, event.launch.toString()))
        .limit(1);

      if (existingLaunch && existingLaunch.seqNum > BigInt(event.common.launchSeqNum.toString())) {
        logger.info(`Launch ${event.launch.toString()} already updated to seqNum ${existingLaunch.seqNum.toString()}`);
        return;
      }

      await trx.update(schema.v0_6_launches).set({
        state: V06LaunchState.Live,
        unixTimestampStarted: BigInt(event.common.unixTimestamp.toString()),
        seqNum: BigInt(event.common.launchSeqNum.toString()),
        updatedAtSlot: BigInt(event.slotStarted.toString()),
      }).where(eq(schema.v0_6_launches.launchAddr, event.launch.toString()));
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchStartedEvent");
  }
}

async function handleLaunchCloseEvent(event: LaunchCloseEvent | v0_6_0_LaunchCloseEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      const [existingLaunch] = await trx.select()
        .from(schema.v0_6_launches)
        .where(eq(schema.v0_6_launches.launchAddr, event.launch.toString()))
        .limit(1);

      if (existingLaunch && existingLaunch.seqNum > BigInt(event.common.launchSeqNum.toString())) {
        logger.info(`Launch ${event.launch.toString()} already updated to seqNum ${existingLaunch.seqNum.toString()}`);
        return;
      }

      // Map the newState from the event to V06LaunchState
      let mappedState: V06LaunchState;
      if ('closed' in event.newState) {
        mappedState = V06LaunchState.Closed;
      } else if ('refunding' in event.newState) {
        mappedState = V06LaunchState.Refunding;
      } else {
        mappedState = V06LaunchState.Complete; // Default fallback
      }

      await trx.update(schema.v0_6_launches).set({
        state: mappedState,
        unixTimestampClosed: BigInt(event.common.unixTimestamp.toString()),
        seqNum: BigInt(event.common.launchSeqNum.toString()),
        updatedAtSlot: BigInt(event.common.slot.toString()),
      }).where(eq(schema.v0_6_launches.launchAddr, event.launch.toString()));
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchCloseEvent");
  }
}

// Account update handlers (Launchpad accounts updated via Geyser stream)
export async function processLaunchpadAccountUpdate(
  pubkey: string,
  accountType: string,
  accountData: any,
  slot: bigint
) {
  switch (accountType) {
    case 'launch':
      logger.debug({ pubkey, slot: slot.toString() }, "Launch account update");
      // TODO: Add upsertLaunch function
      break;
    case 'fundingRecord':
      logger.debug({ pubkey, slot: slot.toString() }, "FundingRecord update");
      // TODO: Add upsertFundingRecord function
      break;
    default:
      logger.debug({ pubkey, accountType }, "Unknown Launchpad account type in update");
  }
}
