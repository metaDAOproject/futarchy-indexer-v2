import {
  SpotSwapEvent,
  ConditionalSwapEvent,
  ProvideLiquidityEvent,
  WithdrawLiquidityEvent,
  FutarchyEvent,
  InitializeDaoEvent,
  UpdateDaoEvent,
  InitializeProposalEvent,
  StakeToProposalEvent,
  UnstakeFromProposalEvent,
  LaunchProposalEvent,
  FinalizeProposalEvent,
  CollectFeesEvent,
  SponsorProposalEvent,
  getStakeAddr,
} from "@metadaoproject/futarchy/v0.7";
import {
  v0_6_0_FutarchyEvent,
  v0_6_0_SpotSwapEvent,
  v0_6_0_ConditionalSwapEvent,
  v0_6_0_ProvideLiquidityEvent,
  v0_6_0_WithdrawLiquidityEvent,
  v0_6_0_InitializeDaoEvent,
  v0_6_0_UpdateDaoEvent,
  v0_6_0_InitializeProposalEvent,
  v0_6_0_StakeToProposalEvent,
  v0_6_0_UnstakeFromProposalEvent,
  v0_6_0_LaunchProposalEvent,
  v0_6_0_FinalizeProposalEvent,
  v0_6_0_CollectFeesEvent,
  // SponsorProposalEvent,
} from "@metadaoproject/futarchy/v0.6";
import { schema, db, eq, sql, DBTransaction } from "@metadaoproject/indexer-db";
import { PublicKey } from "@solana/web3.js";
import type { VersionedTransactionResponse } from "@solana/web3.js";
import { V06ProposalState, V04SwapType } from "@metadaoproject/indexer-db/lib/schema";
import * as token from "@solana/spl-token";
import { connection, futarchyClient } from "../../../connections/v0.6";
import {
  insertTokenIfNotExists,
  extractReservesFromAmmState,
  upsertV06Dao,
  upsertV06Proposal,
  getActiveProposalForDao,
  insertIfNotExistsMarkets,
  insertIfNotExistsPrices,
  insertIfNotExistsTwaps,
  insertPricesFromAmmState,
  updateProposalDetailsTransactionIndex
} from "../../shared/utils";
import { log } from "../../../logger/logger";
import { BN } from "@coral-xyz/anchor";

const logger = log.child({
  module: "futarchy-v0.6-processor"
});

// Track if we're in Geyser mode (set by subscriptionManager)
let isGeyser = false;

export function setGeyserMode(enabled: boolean) {
  isGeyser = enabled;
}

type DBConnection = any;

export async function processFutarchyEvent(
  event: { name: string; data: FutarchyEvent | v0_6_0_FutarchyEvent },
  signature: string,
  transactionResponse: VersionedTransactionResponse
) {
  switch (event.name) {
    case "InitializeDaoEvent":
      await handleInitializeDaoEvent(event.data as InitializeDaoEvent | v0_6_0_InitializeDaoEvent, signature, transactionResponse);
      break;
    case "UpdateDaoEvent":
      await handleUpdateDaoEvent(event.data as UpdateDaoEvent | v0_6_0_UpdateDaoEvent, signature, transactionResponse);
      break;
    case "InitializeProposalEvent":
      await handleInitializeProposalEvent(event.data as InitializeProposalEvent | v0_6_0_InitializeProposalEvent, signature, transactionResponse);
      break;
    case "StakeToProposalEvent":
      await handleStakeToProposalEvent(event.data as StakeToProposalEvent | v0_6_0_StakeToProposalEvent, signature, transactionResponse);
      break;
    case "UnstakeFromProposalEvent":
      await handleUnstakeFromProposalEvent(event.data as UnstakeFromProposalEvent | v0_6_0_UnstakeFromProposalEvent, signature, transactionResponse);
      break;
    case "LaunchProposalEvent":
      await handleLaunchProposalEvent(event.data as LaunchProposalEvent | v0_6_0_LaunchProposalEvent, signature, transactionResponse);
      break;
    case "FinalizeProposalEvent":
      await handleFinalizeProposalEvent(event.data as FinalizeProposalEvent | v0_6_0_FinalizeProposalEvent, signature, transactionResponse);
      break;
    case "SpotSwapEvent":
      await handleSpotSwapEvent(event.data as SpotSwapEvent | v0_6_0_SpotSwapEvent, signature, transactionResponse);
      break;
    case "ConditionalSwapEvent":
      await handleConditionalSwapEvent(event.data as ConditionalSwapEvent | v0_6_0_ConditionalSwapEvent, signature, transactionResponse);
      break;
    case "ProvideLiquidityEvent":
      await handleProvideLiquidityEvent(event.data as ProvideLiquidityEvent | v0_6_0_ProvideLiquidityEvent, signature, transactionResponse);
      break;
    case "WithdrawLiquidityEvent":
      await handleWithdrawLiquidityEvent(event.data as WithdrawLiquidityEvent | v0_6_0_WithdrawLiquidityEvent, signature, transactionResponse);
      break;
    case "CollectFeesEvent":
      await handleCollectFeesEvent(event.data as CollectFeesEvent | v0_6_0_CollectFeesEvent, signature, transactionResponse);
      break;
    case "SponsorProposalEvent":
      await handleSponsorProposalEvent(event.data as SponsorProposalEvent, signature, transactionResponse);
      break;
    default:
      logger.info({ eventName: event.name }, "Unknown Futarchy event");
  }
}

async function handleInitializeDaoEvent(event: InitializeDaoEvent | v0_6_0_InitializeDaoEvent, _signature: string, _transactionResponse: VersionedTransactionResponse) {
  try {
    if (isGeyser) {
      const existingDao = await db.select()
        .from(schema.v0_6_daos)
        .where(eq(schema.v0_6_daos.daoAddr, event.dao.toString()))
        .limit(1);

      if (existingDao.length > 0) {
        await db.transaction(async (trx: DBTransaction) => {
          await insertTokenIfNotExists(trx, new PublicKey(existingDao[0].baseMintAcct));
          await insertTokenIfNotExists(trx, new PublicKey(existingDao[0].quoteMintAcct));
        });
      }
      return;
    }

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

async function handleUpdateDaoEvent(event: UpdateDaoEvent | v0_6_0_UpdateDaoEvent, _signature: string, _transactionResponse: VersionedTransactionResponse) {
  try {
    if (isGeyser) return;

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

async function handleInitializeProposalEvent(event: InitializeProposalEvent | v0_6_0_InitializeProposalEvent, _signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    if (isGeyser) {
      const existingProposal = await db.select()
        .from(schema.v0_6_proposals)
        .where(eq(schema.v0_6_proposals.proposalAddr, event.proposal.toString()))
        .limit(1);

      if (existingProposal.length > 0) {
        await db.transaction(async (trx: DBTransaction) => {
          await insertTokenIfNotExists(trx, new PublicKey(existingProposal[0].passBaseMint));
          await insertTokenIfNotExists(trx, new PublicKey(existingProposal[0].passQuoteMint));
          await insertTokenIfNotExists(trx, new PublicKey(existingProposal[0].failBaseMint));
          await insertTokenIfNotExists(trx, new PublicKey(existingProposal[0].failQuoteMint));
          await insertIfNotExistsMarkets(trx, event.proposal.toString(), event.dao.toString());
        });
      }
      return;
    }

    const proposalAcct = await futarchyClient.fetchProposal(event.proposal);
    if (!proposalAcct) {
      logger.warn(`Proposal account not found for ${event.proposal.toString()}`);
      return;
    }
    await db.transaction(async (trx: DBTransaction) => {
      await insertTokenIfNotExists(trx, proposalAcct.passBaseMint);
      await insertTokenIfNotExists(trx, proposalAcct.passQuoteMint);
      await insertTokenIfNotExists(trx, proposalAcct.failBaseMint);
      await insertTokenIfNotExists(trx, proposalAcct.failQuoteMint);
      const blockTime = transactionResponse.blockTime ? new Date(transactionResponse.blockTime * 1000) : null;
      await upsertV06Proposal(proposalAcct, event.proposal, BigInt(event.common.slot.toString()), blockTime, trx);
      await insertIfNotExistsMarkets(trx, event.proposal.toString(), event.dao.toString());
      // Update proposal_details with transaction index from Squads
      await updateProposalDetailsTransactionIndex(event.dao.toString(), event.proposal.toString(), trx);
    });
  } catch (error) {
    logger.error(error, "Error in handleInitializeProposalEvent");
  }
}

async function handleStakeToProposalEvent(event: StakeToProposalEvent | v0_6_0_StakeToProposalEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    const [stakePda] = getStakeAddr(
      futarchyClient.autocrat.programId,
      event.proposal,
      event.staker
    );

    if (isGeyser) {
      await db.transaction(async (trx: DBTransaction) => {
        await trx.insert(schema.v0_6_stakes).values({
          stakeAddr: stakePda.toString(),
          proposalAddr: event.proposal.toString(),
          txSignature: signature,
          stakerAddr: event.staker.toString(),
          amount: event.amount.toString(),
          type: "stake",
          slot: BigInt(event.common.slot.toString()),
          timestamp: new Date(event.common.unixTimestamp.mul(new BN(1000)).toNumber()),
        }).onConflictDoNothing({
          target: [schema.v0_6_stakes.proposalAddr, schema.v0_6_stakes.txSignature]
        });
      });
      return;
    }

    await db.transaction(async (trx: DBTransaction) => {
      let proposal = await trx.select()
        .from(schema.v0_6_proposals)
        .where(eq(schema.v0_6_proposals.proposalAddr, event.proposal.toString()))
        .limit(1);

      if (proposal.length === 0) {
        const proposalAcct = await futarchyClient.fetchProposal(event.proposal);
        if (proposalAcct) {
          const blockTime = transactionResponse.blockTime ? new Date(transactionResponse.blockTime * 1000) : null;
          await upsertV06Proposal(proposalAcct, event.proposal, BigInt(event.common.slot.toString()), blockTime, trx);
        } else {
          logger.warn(`Proposal ${event.proposal.toString()} not found for stake event`);
          return;
        }
      }

      let actualStakedAmount: string;
      try {
        const stakeAccountData = await futarchyClient.autocrat.account.stakeAccount.fetch(stakePda);
        actualStakedAmount = stakeAccountData.amount.toString();
      } catch {
        actualStakedAmount = event.amount.toString();
      }

      await trx.insert(schema.v0_6_staking_record).values({
        stakeAddr: stakePda.toString(),
        proposalAddr: event.proposal.toString(),
        stakerAddr: event.staker.toString(),
        totalStaked: actualStakedAmount,
        updatedAtSlot: BigInt(event.common.slot.toString()),
      }).onConflictDoUpdate({
        target: schema.v0_6_staking_record.stakeAddr,
        set: {
          totalStaked: sql`CASE WHEN ${BigInt(event.common.slot.toString())} >= ${schema.v0_6_staking_record.updatedAtSlot} THEN ${actualStakedAmount} ELSE ${schema.v0_6_staking_record.totalStaked} END`,
          updatedAtSlot: sql`GREATEST(${BigInt(event.common.slot.toString())}, ${schema.v0_6_staking_record.updatedAtSlot})`
        }
      });

      await trx.insert(schema.v0_6_stakes).values({
        stakeAddr: stakePda.toString(),
        proposalAddr: event.proposal.toString(),
        txSignature: signature,
        stakerAddr: event.staker.toString(),
        amount: event.amount.toString(),
        type: "stake",
        slot: BigInt(event.common.slot.toString()),
        timestamp: new Date(event.common.unixTimestamp.mul(new BN(1000)).toNumber()),
      }).onConflictDoNothing({
        target: [schema.v0_6_stakes.proposalAddr, schema.v0_6_stakes.txSignature]
      });
    });
  } catch (error) {
    logger.error(error, "Error in handleStakeToProposalEvent");
  }
}

async function handleUnstakeFromProposalEvent(event: UnstakeFromProposalEvent | v0_6_0_UnstakeFromProposalEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    const [stakePda] = getStakeAddr(
      futarchyClient.autocrat.programId,
      event.proposal,
      event.staker
    );

    if (isGeyser) {
      await db.transaction(async (trx: DBTransaction) => {
        await trx.insert(schema.v0_6_stakes).values({
          stakeAddr: stakePda.toString(),
          proposalAddr: event.proposal.toString(),
          txSignature: signature,
          stakerAddr: event.staker.toString(),
          amount: event.amount.toString(),
          type: "unstake",
          slot: BigInt(event.common.slot.toString()),
          timestamp: new Date(event.common.unixTimestamp.mul(new BN(1000)).toNumber()),
        }).onConflictDoNothing({
          target: [schema.v0_6_stakes.proposalAddr, schema.v0_6_stakes.txSignature]
        });
      });
      return;
    }

    await db.transaction(async (trx: DBTransaction) => {
      let proposal = await trx.select()
        .from(schema.v0_6_proposals)
        .where(eq(schema.v0_6_proposals.proposalAddr, event.proposal.toString()))
        .limit(1);

      if (proposal.length === 0) {
        const proposalAcct = await futarchyClient.fetchProposal(event.proposal);
        if (proposalAcct) {
          const blockTime = transactionResponse.blockTime ? new Date(transactionResponse.blockTime * 1000) : null;
          await upsertV06Proposal(proposalAcct, event.proposal, BigInt(event.common.slot.toString()), blockTime, trx);
        } else {
          logger.warn(`Proposal ${event.proposal.toString()} not found for unstake event`);
          return;
        }
      }

      let actualStakedAmount: string;
      try {
        const stakeAccountData = await futarchyClient.autocrat.account.stakeAccount.fetch(stakePda);
        actualStakedAmount = stakeAccountData.amount.toString();
      } catch {
        actualStakedAmount = "0";
      }

      await trx.insert(schema.v0_6_staking_record).values({
        stakeAddr: stakePda.toString(),
        proposalAddr: event.proposal.toString(),
        stakerAddr: event.staker.toString(),
        totalStaked: actualStakedAmount,
        updatedAtSlot: BigInt(event.common.slot.toString()),
      }).onConflictDoUpdate({
        target: schema.v0_6_staking_record.stakeAddr,
        set: {
          totalStaked: sql`CASE WHEN ${BigInt(event.common.slot.toString())} >= ${schema.v0_6_staking_record.updatedAtSlot} THEN ${actualStakedAmount} ELSE ${schema.v0_6_staking_record.totalStaked} END`,
          updatedAtSlot: sql`GREATEST(${BigInt(event.common.slot.toString())}, ${schema.v0_6_staking_record.updatedAtSlot})`
        }
      });

      await trx.insert(schema.v0_6_stakes).values({
        stakeAddr: stakePda.toString(),
        proposalAddr: event.proposal.toString(),
        txSignature: signature,
        stakerAddr: event.staker.toString(),
        amount: event.amount.toString(),
        type: "unstake",
        slot: BigInt(event.common.slot.toString()),
        timestamp: new Date(event.common.unixTimestamp.mul(new BN(1000)).toNumber()),
      }).onConflictDoNothing({
        target: [schema.v0_6_stakes.proposalAddr, schema.v0_6_stakes.txSignature]
      });
    });
  } catch (error) {
    logger.error(error, "Error in handleUnstakeFromProposalEvent");
  }
}

async function handleLaunchProposalEvent(event: LaunchProposalEvent | v0_6_0_LaunchProposalEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
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

          // timestampEnqueued only exists in newer v0.6.1+ events
          if ('timestampEnqueued' in event) {
            await trx.update(schema.v0_6_proposals).set({
              launchedAt: new Date((event as LaunchProposalEvent).timestampEnqueued.mul(new BN(1000)).toNumber()),
            }).where(eq(schema.v0_6_proposals.proposalAddr, event.proposal.toString()));
          }

        } catch (fetchError) {
          logger.warn(`Could not fetch AMM vault balances for DAO ${event.dao.toString()}: ${fetchError}`);
          // Fallback: just update seqNum
          await trx.update(schema.v0_6_daos).set({
            seqNum: BigInt(event.common.daoSeqNum.toString()),
          }).where(eq(schema.v0_6_daos.daoAddr, event.dao.toString()));
        }
      }

      await insertIfNotExistsMarkets(trx, event.proposal.toString(), event.dao.toString())
      await insertIfNotExistsPrices(trx, event, event.proposal.toString(), event.common.slot);

      logger.info(`Launched proposal ${event.proposal.toString()}`);
    });
  } catch (error) {
    logger.error(error, "Error in handleLaunchProposalEvent");
  }
}

async function handleFinalizeProposalEvent(event: FinalizeProposalEvent | v0_6_0_FinalizeProposalEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    const proposalAcct = await futarchyClient.fetchProposal(event.proposal);

    if (!proposalAcct) {
      logger.warn(`Proposal account not found for ${event.proposal.toString()}`);
      return;
    }

    await db.transaction(async (trx: DBTransaction) => {
      const blockTime = transactionResponse.blockTime ? new Date(transactionResponse.blockTime * 1000) : null;
      await upsertV06Proposal(proposalAcct, event.proposal, BigInt(event.common.slot.toString()), blockTime, trx);

      await insertIfNotExistsPrices(trx, event, event.proposal.toString(), event.common.slot);
    });

  } catch (error) {
    logger.error(error, "Error in handleFinalizeProposalEvent");
  }
}

async function handleSpotSwapEvent(event: SpotSwapEvent | v0_6_0_SpotSwapEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
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

      const proposal = await getActiveProposalForDao(trx, event.dao.toString(), 'event');

      if (proposal) {
        await insertIfNotExistsMarkets(trx, proposal.toString(), event.dao.toString())
        await insertIfNotExistsPrices(trx, event, proposal, event.common.slot, ['spot']);
      }

      logger.info(`Spot swap: ${event.inputAmount.toString()} input, ${event.outputAmount.toString()} output on DAO ${event.dao.toString()}`);
    });
  } catch (error) {
    logger.error(error, "Error in handleSpotSwapEvent");
  }
}

async function handleConditionalSwapEvent(event: ConditionalSwapEvent | v0_6_0_ConditionalSwapEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
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

      await insertIfNotExistsMarkets(trx, event.proposal.toString(), event.dao.toString(), ['pass', 'fail', 'spot'])
      await insertIfNotExistsPrices(trx, event, event.proposal.toString(), event.common.slot, ['pass', 'fail', 'spot']);
      await insertIfNotExistsTwaps(trx, event, event.proposal.toString(), event.common.slot);

      logger.info(`Conditional swap on ${marketType} market: ${event.inputAmount.toString()} input, ${event.outputAmount.toString()} output`);
    });
  } catch (error) {
    logger.error(error, "Error in handleConditionalSwapEvent");
  }
}

async function handleProvideLiquidityEvent(event: ProvideLiquidityEvent | v0_6_0_ProvideLiquidityEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
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

      // Derive ammPosition PDA - positionAuthority is available in ProvideLiquidityEvent
      const [ammPositionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("amm_position"),
          event.dao.toBuffer(),
          event.positionAuthority.toBuffer(),
        ],
        futarchyClient.autocrat.programId
      );

      // Upsert AmmPosition - only in RPC mode (gRPC handles via account streaming)
      if (!isGeyser) {
        const ammPositionAcct = await futarchyClient.autocrat.account.ammPosition.fetch(ammPositionPda);
        await trx.insert(schema.v0_6_amm_positions).values({
          ammPositionAddr: ammPositionPda.toString(),
          daoAddr: event.dao.toString(),
          positionAuthority: event.positionAuthority.toString(),
          liquidity: ammPositionAcct.liquidity.toString(),
          updatedAtSlot: BigInt(event.common.slot.toString()),
        }).onConflictDoUpdate({
          target: schema.v0_6_amm_positions.ammPositionAddr,
          set: {
            liquidity: ammPositionAcct.liquidity.toString(),
            updatedAtSlot: sql`GREATEST(${BigInt(event.common.slot.toString())}, ${schema.v0_6_amm_positions.updatedAtSlot})`,
          }
        });
      }

      // Insert liquidity event
      await trx.insert(schema.v0_6_liquidity_events).values({
        ammPositionAddr: ammPositionPda.toString(),
        daoAddr: event.dao.toString(),
        txSignature: signature,
        eventType: "provide",
        baseAmount: BigInt(event.baseAmount.toString()),
        quoteAmount: BigInt(event.quoteAmount.toString()),
        liquidityDelta: event.liquidityMinted.toString(),
        slot: BigInt(event.common.slot.toString()),
        timestamp: new Date(event.common.unixTimestamp.mul(new BN(1000)).toNumber()),
      }).onConflictDoNothing();

      const proposal = await getActiveProposalForDao(trx, event.dao.toString(), 'event');

      if (proposal) {
        await insertIfNotExistsMarkets(trx, proposal.toString(), event.dao.toString())
        await insertIfNotExistsPrices(trx, event, proposal, event.common.slot, ['pass', 'fail']);
      }

      logger.info(`Liquidity provided: ${event.baseAmount.toString()} base, ${event.quoteAmount.toString()} quote, ${event.liquidityMinted.toString()} LP tokens minted`);
    });
  } catch (error) {
    logger.error(error, "Error in handleProvideLiquidityEvent");
  }
}

async function handleWithdrawLiquidityEvent(event: WithdrawLiquidityEvent | v0_6_0_WithdrawLiquidityEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
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

      // Derive ammPosition PDA - liquidityProvider IS positionAuthority (enforced by program)
      const [ammPositionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("amm_position"),
          event.dao.toBuffer(),
          event.liquidityProvider.toBuffer(),
        ],
        futarchyClient.autocrat.programId
      );

      // Update AmmPosition - only in RPC mode (gRPC handles via account streaming)
      if (!isGeyser) {
        const ammPositionAcct = await futarchyClient.autocrat.account.ammPosition.fetch(ammPositionPda);
        await trx.update(schema.v0_6_amm_positions).set({
          liquidity: ammPositionAcct.liquidity.toString(),
          updatedAtSlot: sql`GREATEST(${BigInt(event.common.slot.toString())}, ${schema.v0_6_amm_positions.updatedAtSlot})`,
        }).where(eq(schema.v0_6_amm_positions.ammPositionAddr, ammPositionPda.toString()));
      }

      // Insert liquidity event
      await trx.insert(schema.v0_6_liquidity_events).values({
        ammPositionAddr: ammPositionPda.toString(),
        daoAddr: event.dao.toString(),
        txSignature: signature,
        eventType: "withdraw",
        baseAmount: BigInt(event.baseAmount.toString()),
        quoteAmount: BigInt(event.quoteAmount.toString()),
        liquidityDelta: event.liquidityWithdrawn.toString(),
        slot: BigInt(event.common.slot.toString()),
        timestamp: new Date(event.common.unixTimestamp.mul(new BN(1000)).toNumber()),
      }).onConflictDoNothing();

      const proposal = await getActiveProposalForDao(trx, event.dao.toString(), 'event');

      if (proposal) {
        await insertIfNotExistsMarkets(trx, proposal.toString(), event.dao.toString())
        await insertIfNotExistsPrices(trx, event, proposal, event.common.slot, ['pass', 'fail']);
      }

      logger.info(`Liquidity withdrawn: ${event.liquidityWithdrawn.toString()} LP tokens burned, ${event.baseAmount.toString()} base, ${event.quoteAmount.toString()} quote received`);
    });
  } catch (error) {
    logger.error(error, "Error in handleWithdrawLiquidityEvent");
  }
}

async function handleCollectFeesEvent(event: CollectFeesEvent | v0_6_0_CollectFeesEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      // Extract reserves from postAmmState
      const { baseReserves, quoteReserves } = extractReservesFromAmmState(event.postAmmState);

      // Insert fee collection record
      await trx.insert(schema.v0_6_fee_collections).values({
        daoAddr: event.dao.toString(),
        signature: signature,
        slot: BigInt(event.common.slot.toString()),
        unixTimestamp: BigInt(event.common.unixTimestamp.toString()),
        baseTokenAccount: event.baseTokenAccount.toString(),
        quoteTokenAccount: event.quoteTokenAccount.toString(),
        baseFeesCollected: BigInt(event.baseFeesCollected.toString()),
        quoteFeesCollected: BigInt(event.quoteFeesCollected.toString()),
      }).onConflictDoNothing();

      // Update DAO AMM reserves after fee collection
      await trx.update(schema.v0_6_daos).set({
        ammBaseAmount: baseReserves,
        ammQuoteAmount: quoteReserves,
        seqNum: BigInt(event.common.daoSeqNum.toString()),
      }).where(eq(schema.v0_6_daos.daoAddr, event.dao.toString()));

      logger.info(`Fees collected for DAO ${event.dao.toString()}: ${event.baseFeesCollected.toString()} base, ${event.quoteFeesCollected.toString()} quote`);
    });
  } catch (error) {
    logger.error(error, "Error in handleCollectFeesEvent");
  }
}

async function handleSponsorProposalEvent(event: SponsorProposalEvent, _signature: string, _transactionResponse: VersionedTransactionResponse) {
  try {
    await db.update(schema.v0_6_proposals).set({
      isTeamSponsored: true,
    }).where(eq(schema.v0_6_proposals.proposalAddr, event.proposal.toString()));

    logger.info(`Proposal ${event.proposal.toString()} sponsored by ${event.teamAddress.toString()}`);
  } catch (error) {
    logger.error(error, "Error in handleSponsorProposalEvent");
  }
}

// Account update handlers
export async function processFutarchyAccountUpdate(
  pubkey: string,
  accountType: string,
  accountData: any,
  slot: bigint
) {
  switch (accountType) {
    case 'dao':
      await upsertV06Dao(accountData, new PublicKey(pubkey), db, slot);
      // Insert spot prices from AMM state when DAO is updated
      await insertPricesFromAmmState(db, pubkey, accountData, slot);
      break;
    case 'proposal':
      // Insert conditional tokens before upserting proposal (FK constraint)
      await insertTokenIfNotExists(db, accountData.passBaseMint);
      await insertTokenIfNotExists(db, accountData.passQuoteMint);
      await insertTokenIfNotExists(db, accountData.failBaseMint);
      await insertTokenIfNotExists(db, accountData.failQuoteMint);
      await upsertV06Proposal(accountData, new PublicKey(pubkey), slot, null, db);
      break;
    case 'stakeAccount':
      await db.update(schema.v0_6_staking_record).set({
        totalStaked: accountData.amount.toString(),
        updatedAtSlot: slot,
      }).where(eq(schema.v0_6_staking_record.stakeAddr, pubkey));
      break;
    case 'ammPosition':
      await db.insert(schema.v0_6_amm_positions).values({
        ammPositionAddr: pubkey,
        daoAddr: accountData.dao.toString(),
        positionAuthority: accountData.positionAuthority.toString(),
        liquidity: accountData.liquidity.toString(),
        updatedAtSlot: slot,
      }).onConflictDoUpdate({
        target: schema.v0_6_amm_positions.ammPositionAddr,
        set: {
          liquidity: accountData.liquidity.toString(),
          updatedAtSlot: sql`GREATEST(${slot}, ${schema.v0_6_amm_positions.updatedAtSlot})`,
        },
      });
      break;
    default:
      logger.debug({ pubkey, accountType }, "Unknown Futarchy account type in update");
  }
}
