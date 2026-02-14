import {
  ConditionalVaultEvent,
  InitializeQuestionEvent,
  RedeemTokensEvent,
  InitializeConditionalVaultEvent,
  SplitTokensEvent,
  MergeTokensEvent,
  ResolveQuestionEvent,
  getVaultAddr
} from "@metadaoproject/futarchy/v0.6";
import { schema, db, eq, or, DBTransaction } from "@metadaoproject/indexer-db";
import { PublicKey } from "@solana/web3.js";
import type { VersionedTransactionResponse } from "@solana/web3.js";
import { conditionalVaultClient } from "../../../connections/v0.6";
import {
  updateConditionalTokenBalancesForVaultEvents,
  insertTokenIfNotExists,
  doesQuestionExist,
  insertTokenAccountIfNotExists,
  insertConditionalVault
} from "../../shared/utils";
import { log } from "../../../logger/logger";

const logger = log.child({
  module: "vault-v0.4-processor"
});

type DBConnection = any;

export async function processVaultEvent(
  event: { name: string; data: ConditionalVaultEvent },
  signature: string,
  transactionResponse: VersionedTransactionResponse
) {
  switch (event.name) {
    case "InitializeQuestionEvent":
      await handleInitializeQuestionEvent(event.data as InitializeQuestionEvent);
      break;
    case "RedeemTokensEvent":
      await handleRedeemEvent(event.data as RedeemTokensEvent, signature, transactionResponse);
      break;
    case "InitializeConditionalVaultEvent":
      await handleInitializeConditionalVaultEvent(event.data as InitializeConditionalVaultEvent);
      break;
    case "SplitTokensEvent":
      await handleSplitEvent(event.data as SplitTokensEvent, signature, transactionResponse);
      break;
    case "MergeTokensEvent":
      await handleMergeEvent(event.data as MergeTokensEvent, signature, transactionResponse);
      break;
    case "ResolveQuestionEvent":
      await handleResolveQuestionEvent(event.data as ResolveQuestionEvent, signature, transactionResponse);
      break;
    default:
      logger.info({ eventName: event.name }, "Unknown Vault event");
  }
}

async function handleInitializeQuestionEvent(event: InitializeQuestionEvent) {
  try {
    // Insert into v0_4_questions first (FK constraint on v0_4_conditional_vaults)
    const v4Values: typeof schema.v0_4_questions.$inferInsert = {
      questionAddr: event.question.toString(),
      oracleAddr: event.oracle.toString(),
      isResolved: false,
      numOutcomes: event.numOutcomes,
      payoutNumerators: Array(event.numOutcomes).fill(0),
      payoutDenominator: 0n,
      questionId: event.questionId,
    };

    await db.insert(schema.v0_4_questions)
      .values(v4Values)
      .onConflictDoNothing();

    // Also insert into v0_6_questions
    const v6Values: typeof schema.v0_6_questions.$inferInsert = {
      questionAddr: event.question.toString(),
      oracleAddr: event.oracle.toString(),
      payoutNumerators: Array(event.numOutcomes).fill(0),
      payoutDenominator: 0n,
      questionId: event.questionId,
    };

    await db.insert(schema.v0_6_questions)
      .values(v6Values)
      .onConflictDoNothing();

  } catch (error) {
    logger.error(error, "Error in handleInitializeQuestionEvent");
  }
}

async function handleRedeemEvent(event: RedeemTokensEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await updateConditionalTokenBalancesForVaultEvents(
      db,
      new PublicKey(event.vault.toString()),
      new PublicKey(event.user.toString()),
      signature,
      transactionResponse.slot.toString(),
      transactionResponse.blockTime ?? null
    );
  } catch (error) {
    logger.error(error, "Error in handleRedeemEvent");
  }
}

async function handleResolveQuestionEvent(event: ResolveQuestionEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    logger.info({ question: event.question.toString() }, "Resolving question");

    let payoutDenominator = 0;
    for (const numerator of event.payoutNumerators) {
      payoutDenominator += numerator;
    }
    await db.update(schema.v0_6_questions).set({
      payoutNumerators: event.payoutNumerators,
      payoutDenominator: BigInt(payoutDenominator),
    }).where(eq(schema.v0_6_questions.questionAddr, event.question.toString()));


    await db.update(schema.v0_5_metric_decisions).set({
      completedAt: new Date(),
    }).where(
      or(
        eq(schema.v0_5_metric_decisions.outcomeQuestionAddr, event.question.toString()),
        eq(schema.v0_5_metric_decisions.metricQuestionAddr, event.question.toString())
      )
    );

  } catch (error) {
    logger.error(error, "Error in handleResolveQuestionEvent");
  }
}

async function handleInitializeConditionalVaultEvent(event: InitializeConditionalVaultEvent) {
  try {
    const vaultAddr = getVaultAddr(conditionalVaultClient.vaultProgram.programId, event.question, event.underlyingTokenMint)[0];

    await db.transaction(async (trx: DBTransaction) => {
      if (!await doesQuestionExist(trx, event)) {
        return;
      }
      await insertTokenIfNotExists(trx, event.underlyingTokenMint);
      await insertTokenAccountIfNotExists(trx, event);
      await insertConditionalVault(trx, event, vaultAddr);
    });

  } catch (error) {
    logger.error(error, "Error in handleInitializeConditionalVaultEvent");
  }
}

async function handleSplitEvent(event: SplitTokensEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    const insertValues = {
      vaultAddr: event.vault.toString(),
      vaultSeqNum: BigInt(event.seqNum.toString()),
      signature: signature,
      slot: transactionResponse.slot.toString(),
      amount: BigInt(event.amount.toString())
    };

    // First verify the vault exists
    const vault = await db.select()
      .from(schema.v0_4_conditional_vaults)
      .where(eq(schema.v0_4_conditional_vaults.conditionalVaultAddr, event.vault.toString()))
      .limit(1);

    if (vault.length === 0) {
      logger.warn({ vault: event.vault.toString() }, "Referenced vault does not exist");
    }

    await db.insert(schema.v0_5_splits)
      .values(insertValues)
      .onConflictDoNothing();

    await updateConditionalTokenBalancesForVaultEvents(
      db,
      new PublicKey(event.vault.toString()),
      new PublicKey(event.user.toString()),
      signature,
      transactionResponse.slot.toString(),
      transactionResponse.blockTime ?? null
    );

  } catch (error) {
    logger.error(error, "Error in handleSplitEvent");
  }
}

async function handleMergeEvent(event: MergeTokensEvent, signature: string, transactionResponse: VersionedTransactionResponse) {
  try {
    await db.insert(schema.v0_5_merges).values({
      vaultAddr: event.vault.toString(),
      vaultSeqNum: BigInt(event.seqNum.toString()),
      signature: signature,
      slot: transactionResponse.slot.toString(),
      amount: BigInt(event.amount.toString())
    }).onConflictDoNothing();

    await updateConditionalTokenBalancesForVaultEvents(
      db,
      new PublicKey(event.vault.toString()),
      new PublicKey(event.user.toString()),
      signature,
      transactionResponse.slot.toString(),
      transactionResponse.blockTime ?? null
    );

  } catch (error) {
    logger.error(error, "Error in handleMergeEvent");
  }
}

// Account update handlers (Vault accounts updated via Geyser stream)
export async function processVaultAccountUpdate(
  pubkey: string,
  accountType: string,
  accountData: any,
  slot: bigint
) {
  switch (accountType) {
    case 'conditionalVault':
      logger.debug({ pubkey, slot: slot.toString() }, "ConditionalVault update");
      // TODO: Add upsertVault function
      break;
    case 'question':
      logger.debug({ pubkey, slot: slot.toString() }, "Question update");
      // TODO: Add upsertQuestion function
      break;
    default:
      logger.debug({ pubkey, accountType }, "Unknown Vault account type in update");
  }
}
