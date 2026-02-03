import { db, schema } from "@metadaoproject/indexer-db";
import { futarchyClient } from "../../../connections/v0.6";
import { futarchyClient as futarchyClientV7 } from "../../../connections/v0.7";
import { upsertV06Dao, upsertV06Proposal, insertTokenIfNotExists } from "../../shared/utils";
import { log } from "../../../logger/logger";

const logger = log.child({ module: "futarchy-v0.6-snapshot" });

/**
 * Snapshot all futarchy accounts (DAOs, proposals, stake accounts)
 * This runs .all() for each account type and inserts with onConflictDoNothing()
 * to quickly get current state before signature crawl
 */
export async function snapshotFutarchyAccounts(): Promise<void> {
  logger.info("Starting futarchy account snapshot");

  // Phase 1: Snapshot all DAOs
  await snapshotDaos();

  // Phase 2: Snapshot all proposals
  await snapshotProposals();

  // Phase 3: Snapshot all stake accounts
  // Disabled - don't want to override event-sourced staking records
  // await snapshotStakeAccounts();

  logger.info("Futarchy account snapshot complete");
}

async function snapshotDaos(): Promise<void> {
  logger.info("Snapshotting DAOs...");

  try {
    const daos = await futarchyClient.futarchy.account.dao.all();
    logger.info({ count: daos.length }, "Fetched DAOs from chain");

    for (const dao of daos) {
      try {
        // Ensure tokens exist
        await insertTokenIfNotExists(db, dao.account.baseMint);
        await insertTokenIfNotExists(db, dao.account.quoteMint);

        // Upsert DAO (uses onConflictDoUpdate internally with slot check)
        await upsertV06Dao(dao.account, dao.publicKey, db);
      } catch (error) {
        logger.warn({ error, dao: dao.publicKey.toString() }, "Error snapshotting DAO");
      }
    }

    logger.info({ count: daos.length }, "DAO snapshot complete");
  } catch (error) {
    logger.error({ error }, "Error fetching DAOs for snapshot");
  }
}

async function snapshotProposals(): Promise<void> {
  logger.info("Snapshotting proposals...");

  try {
    // Use v0.7 client which has updated IDL (handles new fields like 'removed' state)
    const proposals = await futarchyClientV7.autocrat.account.proposal.all();
    logger.info({ count: proposals.length }, "Fetched proposals from chain");

    for (const proposal of proposals) {
      try {
        // Ensure conditional tokens exist
        await insertTokenIfNotExists(db, proposal.account.passBaseMint);
        await insertTokenIfNotExists(db, proposal.account.passQuoteMint);
        await insertTokenIfNotExists(db, proposal.account.failBaseMint);
        await insertTokenIfNotExists(db, proposal.account.failQuoteMint);

        // Upsert proposal (uses onConflictDoUpdate internally with slot check)
        await upsertV06Proposal(proposal.account, proposal.publicKey, 0n, null, db);
      } catch (error) {
        logger.warn({ error, proposal: proposal.publicKey.toString() }, "Error snapshotting proposal");
      }
    }

    logger.info({ count: proposals.length }, "Proposal snapshot complete");
  } catch (error) {
    logger.error({ error }, "Error fetching proposals for snapshot");
  }
}

async function snapshotStakeAccounts(): Promise<void> {
  logger.info("Snapshotting stake accounts...");

  try {
    const stakeAccounts = await futarchyClient.futarchy.account.stakeAccount.all();
    logger.info({ count: stakeAccounts.length }, "Fetched stake accounts from chain");

    for (const stake of stakeAccounts) {
      try {
        await db.insert(schema.v0_6_staking_record).values({
          stakeAddr: stake.publicKey.toString(),
          proposalAddr: stake.account.proposal.toString(),
          stakerAddr: stake.account.staker.toString(),
          totalStaked: stake.account.amount.toString(),
          updatedAtSlot: 0n, // Will be updated by events with actual slots
          createdAt: new Date(),
        }).onConflictDoNothing();
      } catch (error) {
        logger.warn({ error, stake: stake.publicKey.toString() }, "Error snapshotting stake account");
      }
    }

    logger.info({ count: stakeAccounts.length }, "Stake account snapshot complete");
  } catch (error) {
    logger.error({ error }, "Error fetching stake accounts for snapshot");
  }
}
