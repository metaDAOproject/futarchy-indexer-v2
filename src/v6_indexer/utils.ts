import { schema, db, eq, and, or, DBTransaction } from "@metadaoproject/indexer-db";
import { PublicKey } from "@solana/web3.js";
import type { VersionedTransactionResponse } from "@solana/web3.js";
import { PricesType, TwapRecord, V06LaunchState, V06ProposalState } from "@metadaoproject/indexer-db/lib/schema";
import * as token from "@solana/spl-token";
import { connection, conditionalVaultClient } from "./connection";
import { log } from "../logger/logger";
import { BN } from "@coral-xyz/anchor";
import { InitializeConditionalVaultEvent, getVaultAddr, PriceMath } from "@metadaoproject/futarchy/v0.6";

const logger = log.child({
  module: "v6_utils"
});

export type Market = {
  marketAcct: string;
  baseMint: string;
  quoteMint: string;
}

type DBConnection = any; // TODO: Fix typing..

export async function insertTwapIfNotExists(
  db: DBConnection,
  event: { common: { slot: BN }, dao: PublicKey, postAmmState: any }
) {
  const ammMarketAccount = event.postAmmState;

  // In v0.6, we need to find the market using the DAO address instead of AMM address
  const market = await db
    .select()
    .from(schema.markets)
    .where(eq(schema.markets.marketAcct, event.dao.toBase58()))
    .execute();

  if (market === undefined || market.length === 0) {
    logger.warn("market not found", event.dao.toBase58());
    return false;
  }

  // In v0.6, TWAP calculation needs to be done differently
  // For now, we'll create a simple price calculation from AMM state
  // TODO: Implement proper TWAP calculation for v0.6
  
  try {
    // Get vault balances to calculate current price
    const { fromBalance, toBalance } = await getVaultBalances(
      new PublicKey(ammMarketAccount.ammBaseVault),
      new PublicKey(ammMarketAccount.baseMint),
      new PublicKey(ammMarketAccount.quoteMint)
    );

    if (fromBalance.isZero() || toBalance.isZero()) {
      logger.info("Cannot calculate TWAP - zero balance in vaults");
      return false;
    }

    // Simple price calculation - this should be replaced with proper TWAP logic
    const currentPrice = toBalance.mul(new BN(1e12)).div(fromBalance);
    
    const newTwap: TwapRecord = {
      curTwap: currentPrice.toString(),
      marketAcct: event.dao.toBase58(),
      observationAgg: currentPrice.toString(), // Placeholder - needs proper aggregation
      updatedSlot: event.common.slot.toString(),
      lastObservation: currentPrice.toString(), // Placeholder
      lastPrice: currentPrice.toString(),
    };

    await db.insert(schema.twaps).values(newTwap).onConflictDoNothing({
      target: [schema.twaps.marketAcct, schema.twaps.updatedSlot]
    });
    
    return true;
  } catch (e) {
    logger.error("error upserting twap", e);
    return false;
  }
}

export async function updateOrInsertTokenBalance(
  db: DBConnection,
  tokenAccount: PublicKey,
  amount: bigint,
  mintAccount: PublicKey,
  ownerAccount: PublicKey,
  signature: string,
  slot: string,
  blockTime: number | null
): Promise<boolean> {
  try {
    await insertTokenIfNotExists(db, mintAccount);

    const timestamp = blockTime ? new Date(blockTime * 1000) : new Date();
    
    // Check if the token account exists
    const existingAccount = await db.select()
      .from(schema.tokenAccts)
      .where(eq(schema.tokenAccts.tokenAcct, tokenAccount.toString()))
      .limit(1);
    
    if (existingAccount.length === 0) {
      // Insert new token account
      await db.insert(schema.tokenAccts).values({
        tokenAcct: tokenAccount.toString(),
        mintAcct: mintAccount.toString(),
        ownerAcct: ownerAccount.toString(),
        amount: amount,
        updatedAt: timestamp
      }).onConflictDoNothing();
      
      logger.info(`Inserted token account ${tokenAccount.toString()} with balance ${amount.toString()}`);
      return true;
    } else {
      // Update existing token account
      const previousAmount = existingAccount[0].amount;
      
      await db.update(schema.tokenAccts)
        .set({
          amount: amount,
          updatedAt: timestamp
        })
        .where(eq(schema.tokenAccts.tokenAcct, tokenAccount.toString()));
      
      // Only log if balance actually changed
      if (BigInt(previousAmount.toString()) !== amount) {
        logger.info(`Updated token balance for ${tokenAccount.toString()} from ${previousAmount.toString()} to ${amount.toString()}`);
        return true;
      }
      return false;
    }
    
  } catch (error) {
    logger.error(error, `Error updating token balance for ${tokenAccount.toString()}`);
    return false;
  }
}

/**
 * Updates token balances for conditional vault tokens assuming vault event data structure
 */
export async function updateConditionalTokenBalancesForVaultEvents(
  db: DBConnection,
  vault: PublicKey,
  user: PublicKey,
  signature: string,
  slot: string,
  blockTime: number | null
): Promise<void> {
  try {
    const vaultAccount = await conditionalVaultClient.fetchVault(vault);
    
    if (!vaultAccount) {
      logger.warn(`Vault ${vault.toString()} not found, skipping balance updates`);
      return;
    }
    
    // Use vault data to determine number of outcomes, or default to 2 for binary markets
    const numOutcomes = vaultAccount.conditionalTokenMints?.length ?? 2; // NOTE: should be fine but check this if redeem event is wonky
    
    // Get the conditional token mints
    const conditionalTokenMints = conditionalVaultClient.getConditionalTokenMints(vault, numOutcomes);
    
    for (const mint of conditionalTokenMints) {
      await insertTokenIfNotExists(db, mint);
    }
    
    // Get the user's token accounts for these mints
    const { userConditionalAccounts } = conditionalVaultClient.getConditionalTokenAccountsAndInstructions(
      vault,
      numOutcomes,
      user
    );
    
    // Update each conditional token account
    let hasChanges = false;
    for (let i = 0; i < userConditionalAccounts.length; i++) {
      const userTokenAccount = userConditionalAccounts[i];
      const tokenMint = conditionalTokenMints[i]; 
      
      try {
        const accountInfo = await token.getAccount(connection, userTokenAccount);
        
        const changed = await updateOrInsertTokenBalance(
          db,
          userTokenAccount,
          BigInt(accountInfo.amount.toString()),
          tokenMint,
          user,
          signature,
          slot,
          blockTime
        );
        
        if (changed) {
          hasChanges = true;
        }
      } catch (error) {
        logger.warn(`Error updating token account ${userTokenAccount.toString()}: ${error}`);
      }
    }
    
    // Only log if there were actual balance changes
    if (hasChanges) {
      logger.info(`Updated conditional token balances for user ${user.toString()} in vault ${vault.toString()}`);
    }
  } catch (error) {
    logger.error(error, `Error updating conditional token balances for vault ${vault.toString()}`);
  }
}

export async function insertTokenIfNotExists(db: DBConnection, mintAcct: PublicKey) {
  try {
    const existingToken = await db.select().from(schema.tokens).where(eq(schema.tokens.mintAcct, mintAcct.toString())).limit(1);
    if (existingToken.length === 0) {
      logger.info("Inserting token", mintAcct.toString());
      const mint: token.Mint = await token.getMint(connection, mintAcct);
      
      // Use a transaction to ensure atomicity
      await db.transaction(async (trx: DBTransaction) => {
        const existingTokenInTrx = await trx.select().from(schema.tokens).where(eq(schema.tokens.mintAcct, mintAcct.toString())).limit(1);
        if (existingTokenInTrx.length === 0) {
          await trx.insert(schema.tokens).values({
            mintAcct: mintAcct.toString(),
            symbol: mintAcct.toString().slice(0, 3),
            name: mintAcct.toString().slice(0, 3),
            decimals: mint.decimals,
            supply: mint.supply.toString(),
            updatedAt: new Date(),
          }).onConflictDoNothing();
        }
      });
    }
  } catch (e) {
    logger.warn(e, "Error inserting the token");
  }
}

export async function doesQuestionExist(db: DBConnection, event: InitializeConditionalVaultEvent): Promise<boolean> {
  const existingQuestion = await db.select().from(schema.v0_5_questions).where(eq(schema.v0_5_questions.questionAddr, event.question.toString())).limit(1);
  return existingQuestion.length > 0;
}

export async function insertTokenAccountIfNotExists(db: DBConnection, event: InitializeConditionalVaultEvent) {
  const existingTokenAcct = await db.select()
    .from(schema.tokenAccts)
    .where(eq(schema.tokenAccts.tokenAcct, event.vaultUnderlyingTokenAccount.toString()))
    .limit(1);

  if (existingTokenAcct.length === 0) {
    try {
      await db.insert(schema.tokenAccts).values({
        tokenAcct: event.vaultUnderlyingTokenAccount.toString(),
        mintAcct: event.underlyingTokenMint.toString(),
        ownerAcct: event.vaultUnderlyingTokenAccount.toString(),
        amount: 0n,
      });
    } catch (e) {
      logger.warn(e, "Error inserting the token account");
    }
  }
}

export async function insertMarketIfNotExists(db: DBConnection, market: Market) {
  const existingMarket = await db.select()
    .from(schema.markets)
    .where(eq(schema.markets.marketAcct, market.marketAcct))
    .limit(1);

  if (existingMarket.length === 0) {
    try {
      await db.insert(schema.markets).values({
        marketAcct: market.marketAcct,
        baseMintAcct: market.baseMint,
        quoteMintAcct: market.quoteMint,
        marketType: 'amm',
        createTxSig: '',
        baseLotSize: 0n,
        quoteLotSize: 0n,
        quoteTickSize: 0n,
        baseMakerFee: 0,
        quoteMakerFee: 0,
        baseTakerFee: 0,
        quoteTakerFee: 0
      }).onConflictDoNothing();
    } catch (e) {
      logger.warn(e, "Error inserting the market");
    }
  }
}

export async function insertConditionalVault(db: DBConnection, event: InitializeConditionalVaultEvent, vaultAddr: PublicKey) {
  try {
    await db.insert(schema.v0_4_conditional_vaults).values({
      conditionalVaultAddr: vaultAddr.toString(),
      questionAddr: event.question.toString(),
      underlyingMintAcct: event.underlyingTokenMint.toString(),
      underlyingTokenAcct: event.vaultUnderlyingTokenAccount.toString(),
      pdaBump: event.pdaBump,
        latestVaultSeqNumApplied: 0n,
      }).onConflictDoNothing();
  } catch (error) {
    logger.warn(error, "Error inserting the conditional vault");
  }
}

export function extractReservesFromAmmState(postAmmState: any): { baseReserves: bigint; quoteReserves: bigint } {
  let baseReserves = 0n;
  let quoteReserves = 0n;
  
  try {
    if ('spot' in postAmmState.state) {
      // AMM in Spot mode - direct access to spot pool
      baseReserves = BigInt(postAmmState.state.spot?.baseReserves?.toString() || "0");
      quoteReserves = BigInt(postAmmState.state.spot?.quoteReserves?.toString() || "0");
    } else if ('futarchy' in postAmmState.state) {
      // AMM in Futarchy mode - access spot pool within futarchy state
      baseReserves = BigInt(postAmmState.state.futarchy?.spot?.baseReserves?.toString() || "0");
      quoteReserves = BigInt(postAmmState.state.futarchy?.spot?.quoteReserves?.toString() || "0");
    }
  } catch (error) {
    logger.warn("Error extracting reserves from AMM state:", error);
    // Return zeros as fallback
  }
  
  return { baseReserves, quoteReserves };
}

export async function upsertV06Proposal(proposalAcct: any, proposalAddr: PublicKey, slot: bigint, blockTime: Date | null, trx: DBTransaction) {
  try {
    // Check if proposal already exists
    const existingProposal = await trx.select()
      .from(schema.v0_6_proposals)
      .where(eq(schema.v0_6_proposals.proposalAddr, proposalAddr.toString()))
      .limit(1);

    const proposalValues: typeof schema.v0_6_proposals.$inferInsert = {
      proposalAddr: proposalAddr.toString(),
      number: proposalAcct.number,
      proposer: proposalAcct.proposer.toString(),
      timestampEnqueued: BigInt(proposalAcct.timestampEnqueued.toString()),
      state: proposalAcct.state.pending ? V06ProposalState.Pending :
             proposalAcct.state.passed ? V06ProposalState.Passed :
             proposalAcct.state.failed ? V06ProposalState.Failed : V06ProposalState.Pending,
      baseVaultAddr: proposalAcct.baseVault.toString(),
      quoteVaultAddr: proposalAcct.quoteVault.toString(),
      daoAddr: proposalAcct.dao.toString(),
      pdaBump: proposalAcct.pdaBump,
      questionAddr: proposalAcct.question.toString(),
      durationInSeconds: proposalAcct.durationInSeconds,
      squadsProposal: proposalAcct.squadsProposal.toString(),
      passBaseMint: proposalAcct.passBaseMint.toString(),
      passQuoteMint: proposalAcct.passQuoteMint.toString(),
      failBaseMint: proposalAcct.failBaseMint.toString(),
      failQuoteMint: proposalAcct.failQuoteMint.toString(),
      createdAt: blockTime || new Date(),
    };

    if (existingProposal.length === 0) {
      // Insert new proposal
      await trx.insert(schema.v0_6_proposals).values(proposalValues);
      logger.info(`Inserted proposal ${proposalAddr.toString()}`);
    } else {
      // Update existing proposal
      await trx.update(schema.v0_6_proposals)
        .set(proposalValues)
        .where(eq(schema.v0_6_proposals.proposalAddr, proposalAddr.toString()));
      logger.info(`Updated proposal ${proposalAddr.toString()}`);
    }
  } catch (error) {
    logger.error(error, `Error upserting proposal ${proposalAddr.toString()}`);
  }
}

export async function upsertV06Dao(daoAcct: any, daoAddr: PublicKey, trx: DBTransaction) {
  try {
    // Check if DAO already exists
    const existingDao = await trx.select()
      .from(schema.v0_6_daos)
      .where(eq(schema.v0_6_daos.daoAddr, daoAddr.toString()))
      .limit(1);

    // Create AMM vault ATAs
    const ammBaseVaultAta = token.getAssociatedTokenAddressSync(
      daoAcct.baseMint,
      daoAddr,
      true
    );
    
    const ammQuoteVaultAta = token.getAssociatedTokenAddressSync(
      daoAcct.quoteMint,
      daoAddr,
      true
    );

    const daoValues: typeof schema.v0_6_daos.$inferInsert = {
      daoAddr: daoAddr.toString(),
      ammAddr: daoAddr.toString(), // In v0.6, AMM is embedded in DAO
      nonce: BigInt(daoAcct.nonce.toString()),
      daoCreator: daoAcct.daoCreator.toString(),
      pdaBump: daoAcct.pdaBump,
      squadsMultisig: daoAcct.squadsMultisig.toString(),
      squadsMultisigVault: daoAcct.squadsMultisigVault.toString(),
      baseMintAcct: daoAcct.baseMint.toString(),
      quoteMintAcct: daoAcct.quoteMint.toString(),
      proposalCount: daoAcct.proposalCount,
      passThresholdBps: daoAcct.passThresholdBps,
      secondsPerProposal: daoAcct.secondsPerProposal,
      twapInitialObservation: daoAcct.twapInitialObservation.toString(),
      twapMaxObservationChangePerUpdate: daoAcct.twapMaxObservationChangePerUpdate.toString(),
      twapStartDelaySeconds: daoAcct.twapStartDelaySeconds,
      minQuoteFutarchicLiquidity: BigInt(daoAcct.minQuoteFutarchicLiquidity.toString()),
      minBaseFutarchicLiquidity: BigInt(daoAcct.minBaseFutarchicLiquidity.toString()),
      baseToStake: BigInt(daoAcct.baseToStake.toString()),
      seqNum: BigInt(daoAcct.seqNum.toString()),
      initialSpendingLimit: daoAcct.initialSpendingLimit ? JSON.stringify(daoAcct.initialSpendingLimit) : null,
      // AMM fields from embedded AMM
      ammLpMint: daoAcct.amm.lpMint.toString(),
      ammBaseAmount: BigInt(daoAcct.amm.state.spot?.baseReserves?.toString() || "0"),
      ammQuoteAmount: BigInt(daoAcct.amm.state.spot?.quoteReserves?.toString() || "0"),
      ammOracle: daoAcct.amm.oracle.toString(),
      ammSeqNum: BigInt(daoAcct.amm.seqNum.toString()),
      ammVaultAtaBase: ammBaseVaultAta.toString(),
      ammVaultAtaQuote: ammQuoteVaultAta.toString(),
    };

    if (existingDao.length === 0) {
      // Insert new DAO
      await trx.insert(schema.v0_6_daos).values(daoValues);
      logger.info(`Inserted DAO ${daoAddr.toString()}`);
    } else {
      // Update existing DAO
      await trx.update(schema.v0_6_daos)
        .set(daoValues)
        .where(eq(schema.v0_6_daos.daoAddr, daoAddr.toString()));
      logger.info(`Updated DAO ${daoAddr.toString()}`);
    }
  } catch (error) {
    logger.error(error, `Error upserting DAO ${daoAddr.toString()}`);
  }
}

export async function getVaultBalances(
    vaultAddress: PublicKey,
    mintFrom: PublicKey,
    mintTo: PublicKey
  ): Promise<{ fromBalance: BN; toBalance: BN }> {
    try {
      // Derive the vault ATAs
      const vaultFromAta = token.getAssociatedTokenAddressSync(
        mintFrom,
        vaultAddress,
        true
      );
      
      const vaultToAta = token.getAssociatedTokenAddressSync(
        mintTo,
        vaultAddress,
        true
      );

      // Fetch the token account balances
      let fromBalance = new BN(0);
      let toBalance = new BN(0);

      try {
        const fromAccount = await token.getAccount(connection, vaultFromAta);
        fromBalance = new BN(fromAccount.amount.toString());
      } catch (error) {
        console.log(`Vault from ATA doesn't exist or has 0 balance`);
      }

      try {
        const toAccount = await token.getAccount(connection, vaultToAta);
        toBalance = new BN(toAccount.amount.toString());
      } catch (error) {
        console.log(`Vault to ATA doesn't exist or has 0 balance`);
      }

      return { fromBalance, toBalance };
    } catch (error) {
      console.error("Error fetching vault balances:", error);
      throw error;
    }
  }