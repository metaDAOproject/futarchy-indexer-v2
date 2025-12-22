import {
  LaunchpadEvent,
  LaunchInitializedEvent,
  LaunchClaimEvent,
  LaunchCompletedEvent,
  LaunchFundedEvent,
  LaunchRefundedEvent,
  LaunchStartedEvent,
  LaunchCloseEvent,
  FundingRecordApprovalSetEvent,
  LaunchClaimAdditionalTokenAllocationEvent,
  LaunchPerformancePackageInitializedEvent,
} from "@metadaoproject/futarchy/v0.7";
import { schema, db, eq, and, sql, DBTransaction } from "@metadaoproject/indexer-db";
import { PublicKey } from "@solana/web3.js";
import type { VersionedTransactionResponse } from "@solana/web3.js";
import { V06LaunchState } from "@metadaoproject/indexer-db/lib/schema";
import * as token from "@solana/spl-token";
import { launchpadV7Client } from "../../../connections/v0.7";
import { futarchyClient } from "../../../connections/v0.6";
import { insertTokenIfNotExists } from "../../shared/utils";
import { log } from "../../../logger/logger";
import { BN } from "@coral-xyz/anchor";

const logger = log.child({
  module: "launchpad-v0.7-processor"
});

type DBConnection = any;

export async function processLaunchpadV7Event(
  event: { name: string; data: LaunchpadEvent },
  signature: string,
  transactionResponse: VersionedTransactionResponse
) {
  switch (event.name) {
    case "LaunchInitializedEvent":
      await handleLaunchInitializedEvent(event.data as LaunchInitializedEvent, signature, transactionResponse);
      break;
    case "LaunchStartedEvent":
      await handleLaunchStartedEvent(event.data as LaunchStartedEvent, signature, transactionResponse);
      break;
    case "LaunchFundedEvent":
      await handleLaunchFundedEvent(event.data as LaunchFundedEvent, signature, transactionResponse);
      break;
    case "FundingRecordApprovalSetEvent":
      await handleFundingRecordApprovalSetEvent(event.data as FundingRecordApprovalSetEvent, signature, transactionResponse);
      break;
    case "LaunchCompletedEvent":
      await handleLaunchCompletedEvent(event.data as LaunchCompletedEvent, signature, transactionResponse);
      break;
    case "LaunchRefundedEvent":
      await handleLaunchRefundedEvent(event.data as LaunchRefundedEvent, signature, transactionResponse);
      break;
    case "LaunchClaimEvent":
      await handleLaunchClaimEvent(event.data as LaunchClaimEvent, signature, transactionResponse);
      break;
    case "LaunchCloseEvent":
      await handleLaunchCloseEvent(event.data as LaunchCloseEvent, signature, transactionResponse);
      break;
    case "LaunchClaimAdditionalTokenAllocationEvent":
      await handleLaunchClaimAdditionalTokenAllocationEvent(event.data as LaunchClaimAdditionalTokenAllocationEvent, signature, transactionResponse);
      break;
    case "LaunchPerformancePackageInitializedEvent":
      await handleLaunchPerformancePackageInitializedEvent(event.data as LaunchPerformancePackageInitializedEvent, signature, transactionResponse);
      break;
    default:
      logger.info({ eventName: event.name }, "Unknown Launchpad v0.7 event");
  }
}

async function handleLaunchInitializedEvent(event: LaunchInitializedEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      const [existingLaunch] = await trx.select()
        .from(schema.v0_7_launches)
        .where(eq(schema.v0_7_launches.launchAddr, event.launch.toString()))
        .limit(1);

      if (existingLaunch && existingLaunch.updatedAtSlot > BigInt(event.common.slot.toString())) {
        logger.info(`Launch ${event.launch.toString()} already exists with last updated slot ${existingLaunch.updatedAtSlot.toString()}`);
        return;
      }

      await insertTokenIfNotExists(trx, event.baseMint);

      await trx.insert(schema.v0_7_launches).values({
        launchAddr: event.launch.toString(),
        pdaBump: event.pdaBump,
        minimumRaiseAmount: BigInt(event.minimumRaiseAmount.toString()),
        monthlySpendingLimitAmount: BigInt(event.monthlySpendingLimitAmount.toString()),
        monthlySpendingLimitMembers: event.monthlySpendingLimitMembers.map(pk => pk.toString()),
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
        performancePackageGrantee: event.performancePackageGrantee.toString(),
        performancePackageTokenAmount: BigInt(event.performancePackageTokenAmount.toString()),
        monthsUntilInsidersCanUnlock: event.monthsUntilInsidersCanUnlock,
        teamAddress: "", // Will be fetched from account if needed
        totalApprovedAmount: 0n,
        additionalTokensAmount: 0n,
        additionalTokensRecipient: null,
        additionalTokensClaimed: false,
        updatedAtSlot: BigInt(event.common.slot.toString()),
      }).onConflictDoNothing();
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchInitializedEvent");
  }
}

async function handleLaunchStartedEvent(event: LaunchStartedEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      const [existingLaunch] = await trx.select()
        .from(schema.v0_7_launches)
        .where(eq(schema.v0_7_launches.launchAddr, event.launch.toString()))
        .limit(1);

      if (existingLaunch && existingLaunch.seqNum > BigInt(event.common.launchSeqNum.toString())) {
        logger.info(`Launch ${event.launch.toString()} already updated to seqNum ${existingLaunch.seqNum.toString()}`);
        return;
      }

      await trx.update(schema.v0_7_launches).set({
        state: V06LaunchState.Live,
        unixTimestampStarted: BigInt(event.common.unixTimestamp.toString()),
        seqNum: BigInt(event.common.launchSeqNum.toString()),
        updatedAtSlot: BigInt(event.slotStarted.toString()),
      }).where(eq(schema.v0_7_launches.launchAddr, event.launch.toString()));
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchStartedEvent");
  }
}

async function handleLaunchFundedEvent(event: LaunchFundedEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      const [existingFund] = await trx.select()
        .from(schema.v0_7_funds)
        .where(and(
          eq(schema.v0_7_funds.fundingRecordAddr, event.fundingRecord.toString()),
          eq(schema.v0_7_funds.txSignature, signature)
        ))
        .limit(1);

      if (existingFund) {
        logger.info(`Fund already exists for funding record ${event.fundingRecord.toString()} with signature: ${signature}`);
        return;
      }

      let highestSequenceNumber = BigInt(event.common.launchSeqNum.toString());

      // Ensure the launch exists before inserting funding record
      const [existingLaunch] = await trx.select()
        .from(schema.v0_7_launches)
        .where(eq(schema.v0_7_launches.launchAddr, event.launch.toString()))
        .limit(1);

      if (!existingLaunch) {
        logger.warn(`Launch ${event.launch.toString()} does not exist, creating minimal record for funding event`);
        await trx.insert(schema.v0_7_launches).values({
          launchAddr: event.launch.toString(),
          pdaBump: 0,
          seqNum: BigInt(event.common.launchSeqNum.toString()),
          state: V06LaunchState.Live,
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
          secondsForLaunch: 0,
          performancePackageGrantee: "",
          performancePackageTokenAmount: 0n,
          monthsUntilInsidersCanUnlock: 0,
          teamAddress: "",
          totalApprovedAmount: 0n,
          additionalTokensAmount: 0n,
          additionalTokensRecipient: null,
          additionalTokensClaimed: false,
        }).onConflictDoNothing();
      }

      // Insert/update funding record with pdaBump
      await trx.insert(schema.v0_7_funding_records).values({
        fundingRecordAddr: event.fundingRecord.toString(),
        pdaBump: 0, // Will be updated from account data if needed
        launchAddr: event.launch.toString(),
        funderAddr: event.funder.toString(),
        committedAmount: BigInt(event.totalCommittedByFunder.toString()),
        isTokensClaimed: false,
        isUsdcRefunded: false,
        approvedAmount: 0n,
        updatedAtSlot: BigInt(event.common.slot.toString()),
      }).onConflictDoUpdate({
        target: schema.v0_7_funding_records.fundingRecordAddr,
        set: {
          committedAmount: sql`CASE WHEN ${BigInt(event.common.slot.toString())} >= ${schema.v0_7_funding_records.updatedAtSlot} THEN ${BigInt(event.totalCommittedByFunder.toString())} ELSE ${schema.v0_7_funding_records.committedAmount} END`,
          updatedAtSlot: sql`GREATEST(${BigInt(event.common.slot.toString())}, ${schema.v0_7_funding_records.updatedAtSlot})`
        }
      });

      await trx.insert(schema.v0_7_funds).values({
        fundingRecordAddr: event.fundingRecord.toString(),
        txSignature: signature,
        launchAddr: event.launch.toString(),
        funderAddr: event.funder.toString(),
        slot: BigInt(event.common.slot.toString()),
        timestamp: new Date(event.common.unixTimestamp.mul(new BN(1000)).toNumber()),
        quoteAmount: event.amount.toString(),
      }).onConflictDoNothing();

      if (existingLaunch && highestSequenceNumber > existingLaunch.seqNum) {
        await trx.update(schema.v0_7_launches).set({
          totalCommittedAmount: BigInt(event.totalCommitted.toString()),
          seqNum: BigInt(event.common.launchSeqNum.toString()),
        }).where(eq(schema.v0_7_launches.launchAddr, event.launch.toString()));
      }
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchFundedEvent");
  }
}

async function handleFundingRecordApprovalSetEvent(event: FundingRecordApprovalSetEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      // Insert approval record
      await trx.insert(schema.v0_7_funding_approvals).values({
        fundingRecordAddr: event.fundingRecord.toString(),
        launchAddr: event.launch.toString(),
        funderAddr: event.funder.toString(),
        approvedAmount: BigInt(event.approvedAmount.toString()),
        totalApproved: BigInt(event.totalApproved.toString()),
        slot: BigInt(event.common.slot.toString()),
        timestamp: new Date(event.common.unixTimestamp.mul(new BN(1000)).toNumber()),
      });

      // Update funding record with approved amount
      await trx.update(schema.v0_7_funding_records).set({
        approvedAmount: BigInt(event.approvedAmount.toString()),
        updatedAtSlot: BigInt(event.common.slot.toString()),
      }).where(eq(schema.v0_7_funding_records.fundingRecordAddr, event.fundingRecord.toString()));

      // Update launch with total approved amount
      await trx.update(schema.v0_7_launches).set({
        totalApprovedAmount: BigInt(event.totalApproved.toString()),
        updatedAtSlot: BigInt(event.common.slot.toString()),
      }).where(eq(schema.v0_7_launches.launchAddr, event.launch.toString()));
    });
  } catch (error) {
    logger.error(error, "Error in handleFundingRecordApprovalSetEvent");
  }
}

async function handleLaunchCompletedEvent(event: LaunchCompletedEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      const [existingLaunch] = await trx.select()
        .from(schema.v0_7_launches)
        .where(eq(schema.v0_7_launches.launchAddr, event.launch.toString()))
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
      let launchUpdateData: Partial<typeof schema.v0_7_launches.$inferInsert> = {
        totalCommittedAmount: BigInt(event.totalCommitted.toString()),
        totalApprovedAmount: BigInt(event.totalApprovedAmount.toString()),
        state: launchState,
        seqNum: BigInt(event.common.launchSeqNum.toString()),
        daoAddr: launchState === V06LaunchState.Complete ? event.dao?.toString() : null,
        updatedAtSlot: BigInt(event.common.slot.toString()),
      };

      // If launch is complete, fetch additional data from the launch account
      if (launchState === V06LaunchState.Complete) {
        try {
          const launchAccount = await launchpadV7Client.getLaunch(event.launch);
          if (launchAccount) {
            launchUpdateData = {
              ...launchUpdateData,
              daoVault: launchAccount.daoVault?.toString(),
              performancePackageGrantee: launchAccount.performancePackageGrantee?.toString(),
              performancePackageTokenAmount: BigInt(launchAccount.performancePackageTokenAmount.toString()),
              monthsUntilInsidersCanUnlock: launchAccount.monthsUntilInsidersCanUnlock,
              monthlySpendingLimitAmount: BigInt(launchAccount.monthlySpendingLimitAmount.toString()),
              monthlySpendingLimitMembers: launchAccount.monthlySpendingLimitMembers?.map(pk => pk.toString()),
              teamAddress: launchAccount.teamAddress?.toString() ?? "",
              additionalTokensAmount: BigInt(launchAccount.additionalTokensAmount?.toString() ?? '0'),
              additionalTokensRecipient: launchAccount.additionalTokensRecipient?.toString() ?? null,
              additionalTokensClaimed: launchAccount.additionalTokensClaimed ?? false,
              unixTimestampCompleted: launchAccount.unixTimestampCompleted ? BigInt(launchAccount.unixTimestampCompleted.toString()) : null,
              isPerformancePackageInitialized: launchAccount.isPerformancePackageInitialized,
            };
          }
        } catch (fetchError) {
          logger.warn(`Could not fetch launch account data for ${event.launch.toString()}: ${fetchError}`);
        }
      }

      await trx.update(schema.v0_7_launches).set(launchUpdateData).where(eq(schema.v0_7_launches.launchAddr, event.launch.toString()));
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchCompletedEvent");
  }
}

async function handleLaunchRefundedEvent(event: LaunchRefundedEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      const [existingRefund] = await trx.select()
        .from(schema.v0_7_refunds)
        .where(eq(schema.v0_7_refunds.fundingRecordAddr, event.fundingRecord.toString()))
        .limit(1);

      if (existingRefund) {
        logger.info(`Refund already exists for funding record ${event.fundingRecord.toString()}`);
        return;
      }

      await trx.insert(schema.v0_7_refunds).values({
        fundingRecordAddr: event.fundingRecord.toString(),
        launchAddr: event.launch.toString(),
        funderAddr: event.funder.toString(),
        slot: BigInt(event.common.slot.toString()),
        timestamp: new Date(event.common.unixTimestamp.mul(new BN(1000)).toNumber()),
        quoteAmount: event.usdcRefunded.toString(),
      }).onConflictDoNothing();

      await trx.update(schema.v0_7_funding_records).set({
        isUsdcRefunded: true,
        updatedAtSlot: BigInt(event.common.slot.toString()),
      }).where(eq(schema.v0_7_funding_records.fundingRecordAddr, event.fundingRecord.toString()));
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchRefundedEvent");
  }
}

async function handleLaunchClaimEvent(event: LaunchClaimEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      const [existingClaim] = await trx.select()
        .from(schema.v0_7_claims)
        .where(eq(schema.v0_7_claims.fundingRecordAddr, event.fundingRecord.toString()))
        .limit(1);

      if (existingClaim) {
        logger.info(`Claim already exists for funding record ${event.fundingRecord.toString()}`);
        return;
      }

      await trx.insert(schema.v0_7_claims).values({
        fundingRecordAddr: event.fundingRecord.toString(),
        launchAddr: event.launch.toString(),
        funderAddr: event.funder.toString(),
        tokensClaimed: event.tokensClaimed.toString(),
        slot: BigInt(event.common.slot.toString()),
        timestamp: new Date(event.common.unixTimestamp.mul(new BN(1000)).toNumber()),
      }).onConflictDoNothing();

      await trx.update(schema.v0_7_funding_records).set({
        isTokensClaimed: true,
        updatedAtSlot: BigInt(event.common.slot.toString()),
      }).where(eq(schema.v0_7_funding_records.fundingRecordAddr, event.fundingRecord.toString()));
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchClaimEvent");
  }
}

async function handleLaunchCloseEvent(event: LaunchCloseEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      const [existingLaunch] = await trx.select()
        .from(schema.v0_7_launches)
        .where(eq(schema.v0_7_launches.launchAddr, event.launch.toString()))
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

      await trx.update(schema.v0_7_launches).set({
        state: mappedState,
        unixTimestampClosed: BigInt(event.common.unixTimestamp.toString()),
        seqNum: BigInt(event.common.launchSeqNum.toString()),
        updatedAtSlot: BigInt(event.common.slot.toString()),
      }).where(eq(schema.v0_7_launches.launchAddr, event.launch.toString()));
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchCloseEvent");
  }
}

async function handleLaunchClaimAdditionalTokenAllocationEvent(event: LaunchClaimAdditionalTokenAllocationEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      // Insert into additional token claims table
      await trx.insert(schema.v0_7_additional_token_claims).values({
        launchAddr: event.launch.toString(),
        additionalTokensAmount: BigInt(event.additionalTokensAmount.toString()),
        additionalTokensRecipient: event.additionalTokensRecipient.toString(),
        slot: BigInt(event.common.slot.toString()),
        timestamp: new Date(event.common.unixTimestamp.mul(new BN(1000)).toNumber()),
      });

      // Update launch to mark additional tokens as claimed
      await trx.update(schema.v0_7_launches).set({
        additionalTokensClaimed: true,
        updatedAtSlot: BigInt(event.common.slot.toString()),
      }).where(eq(schema.v0_7_launches.launchAddr, event.launch.toString()));
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchClaimAdditionalTokenAllocationEvent");
  }
}

async function handleLaunchPerformancePackageInitializedEvent(event: LaunchPerformancePackageInitializedEvent, _signature: string, _transactionResponse: VersionedTransactionResponse) {
  try {
    // Log the performance package initialization
    logger.info({
      launch: event.launch.toString(),
      performancePackage: event.performancePackage.toString(),
    }, "Performance package initialized for launch");

    // Update the launch record to mark performance package as initialized
    await db.update(schema.v0_7_launches).set({
      isPerformancePackageInitialized: true,
      updatedAtSlot: BigInt(event.common.slot.toString()),
    }).where(eq(schema.v0_7_launches.launchAddr, event.launch.toString()));
  } catch (error) {
    logger.error(error, "Error in handleLaunchPerformancePackageInitializedEvent");
  }
}

// Account update handlers (Launchpad accounts updated via Geyser stream)
export async function processLaunchpadV7AccountUpdate(
  pubkey: string,
  accountType: string,
  accountData: any,
  slot: bigint
) {
  switch (accountType) {
    case 'launch':
      logger.debug({ pubkey, slot: slot.toString() }, "v0.7 Launch account update");
      // TODO: Add upsertLaunch function
      break;
    case 'fundingRecord':
      logger.debug({ pubkey, slot: slot.toString() }, "v0.7 FundingRecord update");
      // TODO: Add upsertFundingRecord function
      break;
    default:
      logger.debug({ pubkey, accountType }, "Unknown Launchpad v0.7 account type in update");
  }
}
