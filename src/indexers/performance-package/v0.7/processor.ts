import {
  PriceBasedPerformancePackageEvent,
  PerformancePackageInitializedEvent,
  UnlockStartedEvent,
  UnlockCompletedEvent,
  // ChangeProposedEvent,
  ChangeExecutedEvent,
  PerformancePackageAuthorityChangedEvent,
} from "@metadaoproject/futarchy/v0.7";
import { schema, db, eq, sql, DBTransaction } from "@metadaoproject/indexer-db";
import { PublicKey } from "@solana/web3.js";
import type { VersionedTransactionResponse } from "@solana/web3.js";
import { log } from "../../../logger/logger";
import { BN } from "@coral-xyz/anchor";
import { priceBasedPerformancePackageClient } from "../../../connections/v0.7";
import { insertTokenIfNotExists } from "../../shared/utils";

const logger = log.child({
  module: "performance-package-v0.7-processor"
});

export async function processPerformancePackageEvent(
  event: { name: string; data: PriceBasedPerformancePackageEvent },
  signature: string,
  transactionResponse: VersionedTransactionResponse
) {
  switch (event.name) {
    case "PerformancePackageInitialized":
      await handlePerformancePackageInitializedEvent(event.data as PerformancePackageInitializedEvent, signature, transactionResponse);
      break;
    case "UnlockStarted":
      await handleUnlockStartedEvent(event.data as UnlockStartedEvent, signature, transactionResponse);
      break;
    case "UnlockCompleted":
      await handleUnlockCompletedEvent(event.data as UnlockCompletedEvent, signature, transactionResponse);
      break;
    // case "ChangeProposed":
    //   await handleChangeProposedEvent(event.data as ChangeProposedEvent, signature, transactionResponse);
    //   break;
    case "ChangeExecuted":
      await handleChangeExecutedEvent(event.data as ChangeExecutedEvent, signature, transactionResponse);
      break;
    case "PerformancePackageAuthorityChanged":
      await handlePerformancePackageAuthorityChangedEvent(event.data as PerformancePackageAuthorityChangedEvent, signature, transactionResponse);
      break;
    default:
      logger.info({ eventName: event.name }, "Unknown PerformancePackage event");
  }
}

async function handlePerformancePackageInitializedEvent(
  event: PerformancePackageInitializedEvent,
  signature: string,
  transactionResponse: VersionedTransactionResponse
) {
  try {
    // Fetch the full account to get all fields since event only has performancePackage address
    const account = await priceBasedPerformancePackageClient.program.account.performancePackage.fetch(
      event.performancePackage
    );

    await db.transaction(async (trx: DBTransaction) => {
      const [existing] = await trx.select()
        .from(schema.v0_6_performance_packages)
        .where(eq(schema.v0_6_performance_packages.performancePackageAddr, event.performancePackage.toString()))
        .limit(1);

      if (existing) {
        logger.info(`PerformancePackage ${event.performancePackage.toString()} already exists`);
        return;
      }

      await insertTokenIfNotExists(trx, account.tokenMint);

      // Map state to string
      let stateStr = "Locked";
      if ('unlockStarted' in account.state) {
        stateStr = "UnlockStarted";
      } else if ('unlocked' in account.state) {
        stateStr = "Unlocked";
      }

      await trx.insert(schema.v0_6_performance_packages).values({
        performancePackageAddr: event.performancePackage.toString(),
        recipient: account.recipient.toString(),
        tokenMint: account.tokenMint.toString(),
        performancePackageAuthority: account.performancePackageAuthority.toString(),
        performancePackageTokenVault: account.performancePackageTokenVault.toString(),
        totalTokenAmount: BigInt(account.totalTokenAmount.toString()),
        alreadyUnlockedAmount: BigInt(account.alreadyUnlockedAmount.toString()),
        minUnlockTimestamp: BigInt(account.minUnlockTimestamp.toString()),
        twapLengthSeconds: account.twapLengthSeconds,
        state: stateStr,
        tranches: account.tranches,
        seqNum: BigInt(account.seqNum.toString()),
        pdaBump: account.pdaBump,
        updatedAtSlot: BigInt(event.common.slot.toString()),
      }).onConflictDoNothing();

      logger.info(`PerformancePackage initialized: ${event.performancePackage.toString()}`);
    });
  } catch (error) {
    logger.error(error, "Error in handlePerformancePackageInitializedEvent");
  }
}

async function handleUnlockStartedEvent(
  event: UnlockStartedEvent,
  signature: string,
  transactionResponse: VersionedTransactionResponse
) {
  try {
    await db.transaction(async (trx: DBTransaction) => {
      await trx.update(schema.v0_6_performance_packages).set({
        state: "UnlockStarted",
        seqNum: BigInt(event.common.performancePackageSeqNum.toString()),
        updatedAtSlot: sql`GREATEST(${BigInt(event.common.slot.toString())}, ${schema.v0_6_performance_packages.updatedAtSlot})`,
      }).where(eq(schema.v0_6_performance_packages.performancePackageAddr, event.performancePackage.toString()));

      logger.info(`UnlockStarted for PerformancePackage: ${event.performancePackage.toString()}`);
    });
  } catch (error) {
    logger.error(error, "Error in handleUnlockStartedEvent");
  }
}

async function handleUnlockCompletedEvent(
  event: UnlockCompletedEvent,
  signature: string,
  transactionResponse: VersionedTransactionResponse
) {
  try {
    // Insert unlock record
    await db.insert(schema.v0_6_performance_package_unlocks).values({
      performancePackageAddr: event.performancePackage.toString(),
      txSignature: signature,
      tokenAmount: BigInt(event.tokenAmount.toString()),
      recipient: event.recipient.toString(),
      twapPrice: event.twapPrice.toString(),
      slot: BigInt(event.common.slot.toString()),
      timestamp: new Date(Number(event.common.unixTimestamp) * 1000),
    }).onConflictDoNothing();

    // Fetch account to get canonical state
    try {
      const account = await priceBasedPerformancePackageClient.program.account.performancePackage.fetch(
        new PublicKey(event.performancePackage.toString())
      );

      let stateStr = "Locked";
      if ('unlockStarted' in account.state) {
        stateStr = "UnlockStarted";
      } else if ('unlocked' in account.state) {
        stateStr = "Unlocked";
      }

      await db.update(schema.v0_6_performance_packages).set({
        alreadyUnlockedAmount: BigInt(account.alreadyUnlockedAmount.toString()),
        state: stateStr,
        seqNum: BigInt(account.seqNum.toString()),
        updatedAtSlot: sql`GREATEST(${BigInt(event.common.slot.toString())}, ${schema.v0_6_performance_packages.updatedAtSlot})`,
      }).where(eq(schema.v0_6_performance_packages.performancePackageAddr, event.performancePackage.toString()));
    } catch (fetchError) {
      // Account might be closed after full unlock - mark as fully unlocked
      logger.debug({ performancePackage: event.performancePackage.toString() }, "Could not fetch account after unlock, may be closed");
      await db.update(schema.v0_6_performance_packages).set({
        state: "Unlocked",
        updatedAtSlot: sql`GREATEST(${BigInt(event.common.slot.toString())}, ${schema.v0_6_performance_packages.updatedAtSlot})`,
      }).where(eq(schema.v0_6_performance_packages.performancePackageAddr, event.performancePackage.toString()));
    }

    logger.info(`UnlockCompleted for PerformancePackage: ${event.performancePackage.toString()}, amount: ${event.tokenAmount.toString()}`);
  } catch (error) {
    logger.error(error, "Error in handleUnlockCompletedEvent");
  }
}

// async function handleChangeProposedEvent(
//   event: ChangeProposedEvent,
//   _signature: string,
//   _transactionResponse: VersionedTransactionResponse
// ) {
//   // Just log for now - we're not tracking change requests table
//   logger.info({
//     locker: event.locker.toString(),
//     changeRequest: event.changeRequest.toString(),
//     proposer: event.proposer.toString(),
//   }, "ChangeProposed event");
// }

async function handleChangeExecutedEvent(
  event: ChangeExecutedEvent,
  signature: string,
  transactionResponse: VersionedTransactionResponse
) {
  try {
    // Fetch the updated account to sync state
    const account = await priceBasedPerformancePackageClient.program.account.performancePackage.fetch(
      new PublicKey(event.performancePackage.toString())
    );

    let stateStr = "Locked";
    if ('unlockStarted' in account.state) {
      stateStr = "UnlockStarted";
    } else if ('unlocked' in account.state) {
      stateStr = "Unlocked";
    }

    await db.update(schema.v0_6_performance_packages).set({
      recipient: account.recipient.toString(),
      performancePackageAuthority: account.performancePackageAuthority.toString(),
      tranches: account.tranches,
      state: stateStr,
      seqNum: BigInt(account.seqNum.toString()),
      updatedAtSlot: BigInt(transactionResponse.slot),
    }).where(eq(schema.v0_6_performance_packages.performancePackageAddr, event.performancePackage.toString()));

    logger.info(`ChangeExecuted for PerformancePackage: ${event.performancePackage.toString()}`);
  } catch (error) {
    logger.error(error, "Error in handleChangeExecutedEvent");
  }
}

async function handlePerformancePackageAuthorityChangedEvent(
  event: PerformancePackageAuthorityChangedEvent,
  signature: string,
  transactionResponse: VersionedTransactionResponse
) {
  try {
    await db.update(schema.v0_6_performance_packages).set({
      performancePackageAuthority: event.newAuthority.toString(),
      seqNum: BigInt(event.common.performancePackageSeqNum.toString()),
      updatedAtSlot: BigInt(event.common.slot.toString()),
    }).where(eq(schema.v0_6_performance_packages.performancePackageAddr, event.locker.toString()));

    logger.info(`PerformancePackageAuthorityChanged: ${event.locker.toString()} -> ${event.newAuthority.toString()}`);
  } catch (error) {
    logger.error(error, "Error in handlePerformancePackageAuthorityChangedEvent");
  }
}

// Account update handler for streaming/geyser updates
export async function processPerformancePackageAccountUpdate(
  pubkey: string,
  accountType: string,
  accountData: any,
  slot: bigint
) {
  if (accountType !== 'performancePackage') {
    logger.debug({ pubkey, accountType }, "Unknown PerformancePackage account type");
    return;
  }

  try {
    let stateStr = "Locked";
    if ('unlockStarted' in accountData.state) {
      stateStr = "UnlockStarted";
    } else if ('unlocked' in accountData.state) {
      stateStr = "Unlocked";
    }

    await db.insert(schema.v0_6_performance_packages).values({
      performancePackageAddr: pubkey,
      recipient: accountData.recipient.toString(),
      tokenMint: accountData.tokenMint.toString(),
      performancePackageAuthority: accountData.performancePackageAuthority.toString(),
      performancePackageTokenVault: accountData.performancePackageTokenVault.toString(),
      totalTokenAmount: BigInt(accountData.totalTokenAmount.toString()),
      alreadyUnlockedAmount: BigInt(accountData.alreadyUnlockedAmount.toString()),
      minUnlockTimestamp: BigInt(accountData.minUnlockTimestamp.toString()),
      twapLengthSeconds: accountData.twapLengthSeconds,
      state: stateStr,
      tranches: accountData.tranches,
      seqNum: BigInt(accountData.seqNum.toString()),
      pdaBump: accountData.pdaBump,
      updatedAtSlot: slot,
    }).onConflictDoUpdate({
      target: schema.v0_6_performance_packages.performancePackageAddr,
      set: {
        recipient: accountData.recipient.toString(),
        performancePackageAuthority: accountData.performancePackageAuthority.toString(),
        totalTokenAmount: BigInt(accountData.totalTokenAmount.toString()),
        alreadyUnlockedAmount: BigInt(accountData.alreadyUnlockedAmount.toString()),
        state: stateStr,
        tranches: accountData.tranches,
        seqNum: sql`CASE WHEN ${slot} >= ${schema.v0_6_performance_packages.updatedAtSlot} THEN ${BigInt(accountData.seqNum.toString())} ELSE ${schema.v0_6_performance_packages.seqNum} END`,
        updatedAtSlot: sql`GREATEST(${slot}, ${schema.v0_6_performance_packages.updatedAtSlot})`,
      }
    });
  } catch (error) {
    logger.error(error, "Error in processPerformancePackageAccountUpdate");
  }
}
