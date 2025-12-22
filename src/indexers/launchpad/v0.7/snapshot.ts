import { db, schema } from "@metadaoproject/indexer-db";
import { launchpadV7Client } from "../../../connections/v0.7";
import { insertTokenIfNotExists } from "../../shared/utils";
import { V06LaunchState } from "@metadaoproject/indexer-db/lib/schema";
import { log } from "../../../logger/logger";

const logger = log.child({ module: "launchpad-v0.7-snapshot" });

/**
 * Snapshot all launchpad v0.7 accounts (launches, funding records)
 * This runs .all() for each account type and inserts with onConflictDoNothing()
 * to quickly get current state before signature crawl
 */
export async function snapshotLaunchpadV7Accounts(): Promise<void> {
  logger.info("Starting launchpad v0.7 account snapshot");

  // Phase 1: Snapshot all launches
  await snapshotLaunches();

  // Phase 2: Snapshot all funding records
  await snapshotFundingRecords();

  logger.info("Launchpad v0.7 account snapshot complete");
}

async function snapshotLaunches(): Promise<void> {
  logger.info("Snapshotting v0.7 launches...");

  try {
    const launches = await launchpadV7Client.launchpad.account.launch.all();
    logger.info({ count: launches.length }, "Fetched v0.7 launches from chain");

    for (const launch of launches) {
      try {
        // Ensure base token exists
        await insertTokenIfNotExists(db, launch.account.baseMint);

        // Map state from account data
        let state: V06LaunchState;
        if ('initialized' in launch.account.state) {
          state = V06LaunchState.Initialized;
        } else if ('live' in launch.account.state) {
          state = V06LaunchState.Live;
        } else if ('complete' in launch.account.state) {
          state = V06LaunchState.Complete;
        } else if ('refunding' in launch.account.state) {
          state = V06LaunchState.Refunding;
        } else if ('closed' in launch.account.state) {
          state = V06LaunchState.Closed;
        } else {
          state = V06LaunchState.Initialized;
        }

        await db.insert(schema.v0_7_launches).values({
          launchAddr: launch.publicKey.toString(),
          pdaBump: launch.account.pdaBump,
          minimumRaiseAmount: BigInt(launch.account.minimumRaiseAmount.toString()),
          monthlySpendingLimitAmount: BigInt(launch.account.monthlySpendingLimitAmount.toString()),
          monthlySpendingLimitMembers: launch.account.monthlySpendingLimitMembers?.map(pk => pk.toString()) ?? [],
          launchAuthority: launch.account.launchAuthority.toString(),
          launchSigner: launch.account.launchSigner.toString(),
          launchSignerPdaBump: launch.account.launchSignerPdaBump,
          launchQuoteVault: launch.account.launchQuoteVault.toString(),
          launchBaseVault: launch.account.launchBaseVault.toString(),
          baseMintAcct: launch.account.baseMint.toString(),
          quoteMintAcct: launch.account.quoteMint.toString(),
          totalCommittedAmount: BigInt(launch.account.totalCommittedAmount?.toString() ?? '0'),
          state,
          seqNum: BigInt(launch.account.seqNum?.toString() ?? '0'),
          secondsForLaunch: launch.account.secondsForLaunch,
          performancePackageGrantee: launch.account.performancePackageGrantee?.toString() ?? "",
          performancePackageTokenAmount: BigInt(launch.account.performancePackageTokenAmount?.toString() ?? '0'),
          monthsUntilInsidersCanUnlock: launch.account.monthsUntilInsidersCanUnlock ?? 0,
          teamAddress: launch.account.teamAddress?.toString() ?? "",
          totalApprovedAmount: BigInt(launch.account.totalApprovedAmount?.toString() ?? '0'),
          additionalTokensAmount: BigInt(launch.account.additionalTokensAmount?.toString() ?? '0'),
          additionalTokensRecipient: launch.account.additionalTokensRecipient?.toString() ?? null,
          additionalTokensClaimed: launch.account.additionalTokensClaimed ?? false,
          unixTimestampCompleted: launch.account.unixTimestampCompleted ? BigInt(launch.account.unixTimestampCompleted.toString()) : null,
          isPerformancePackageInitialized: launch.account.isPerformancePackageInitialized,
          updatedAtSlot: 0n,
        }).onConflictDoNothing();
      } catch (error) {
        logger.warn({ error, launch: launch.publicKey.toString() }, "Error snapshotting v0.7 launch");
      }
    }

    logger.info({ count: launches.length }, "v0.7 Launch snapshot complete");
  } catch (error) {
    logger.error({ error }, "Error fetching v0.7 launches for snapshot");
  }
}

async function snapshotFundingRecords(): Promise<void> {
  logger.info("Snapshotting v0.7 funding records...");

  try {
    const fundingRecords = await launchpadV7Client.launchpad.account.fundingRecord.all();
    logger.info({ count: fundingRecords.length }, "Fetched v0.7 funding records from chain");

    for (const record of fundingRecords) {
      try {
        await db.insert(schema.v0_7_funding_records).values({
          fundingRecordAddr: record.publicKey.toString(),
          pdaBump: record.account.pdaBump,
          launchAddr: record.account.launch.toString(),
          funderAddr: record.account.funder.toString(),
          committedAmount: BigInt(record.account.committedAmount.toString()),
          isTokensClaimed: record.account.isTokensClaimed ?? false,
          isUsdcRefunded: record.account.isUsdcRefunded ?? false,
          approvedAmount: BigInt(record.account.approvedAmount?.toString() ?? '0'),
          updatedAtSlot: 0n,
        }).onConflictDoNothing();
      } catch (error) {
        logger.warn({ error, record: record.publicKey.toString() }, "Error snapshotting v0.7 funding record");
      }
    }

    logger.info({ count: fundingRecords.length }, "v0.7 Funding record snapshot complete");
  } catch (error) {
    logger.error({ error }, "Error fetching v0.7 funding records for snapshot");
  }
}
