import { schema, db } from "@metadaoproject/indexer-db";
import { bidWallClient } from "../../../connections/v0.7";
import { log } from "../../../logger/logger";

const logger = log.child({
  module: "bid-wall-v0.7-snapshot"
});

export async function snapshotBidWallAccounts(): Promise<void> {
  logger.info("Starting BidWall account snapshot");

  try {
    const bidWalls = await bidWallClient.bidWallProgram.account.bidWall.all();
    logger.info({ count: bidWalls.length }, "Fetched BidWall accounts");

    for (const { publicKey, account } of bidWalls) {
      await db.insert(schema.v0_7_bid_walls).values({
        bidWallAddr: publicKey.toString(),
        nonce: BigInt(account.nonce.toString()),
        createdTimestamp: BigInt(account.createdTimestamp.toString()),
        initialAmmQuoteReserves: BigInt(account.initialAmmQuoteReserves.toString()),
        quoteAmount: BigInt(account.quoteAmount.toString()),
        feesCollected: BigInt(account.feesCollected.toString()),
        baseBoughtAmount: BigInt(account.baseBoughtAmount.toString()),
        seqNum: BigInt(account.seqNum.toString()),
        creator: account.creator.toString(),
        authority: account.authority.toString(),
        daoTreasury: account.daoTreasury.toString(),
        baseMint: account.baseMint.toString(),
        feeRecipient: account.feeRecipient.toString(),
        durationSeconds: account.durationSeconds,
        pdaBump: account.pdaBump,
        isClosed: false,
        isCanceled: false,
        updatedAtSlot: 0n,
      }).onConflictDoNothing();
    }

    logger.info({ count: bidWalls.length }, "Completed BidWall account snapshot");
  } catch (error) {
    logger.error(error, "Error in snapshotBidWallAccounts");
    throw error;
  }
}
