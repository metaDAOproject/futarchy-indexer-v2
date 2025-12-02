import { db, schema } from "@metadaoproject/indexer-db";
import { conditionalVaultClient } from "../../../connections/v0.6";
import { insertTokenIfNotExists } from "../../shared/utils";
import { log } from "../../../logger/logger";

const logger = log.child({ module: "conditional-vault-v0.4-snapshot" });

/**
 * Snapshot all conditional vault accounts (vaults, questions)
 * This runs .all() for each account type and inserts with onConflictDoNothing()
 * to quickly get current state before signature crawl
 */
export async function snapshotVaultAccounts(): Promise<void> {
  logger.info("Starting conditional vault account snapshot");

  // Phase 1: Snapshot all questions
  await snapshotQuestions();

  // Phase 2: Snapshot all vaults
  await snapshotVaults();

  logger.info("Conditional vault account snapshot complete");
}

async function snapshotQuestions(): Promise<void> {
  logger.info("Snapshotting questions...");

  try {
    const questions = await conditionalVaultClient.vaultProgram.account.question.all();
    logger.info({ count: questions.length }, "Fetched questions from chain");

    for (const question of questions) {
      try {
        let payoutDenominator = 0n;
        const payoutNumerators = question.account.payoutNumerators ?? [];
        for (const numerator of payoutNumerators) {
          payoutDenominator += BigInt(numerator);
        }

        // Insert into v0_4_questions first (FK constraint)
        await db.insert(schema.v0_4_questions).values({
          questionAddr: question.publicKey.toString(),
          oracleAddr: question.account.oracle.toString(),
          isResolved: payoutDenominator > 0n,
          numOutcomes: payoutNumerators.length || 2,
          payoutNumerators,
          payoutDenominator,
          questionId: question.account.questionId ?? Buffer.alloc(32),
        }).onConflictDoNothing();

        // Also insert into v0_6_questions
        await db.insert(schema.v0_6_questions).values({
          questionAddr: question.publicKey.toString(),
          oracleAddr: question.account.oracle.toString(),
          payoutNumerators,
          payoutDenominator,
          questionId: question.account.questionId ?? Buffer.alloc(32),
        }).onConflictDoNothing();
      } catch (error) {
        logger.warn({ error, question: question.publicKey.toString() }, "Error snapshotting question");
      }
    }

    logger.info({ count: questions.length }, "Question snapshot complete");
  } catch (error) {
    logger.error({ error }, "Error fetching questions for snapshot");
  }
}

async function snapshotVaults(): Promise<void> {
  logger.info("Snapshotting vaults...");

  try {
    const vaults = await conditionalVaultClient.vaultProgram.account.conditionalVault.all();
    logger.info({ count: vaults.length }, "Fetched vaults from chain");

    for (const vault of vaults) {
      try {
        // Ensure underlying token exists
        await insertTokenIfNotExists(db, vault.account.underlyingTokenMint);

        // Insert conditional token mints
        if (vault.account.conditionalTokenMints) {
          for (const mint of vault.account.conditionalTokenMints) {
            await insertTokenIfNotExists(db, mint);
          }
        }

        await db.insert(schema.v0_4_conditional_vaults).values({
          conditionalVaultAddr: vault.publicKey.toString(),
          questionAddr: vault.account.question.toString(),
          underlyingMintAcct: vault.account.underlyingTokenMint.toString(),
          underlyingTokenAcct: vault.account.underlyingTokenAccount.toString(),
          pdaBump: vault.account.pdaBump,
          latestVaultSeqNumApplied: BigInt(vault.account.seqNum?.toString() ?? '0'),
        }).onConflictDoNothing();
      } catch (error) {
        logger.warn({ error, vault: vault.publicKey.toString() }, "Error snapshotting vault");
      }
    }

    logger.info({ count: vaults.length }, "Vault snapshot complete");
  } catch (error) {
    logger.error({ error }, "Error fetching vaults for snapshot");
  }
}
