import {
  BidWallEvent,
  BidWallInitializedEvent,
  BidWallTokensSoldEvent,
  BidWallFeesCollectedEvent,
  BidWallClosedEvent,
  BidWallCanceledEvent,
} from "@metadaoproject/futarchy/v0.7";
import { schema, db, eq, DBTransaction } from "@metadaoproject/indexer-db";
import type { VersionedTransactionResponse } from "@solana/web3.js";
import { log } from "../../../logger/logger";
import { BN } from "@coral-xyz/anchor";

const logger = log.child({
  module: "bid-wall-v0.7-processor"
});

export async function processBidWallEvent(
  event: { name: string; data: BidWallEvent },
  signature: string,
  transactionResponse: VersionedTransactionResponse
) {
  switch (event.name) {
    case "BidWallInitializedEvent":
      await handleBidWallInitializedEvent(event.data as BidWallInitializedEvent, signature, transactionResponse);
      break;
    case "BidWallTokensSoldEvent":
      await handleBidWallTokensSoldEvent(event.data as BidWallTokensSoldEvent, signature, transactionResponse);
      break;
    case "BidWallFeesCollectedEvent":
      await handleBidWallFeesCollectedEvent(event.data as BidWallFeesCollectedEvent, signature, transactionResponse);
      break;
    case "BidWallClosedEvent":
      await handleBidWallClosedEvent(event.data as BidWallClosedEvent, signature, transactionResponse);
      break;
    case "BidWallCanceledEvent":
      await handleBidWallCanceledEvent(event.data as BidWallCanceledEvent, signature, transactionResponse);
      break;
    default:
      logger.info({ eventName: event.name }, "Unknown BidWall event");
  }
}

async function handleBidWallInitializedEvent(
  event: BidWallInitializedEvent,
  signature: string,
  transactionResponse: VersionedTransactionResponse
) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      const [existing] = await trx.select()
        .from(schema.v0_7_bid_walls)
        .where(eq(schema.v0_7_bid_walls.bidWallAddr, event.bidWall.toString()))
        .limit(1);

      if (existing) {
        logger.info(`BidWall ${event.bidWall.toString()} already exists`);
        return;
      }

      await trx.insert(schema.v0_7_bid_walls).values({
        bidWallAddr: event.bidWall.toString(),
        nonce: BigInt(event.nonce.toString()),
        createdTimestamp: BigInt(event.common.unixTimestamp.toString()),
        initialAmmQuoteReserves: BigInt(event.initialAmmQuoteReserves.toString()),
        quoteAmount: BigInt(event.amount.toString()),
        feesCollected: 0n,
        baseBoughtAmount: 0n,
        seqNum: BigInt(event.common.bidWallSeqNum.toString()),
        creator: event.creator.toString(),
        authority: event.authority.toString(),
        daoTreasury: event.daoTreasury.toString(),
        baseMint: event.baseMint.toString(),
        feeRecipient: event.feeRecipient.toString(),
        durationSeconds: event.durationSeconds,
        pdaBump: event.pdaBump,
        isClosed: false,
        isCanceled: false,
        updatedAtSlot: BigInt(event.common.slot.toString()),
      }).onConflictDoNothing();
    });
  } catch (error) {
    logger.error(error, "Error in handleBidWallInitializedEvent");
  }
}

async function handleBidWallTokensSoldEvent(
  event: BidWallTokensSoldEvent,
  signature: string,
  transactionResponse: VersionedTransactionResponse
) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      // Insert sale record
      await trx.insert(schema.v0_7_bid_wall_sales).values({
        bidWallAddr: event.bidWall.toString(),
        txSignature: signature,
        user: event.user.toString(),
        amountIn: BigInt(event.amountIn.toString()),
        amountOut: BigInt(event.amountOut.toString()),
        fee: BigInt(event.fee.toString()),
        slot: BigInt(event.common.slot.toString()),
        timestamp: new Date(new BN(event.common.unixTimestamp).mul(new BN(1000)).toNumber()),
      });

      // Update bid wall state
      await trx.update(schema.v0_7_bid_walls).set({
        quoteAmount: BigInt(event.postBidWallQuoteTokenAccountAmount.toString()),
        baseBoughtAmount: BigInt(event.postBidWallBaseBoughtAmount.toString()),
        seqNum: BigInt(event.common.bidWallSeqNum.toString()),
        updatedAtSlot: BigInt(event.common.slot.toString()),
      }).where(eq(schema.v0_7_bid_walls.bidWallAddr, event.bidWall.toString()));
    });
  } catch (error) {
    logger.error(error, "Error in handleBidWallTokensSoldEvent");
  }
}

async function handleBidWallFeesCollectedEvent(
  event: BidWallFeesCollectedEvent,
  signature: string,
  transactionResponse: VersionedTransactionResponse
) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      // Insert fee collection record
      await trx.insert(schema.v0_7_bid_wall_fee_collections).values({
        bidWallAddr: event.bidWall.toString(),
        txSignature: signature,
        feesCollected: BigInt(event.feesCollected.toString()),
        slot: BigInt(event.common.slot.toString()),
        timestamp: new Date(new BN(event.common.unixTimestamp).mul(new BN(1000)).toNumber()),
      });

      // Update bid wall state
      await trx.update(schema.v0_7_bid_walls).set({
        quoteAmount: BigInt(event.postBidWallQuoteTokenAccountAmount.toString()),
        seqNum: BigInt(event.common.bidWallSeqNum.toString()),
        updatedAtSlot: BigInt(event.common.slot.toString()),
      }).where(eq(schema.v0_7_bid_walls.bidWallAddr, event.bidWall.toString()));
    });
  } catch (error) {
    logger.error(error, "Error in handleBidWallFeesCollectedEvent");
  }
}

async function handleBidWallClosedEvent(
  event: BidWallClosedEvent,
  signature: string,
  transactionResponse: VersionedTransactionResponse
) {
  try {
    await db.update(schema.v0_7_bid_walls).set({
      isClosed: true,
      seqNum: BigInt(event.common.bidWallSeqNum.toString()),
      updatedAtSlot: BigInt(event.common.slot.toString()),
    }).where(eq(schema.v0_7_bid_walls.bidWallAddr, event.bidWall.toString()));
  } catch (error) {
    logger.error(error, "Error in handleBidWallClosedEvent");
  }
}

async function handleBidWallCanceledEvent(
  event: BidWallCanceledEvent,
  signature: string,
  transactionResponse: VersionedTransactionResponse
) {
  try {
    await db.update(schema.v0_7_bid_walls).set({
      isCanceled: true,
      seqNum: BigInt(event.common.bidWallSeqNum.toString()),
      updatedAtSlot: BigInt(event.common.slot.toString()),
    }).where(eq(schema.v0_7_bid_walls.bidWallAddr, event.bidWall.toString()));
  } catch (error) {
    logger.error(error, "Error in handleBidWallCanceledEvent");
  }
}

export async function processBidWallAccountUpdate(
  pubkey: string,
  accountType: string,
  accountData: any,
  slot: bigint
) {
  switch (accountType) {
    case 'bidWall':
      logger.debug({ pubkey, slot: slot.toString() }, "v0.7 BidWall account update");
      // TODO: Add upsertBidWall function if needed
      break;
    default:
      logger.debug({ pubkey, accountType }, "Unknown BidWall account type in update");
  }
}
