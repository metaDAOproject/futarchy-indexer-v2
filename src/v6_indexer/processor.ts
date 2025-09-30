import { AddLiquidityEvent, AmmEvent, ConditionalVaultEvent, CreateAmmEvent, getVaultAddr, InitializeConditionalVaultEvent, InitializeQuestionEvent, SwapEvent, PriceMath, RedeemTokensEvent, SplitTokensEvent, MergeTokensEvent, RemoveLiquidityEvent, ResolveQuestionEvent, LaunchpadEvent, LaunchInitializedEvent, LaunchClaimEvent, LaunchCompletedEvent, LaunchFundedEvent, LaunchRefundedEvent, LaunchStartedEvent, LaunchCloseEvent, CrankThatTwapEvent, InitializeProposalEvent, UpdateDaoEvent, InitializeDaoEvent, FinalizeProposalEvent, Dao, Proposal, CollectFeesEvent, StakeToProposalEvent, UnstakeFromProposalEvent, LaunchProposalEvent, SpotSwapEvent, ConditionalSwapEvent, ProvideLiquidityEvent, WithdrawLiquidityEvent, FutarchyEvent } from "@metadaoproject/futarchy/v0.6";
import { schema, db, eq, and, or, DBTransaction } from "@metadaoproject/indexer-db";
import { PublicKey } from "@solana/web3.js";
import type { VersionedTransactionResponse } from "@solana/web3.js";
import { V06LaunchState, V06ProposalState, V04SwapType } from "@metadaoproject/indexer-db/lib/schema";
import * as token from "@solana/spl-token";
import { connection, conditionalVaultClient, futarchyClient, launchpadClient } from "./connection";
import { 
  insertTwapIfNotExists,
  updateOrInsertTokenBalance,
  updateConditionalTokenBalancesForVaultEvents,
  insertTokenIfNotExists,
  doesQuestionExist,
  insertTokenAccountIfNotExists,
  insertMarketIfNotExists,
  insertConditionalVault,
  getVaultBalances,
  extractReservesFromAmmState,
  upsertV06Dao,
  upsertV06Proposal,
  Market
} from "./utils";

import { log } from "../logger/logger";
import { BN } from "@coral-xyz/anchor";

const logger = log.child({
  module: "v6_processor"
});

type DBConnection = any; // TODO: Fix typing..

// export async function processVaultEvent(event: { name: string; data: ConditionalVaultEvent }, signature: string, transactionResponse: VersionedTransactionResponse) {
//   switch (event.name) {
//     case "InitializeQuestionEvent":
//       await handleInitializeQuestionEvent(event.data as InitializeQuestionEvent);
//       break;
//     case "RedeemTokensEvent":
//       await handleRedeemEvent(event.data as RedeemTokensEvent, signature, transactionResponse);
//       break;
//     case "InitializeConditionalVaultEvent":
//       await handleInitializeConditionalVaultEvent(event.data as InitializeConditionalVaultEvent);
//       break;
//     case "SplitTokensEvent":
//       await handleSplitEvent(event.data as SplitTokensEvent, signature, transactionResponse);
//       break;
//     case "MergeTokensEvent":
//       await handleMergeEvent(event.data as MergeTokensEvent, signature, transactionResponse);
//       break;
//     case "ResolveQuestionEvent":
//       await handleResolveQuestionEvent(event.data as ResolveQuestionEvent, signature, transactionResponse);
//       break;
//     default:
//       logger.info("Unknown Vault event", event.name);
//   }
// }

// async function handleInitializeQuestionEvent(event: InitializeQuestionEvent) {
//   try {

//     const values: typeof schema.v0_6_questions.$inferInsert = {
//       questionAddr: event.question.toString(),
//       oracleAddr: event.oracle.toString(),
//       payoutNumerators: Array(event.numOutcomes).fill(0),
//       payoutDenominator: 0n,
//       questionId: event.questionId,
//     };
    
//     await db.insert(schema.v0_6_questions)
//       .values(values)
//       .onConflictDoNothing();
    
//   } catch (error) {
//     logger.error(error, "Error in handleInitializeQuestionEvent");
//   }
// }

// async function handleRedeemEvent(event: RedeemTokensEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
//   try {
//     await updateConditionalTokenBalancesForVaultEvents(
//       db,
//       new PublicKey(event.vault.toString()),
//       new PublicKey(event.user.toString()),
//       signature,
//       transactionResponse.slot.toString(),
//       transactionResponse.blockTime ?? null
//     );
//   } catch (error) {
//     logger.error(error, "Error in handleRedeemEvent");
//   }
// }

// async function handleResolveQuestionEvent(event: ResolveQuestionEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
//   try {
//     logger.info("Resolving question", event.question.toString());

//     let payoutDenominator = 0;
//     for (const numerator of event.payoutNumerators) {
//       payoutDenominator += numerator;
//     }
//     await db.update(schema.v0_6_questions).set({
//       payoutNumerators: event.payoutNumerators,
//       payoutDenominator: BigInt(payoutDenominator),
//     }).where(eq(schema.v0_6_questions.questionAddr, event.question.toString()));

//     //update v5 metric decisions
//     //completed at = now
//     await db.update(schema.v0_5_metric_decisions).set({
//       completedAt: new Date(),
//     }).where(
//       or(
//         eq(schema.v0_5_metric_decisions.outcomeQuestionAddr, event.question.toString()),
//         eq(schema.v0_5_metric_decisions.metricQuestionAddr, event.question.toString())
//       )
//     );

//   } catch (error) {
//     logger.error(error, "Error in handleResolveQuestionEvent");
//   }
// }

export async function processLaunchpadEvent(event: { name: string; data: LaunchpadEvent }, signature: string, transactionResponse: VersionedTransactionResponse) { 
  switch (event.name) {
    case "LaunchClaimEvent":
      await handleLaunchClaimEvent(event.data as LaunchClaimEvent, signature, transactionResponse);
      break;
    case "LaunchCompletedEvent":
      await handleLaunchCompletedEvent(event.data as LaunchCompletedEvent, signature, transactionResponse);
      break;
    case "LaunchFundedEvent":
      await handleLaunchFundedEvent(event.data as LaunchFundedEvent, signature, transactionResponse);
      break;
    case "LaunchInitializedEvent":
      await handleLaunchInitializedEvent(event.data as LaunchInitializedEvent, signature, transactionResponse);
      break;
    case "LaunchRefundedEvent":
      await handleLaunchRefundedEvent(event.data as LaunchRefundedEvent, signature, transactionResponse);
      break;
    case "LaunchStartedEvent":
      await handleLaunchStartedEvent(event.data as LaunchStartedEvent, signature, transactionResponse);
      break;
    case "LaunchCloseEvent":
      await handleLaunchCloseEvent(event.data as LaunchCloseEvent, signature, transactionResponse);
      break;
    default:
      logger.info("Unknown Launchpad event", event.name);
  }
}

async function handleLaunchClaimEvent(event: LaunchClaimEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
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

async function handleLaunchCompletedEvent(event: LaunchCompletedEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
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

      // Check if the launch is complete or refunding
      const launchState = !!event.finalState.complete ? V06LaunchState.Complete : V06LaunchState.Refunding;

      if( launchState === V06LaunchState.Complete && event.dao) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        const dao = await futarchyClient.fetchDao(event.dao);
        
        if(dao) {
          const [existingDao] = await trx.select()
            .from(schema.v0_6_daos)
            .where(eq(schema.v0_6_daos.daoAddr, event.dao.toString()))
            .limit(1);
          
          if(existingDao) {
            logger.info(`DAO ${event.dao.toString()} already exists, skipping creation`);
          } else {
            await insertTokenIfNotExists(trx, dao.quoteMint);
            await insertTokenIfNotExists(trx, dao.baseMint);

            await trx.insert(schema.v0_6_daos).values({
              daoAddr: event.dao.toString(),
              ammAddr: dao.amm.toString(),
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
              // AMM fields that actually exist
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

      await trx.update(schema.v0_6_launches).set({ 
        totalCommittedAmount: BigInt(event.totalCommitted.toString()),
        state: launchState,
        seqNum: BigInt(event.common.launchSeqNum.toString()),
        daoAddr: launchState === V06LaunchState.Complete ? event.dao?.toString() : null,
      }).where(eq(schema.v0_6_launches.launchAddr, event.launch.toString()));
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchCompletedEvent");
  }
}

async function handleLaunchFundedEvent(event: LaunchFundedEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      const [existingFund] = await trx.select()
        .from(schema.v0_6_funds)
        .where(eq(schema.v0_6_funds.txSignature, signature))
        .limit(1);

      if (existingFund) {
        logger.info(`Fund already exists for transaction ${signature}`);
        return;
      }

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
          // Other required fields will be filled when LaunchInitializedEvent is processed
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
          committedAmount: BigInt(event.totalCommittedByFunder.toString()),
          seqNum: BigInt(event.common.launchSeqNum.toString()),
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
      }).onConflictDoNothing();

      await trx.update(schema.v0_6_launches).set({
        totalCommittedAmount: BigInt(event.totalCommitted.toString()),
        seqNum: BigInt(event.common.launchSeqNum.toString()),
      }).where(eq(schema.v0_6_launches.launchAddr, event.launch.toString()));
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchFundedEvent");
  }
}

async function handleLaunchInitializedEvent(event: LaunchInitializedEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
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

      await trx.insert(schema.v0_6_launches).values({
        launchAddr: event.launch.toString(),
        minimumRaiseAmount: BigInt(event.minimumRaiseAmount.toString()),
        monthlySpendingLimitAmount: 0n, 
        monthlySpendingLimitMembers: [], 
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
        performancePackageGrantee: "",
        performancePackageTokenAmount: 0n,
        monthsUntilInsidersCanUnlock: 0,
        pdaBump: event.pdaBump,
      }).onConflictDoNothing();
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchInitializedEvent");
  }
}

async function handleLaunchRefundedEvent(event: LaunchRefundedEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
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

async function handleLaunchStartedEvent(event: LaunchStartedEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
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
    }).where(eq(schema.v0_6_launches.launchAddr, event.launch.toString()));
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchStartedEvent");
  }
}

async function handleLaunchCloseEvent(event: LaunchCloseEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
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
      }).where(eq(schema.v0_6_launches.launchAddr, event.launch.toString()));
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchCloseEvent");
  }
}

export async function processFutarchyEvent(event: { name: string; data: FutarchyEvent }, signature: string, transactionResponse: VersionedTransactionResponse) {
  switch (event.name) {
    // case "CollectFeesEvent":
    //   await handleCollectFeesEvent(event.data as CollectFeesEvent, signature, transactionResponse);
    //   break;
    case "InitializeDaoEvent":
      await handleInitializeDaoEvent(event.data as InitializeDaoEvent, signature, transactionResponse);
      break;
    case "UpdateDaoEvent":
      await handleUpdateDaoEvent(event.data as UpdateDaoEvent, signature, transactionResponse);
      break;
    case "InitializeProposalEvent":
      await handleInitializeProposalEvent(event.data as InitializeProposalEvent, signature, transactionResponse);
      break;
    // case "StakeToProposalEvent":
    //   await handleStakeToProposalEvent(event.data as StakeToProposalEvent, signature, transactionResponse);
    //   break;
    // case "UnstakeFromProposalEvent":
    //   await handleUnstakeFromProposalEvent(event.data as UnstakeFromProposalEvent, signature, transactionResponse);
    //   break;
    case "LaunchProposalEvent":
      await handleLaunchProposalEvent(event.data as LaunchProposalEvent, signature, transactionResponse);
      break;
    case "FinalizeProposalEvent":
      await handleFinalizeProposalEvent(event.data as FinalizeProposalEvent, signature, transactionResponse);
      break;
    case "SpotSwapEvent":
      await handleSpotSwapEvent(event.data as SpotSwapEvent, signature, transactionResponse);
      break;
    case "ConditionalSwapEvent":
      await handleConditionalSwapEvent(event.data as ConditionalSwapEvent, signature, transactionResponse);
      break;
    case "ProvideLiquidityEvent":
      await handleProvideLiquidityEvent(event.data as ProvideLiquidityEvent, signature, transactionResponse);
      break;
    case "WithdrawLiquidityEvent":
      await handleWithdrawLiquidityEvent(event.data as WithdrawLiquidityEvent, signature, transactionResponse);
      break;
    default:
      logger.info("Unknown Futarchy event", event.name);
  }
}

// Futarchy Event Handlers

// we most likely want a seperate fees_collected table, come back to this when we have most things in working order.

// async function handleCollectFeesEvent(event: CollectFeesEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
//   try {
//     await db.transaction(async (trx: DBTransaction) => {
//       try {
//         const baseAccount = await token.getAccount(connection, event.ammBaseVault);
//         const quoteAccount = await token.getAccount(connection, event.ammQuoteVault);
        
//         await trx.update(schema.v0_6_daos).set({
//           ammBaseAmount: BigInt(baseAccount.amount.toString()),
//           ammQuoteAmount: BigInt(quoteAccount.amount.toString()),
//           seqNum: BigInt(event.common.daoSeqNum.toString()),
//         }).where(eq(schema.v0_6_daos.daoAddr, event.dao.toString()));
        
//       } catch (fetchError) {
//         logger.warn(`Could not fetch AMM vault balances for DAO ${event.dao.toString()}: ${fetchError}`);
//         // Fallback: just update seqNum
//         await trx.update(schema.v0_6_daos).set({
//           seqNum: BigInt(event.common.daoSeqNum.toString()),
//         }).where(eq(schema.v0_6_daos.daoAddr, event.dao.toString()));
//       }

//       // Insert TWAP data
//       await insertTwapIfNotExists(trx, event);

//       logger.info(`Collected fees: ${event.baseFeesCollected.toString()} base, ${event.quoteFeesCollected.toString()} quote from DAO ${event.dao.toString()}`);
//     });
//   } catch (error) {
//     logger.error(error, "Error in handleCollectFeesEvent");
//   }
// }

async function handleInitializeDaoEvent(event: InitializeDaoEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    const daoAcct = await futarchyClient.fetchDao(event.dao);
    
    if (!daoAcct) {
      logger.warn(`DAO account not found for ${event.dao.toString()}`);
      return;
    }

    await db.transaction(async (trx: DBTransaction) => {
      await insertTokenIfNotExists(trx, daoAcct.baseMint);
      await insertTokenIfNotExists(trx, daoAcct.quoteMint);
      await upsertV06Dao(daoAcct, event.dao, trx);
    });
  } catch (error) {
    logger.error(error, "Error in handleInitializeDaoEvent");
  }
}

async function handleUpdateDaoEvent(event: UpdateDaoEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    const daoAcct = await futarchyClient.fetchDao(event.dao);
    
    if (!daoAcct) {
      logger.warn(`DAO account not found for ${event.dao.toString()}`);
      return;
    }

    await db.transaction(async (trx: DBTransaction) => {
      await insertTokenIfNotExists(trx, daoAcct.baseMint);
      await insertTokenIfNotExists(trx, daoAcct.quoteMint);
      await upsertV06Dao(daoAcct, event.dao, trx);
    });
  } catch (error) {
    logger.error(error, "Error in handleUpdateDaoEvent");
  }
}

async function handleInitializeProposalEvent(event: InitializeProposalEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    const proposalAcct = await futarchyClient.fetchProposal(event.proposal);
    
    if (!proposalAcct) {
      logger.warn(`Proposal account not found for ${event.proposal.toString()}`);
      return;
    }

    await db.transaction(async (trx: DBTransaction) => {
      const blockTime = transactionResponse.blockTime ? new Date(transactionResponse.blockTime * 1000) : null;
      await upsertV06Proposal(proposalAcct, event.proposal, BigInt(event.common.slot.toString()), blockTime, trx);
    });
  } catch (error) {
    logger.error(error, "Error in handleInitializeProposalEvent");
  }
}

// need to build out proposal process as well, most likely want a similar ui to projects/create but 
// [organization]/create instead

// async function handleStakeToProposalEvent(event: StakeToProposalEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
//   try {
//     await db.transaction(async (trx: DBTransaction) => {
//       // Update proposal's totalStaked amount and state if it transitions to Pending
//       const proposal = await trx.select()
//         .from(schema.v0_6_proposals)
//         .where(eq(schema.v0_6_proposals.proposalAddr, event.proposal.toString()))
//         .limit(1);

//       if (proposal.length === 0) {
//         logger.warn(`Proposal ${event.proposal.toString()} not found for stake event`);
//         return;
//       }

//       // For simplicity, we'll just log the stake event
//       // Full implementation would track individual stakes in a separate table
//       logger.info(`Stake event: ${event.amount.toString()} staked to proposal ${event.proposal.toString()}, total staked: ${event.totalStaked.toString()}`);
//     });
//   } catch (error) {
//     logger.error(error, "Error in handleStakeToProposalEvent");
//   }
// }

// async function handleUnstakeFromProposalEvent(event: UnstakeFromProposalEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
//   try {
//     await db.transaction(async (trx: DBTransaction) => {
//       // Log the unstake event
//       // Full implementation would track individual stakes in a separate table
//       logger.info(`Unstake event: ${event.amount.toString()} unstaked from proposal ${event.proposal.toString()}, total remaining: ${event.totalStaked.toString()}`);
//     });
//   } catch (error) {
//     logger.error(error, "Error in handleUnstakeFromProposalEvent");
//   }
// }

async function handleLaunchProposalEvent(event: LaunchProposalEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      // Update proposal state to Pending
      await trx.update(schema.v0_6_proposals).set({
        state: V06ProposalState.Pending,
      }).where(eq(schema.v0_6_proposals.proposalAddr, event.proposal.toString()));

      // Get DAO record to fetch base/quote mints
      const existingDao = await trx.select()
        .from(schema.v0_6_daos)
        .where(eq(schema.v0_6_daos.daoAddr, event.dao.toString()))
        .limit(1);

      if (existingDao.length > 0) {
        // Get AMM vault ATAs for base and quote tokens
        const ammBaseVaultAta = token.getAssociatedTokenAddressSync(
          new PublicKey(existingDao[0].baseMintAcct),
          event.dao,
          true
        );

        const ammQuoteVaultAta = token.getAssociatedTokenAddressSync(
          new PublicKey(existingDao[0].quoteMintAcct),
          event.dao,
          true
        );

        // Fetch actual token account balances
        try {
          const baseAccount = await token.getAccount(connection, ammBaseVaultAta);
          const quoteAccount = await token.getAccount(connection, ammQuoteVaultAta);
          
          await trx.update(schema.v0_6_daos).set({
            ammBaseAmount: BigInt(baseAccount.amount.toString()),
            ammQuoteAmount: BigInt(quoteAccount.amount.toString()),
            seqNum: BigInt(event.common.daoSeqNum.toString()),
          }).where(eq(schema.v0_6_daos.daoAddr, event.dao.toString()));
          
        } catch (fetchError) {
          logger.warn(`Could not fetch AMM vault balances for DAO ${event.dao.toString()}: ${fetchError}`);
          // Fallback: just update seqNum
          await trx.update(schema.v0_6_daos).set({
            seqNum: BigInt(event.common.daoSeqNum.toString()),
          }).where(eq(schema.v0_6_daos.daoAddr, event.dao.toString()));
        }
      }

      // Insert TWAP data
      await insertTwapIfNotExists(trx, event);

      logger.info(`Launched proposal ${event.proposal.toString()}`);
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchProposalEvent");
  }
}

async function handleFinalizeProposalEvent(event: FinalizeProposalEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    const proposalAcct = await futarchyClient.fetchProposal(event.proposal);
    
    if (!proposalAcct) {
      logger.warn(`Proposal account not found for ${event.proposal.toString()}`);
      return;
    }

    await db.transaction(async (trx: DBTransaction) => {
      const blockTime = transactionResponse.blockTime ? new Date(transactionResponse.blockTime * 1000) : null;
      await upsertV06Proposal(proposalAcct, event.proposal, BigInt(event.common.slot.toString()), blockTime, trx);
    });
  } catch (error) {
    logger.error(error, "Error in handleFinalizeProposalEvent");
  }
}

async function handleSpotSwapEvent(event: SpotSwapEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      // Extract reserves from postAmmState
      const { baseReserves, quoteReserves } = extractReservesFromAmmState(event.postAmmState);

      // Insert spot swap record
      const spotSwapValues: typeof schema.v0_6_spot_swaps.$inferInsert = {
        signature: signature,
        slot: BigInt(event.common.slot.toString()),
        unixTimestamp: BigInt(event.common.unixTimestamp.toString()),
        daoAddr: event.dao.toString(),
        userAddr: event.user.toString(),
        swapType: 'buy' in event.swapType ? V04SwapType.Buy : V04SwapType.Sell,
        inputAmount: event.inputAmount.toString(),
        outputAmount: event.outputAmount.toString(),
        minOutputAmount: event.minOutputAmount.toString(),
      };
      await trx.insert(schema.v0_6_spot_swaps).values(spotSwapValues).onConflictDoNothing();

      // Update DAO AMM reserves after swap
      await trx.update(schema.v0_6_daos).set({
        ammBaseAmount: baseReserves,
        ammQuoteAmount: quoteReserves,
        seqNum: BigInt(event.common.daoSeqNum.toString()),
      }).where(eq(schema.v0_6_daos.daoAddr, event.dao.toString()));

      // Insert TWAP data
      await insertTwapIfNotExists(trx, event);

      logger.info(`Spot swap: ${event.inputAmount.toString()} input, ${event.outputAmount.toString()} output on DAO ${event.dao.toString()}`);
    });
  } catch (error) {
    logger.error(error, "Error in handleSpotSwapEvent");
  }
}

async function handleConditionalSwapEvent(event: ConditionalSwapEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      // Extract reserves from postAmmState
      const { baseReserves, quoteReserves } = extractReservesFromAmmState(event.postAmmState);

      // Determine market type for database storage
      const marketType = 'pass' in event.market ? 'pass' : 'fail' in event.market ? 'fail' : 'spot';

      // Insert conditional swap record
      const conditionalSwapValues: typeof schema.v0_6_conditional_swaps.$inferInsert = {
        signature: signature,
        slot: BigInt(event.common.slot.toString()),
        unixTimestamp: BigInt(event.common.unixTimestamp.toString()),
        daoAddr: event.dao.toString(),
        proposalAddr: event.proposal.toString(),
        userAddr: event.trader.toString(),
        market: marketType,
        swapType: 'buy' in event.swapType ? V04SwapType.Buy : V04SwapType.Sell,
        inputAmount: event.inputAmount.toString(),
        outputAmount: event.outputAmount.toString(),
        minOutputAmount: event.minOutputAmount.toString(),
      };
      await trx.insert(schema.v0_6_conditional_swaps).values(conditionalSwapValues).onConflictDoNothing();

      // Update DAO AMM state after conditional swap
      await trx.update(schema.v0_6_daos).set({
        ammBaseAmount: baseReserves,
        ammQuoteAmount: quoteReserves,
        seqNum: BigInt(event.common.daoSeqNum.toString()),
      }).where(eq(schema.v0_6_daos.daoAddr, event.dao.toString()));

      // Insert TWAP data
      await insertTwapIfNotExists(trx, event);

      logger.info(`Conditional swap on ${marketType} market: ${event.inputAmount.toString()} input, ${event.outputAmount.toString()} output`);
    });
  } catch (error) {
    logger.error(error, "Error in handleConditionalSwapEvent");
  }
}

async function handleProvideLiquidityEvent(event: ProvideLiquidityEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      // Extract reserves from postAmmState
      const { baseReserves, quoteReserves } = extractReservesFromAmmState(event.postAmmState);

      // Update DAO AMM state after liquidity provision
      await trx.update(schema.v0_6_daos).set({
        ammBaseAmount: baseReserves,
        ammQuoteAmount: quoteReserves,
        seqNum: BigInt(event.common.daoSeqNum.toString()),
      }).where(eq(schema.v0_6_daos.daoAddr, event.dao.toString()));

      // Insert TWAP data
      await insertTwapIfNotExists(trx, event);

      logger.info(`Liquidity provided: ${event.baseAmount.toString()} base, ${event.quoteAmount.toString()} quote, ${event.liquidityMinted.toString()} LP tokens minted`);
    });
  } catch (error) {
    logger.error(error, "Error in handleProvideLiquidityEvent");
  }
}

async function handleWithdrawLiquidityEvent(event: WithdrawLiquidityEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      // Extract reserves from postAmmState
      const { baseReserves, quoteReserves } = extractReservesFromAmmState(event.postAmmState);

      // Update DAO AMM state after liquidity withdrawal
      await trx.update(schema.v0_6_daos).set({
        ammBaseAmount: baseReserves,
        ammQuoteAmount: quoteReserves,
        seqNum: BigInt(event.common.daoSeqNum.toString()),
      }).where(eq(schema.v0_6_daos.daoAddr, event.dao.toString()));

      // Insert TWAP data
      await insertTwapIfNotExists(trx, event);

      logger.info(`Liquidity withdrawn: ${event.liquidityWithdrawn.toString()} LP tokens burned, ${event.baseAmount.toString()} base, ${event.quoteAmount.toString()} quote received`);
    });
  } catch (error) {
    logger.error(error, "Error in handleWithdrawLiquidityEvent");
  }
}
