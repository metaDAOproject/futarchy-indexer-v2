import { schema, db } from "@metadaoproject/indexer-db";
import { priceBasedPerformancePackageClient } from "../../../connections/v0.7";
import { log } from "../../../logger/logger";
import { insertTokenIfNotExists } from "../../shared/utils";

const logger = log.child({
  module: "performance-package-v0.7-snapshot"
});

export async function snapshotPerformancePackageAccounts(): Promise<void> {
  logger.info("Starting PerformancePackage account snapshot");

  try {
    const packages = await priceBasedPerformancePackageClient.program.account.performancePackage.all();
    logger.info({ count: packages.length }, "Fetched PerformancePackage accounts");

    for (const { publicKey, account } of packages) {
      try {
        // Insert token if it doesn't exist
        await insertTokenIfNotExists(db, account.tokenMint);

        // Map state to string
        let stateStr = "Locked";
        if ('unlockStarted' in account.state) {
          stateStr = "UnlockStarted";
        } else if ('unlocked' in account.state) {
          stateStr = "Unlocked";
        }

        await db.insert(schema.v0_7_performance_packages).values({
          performancePackageAddr: publicKey.toString(),
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
          updatedAtSlot: 0n,
        }).onConflictDoNothing();
      } catch (error) {
        logger.warn({ error, pubkey: publicKey.toString() }, "Error snapshotting PerformancePackage account");
      }
    }

    logger.info({ count: packages.length }, "Completed PerformancePackage account snapshot");
  } catch (error) {
    logger.error(error, "Error in snapshotPerformancePackageAccounts");
    throw error;
  }
}
