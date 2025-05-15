import * as splToken from '@solana/spl-token';
import { PublicKey } from "@solana/web3.js";
import { log } from "../logger/logger";
import pLimit from "p-limit";
import { updateOrInsertTokenBalance } from "../v4_indexer/processor";
import { connection, conditionalVaultClient } from "./connection";
import { db, schema, eq, or, inArray, not, and } from "@metadaoproject/indexer-db";

const logger = log.child({
  module: "V3_Dashboard_Snapshots"
});

// Constants
const BATCH_SIZE = 100;
const RPC_DELAY_MS = 500;
const UPDATE_THRESHOLD_HOURS = 6;
const IGNORE_VAULTS = process.env.V3_VAULT_BLACKLIST_DASHBOARDS 
  ? process.env.V3_VAULT_BLACKLIST_DASHBOARDS.split(',') 
  : [];

// Types
interface ActorMintPair {
  actorAddrStr: string;
  mintStr: string;
}

// Enhanced type that includes token account information
interface EnhancedActorMintPair extends ActorMintPair {
  tokenAcct: PublicKey;
  actorPubkey: PublicKey;
  mintPubkey: PublicKey;
}

interface VaultAccount {
  publicKey: string;
  account: any;
}

// Utility Functions
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function createTokenAccount(
  actorAddrStr: string,
  mintStr: string,
  conditionalMintPubkeys: Map<string, PublicKey>
): EnhancedActorMintPair | null {
  try {
    const actorPubkey = new PublicKey(actorAddrStr);
    const mintPubkey = conditionalMintPubkeys.get(mintStr);
    if (!mintPubkey) return null;
    
    const tokenAcct = splToken.getAssociatedTokenAddressSync(
      mintPubkey,
      actorPubkey,
      true
    );
    
    return {
      actorAddrStr,
      mintStr,
      tokenAcct,
      actorPubkey,
      mintPubkey
    };
    
  } catch (error) {
    logger.debug(`Error creating token account for actor ${actorAddrStr} and mint ${mintStr}: ${error}`);
    return null;
  }
}

// Create enhanced pairs just once with all necessary information
function createEnhancedPairs(
  pairs: ActorMintPair[],
  conditionalMintPubkeys: Map<string, PublicKey>
): EnhancedActorMintPair[] {
  const enhancedPairs: EnhancedActorMintPair[] = [];
  
  for (const pair of pairs) {
    const enhancedPair = createTokenAccount(pair.actorAddrStr, pair.mintStr, conditionalMintPubkeys);
    if (enhancedPair) {
      enhancedPairs.push(enhancedPair);
    }
  }
  
  logger.info(`Created ${enhancedPairs.length} token accounts from ${pairs.length} actor-mint pairs`);
  return enhancedPairs;
}

async function getActiveVaults(): Promise<VaultAccount[]> {
  logger.info("Fetching conditional vaults from chain...");
  const allVaultAccounts = await conditionalVaultClient.vaultProgram.account.conditionalVault.all();
  logger.info(`Found ${allVaultAccounts.length} total conditional vaults`);
  
  const adjustedAllVaultAccounts = allVaultAccounts.filter(vault => !IGNORE_VAULTS.includes(vault.publicKey.toString()));
  logger.info(`Processing ${adjustedAllVaultAccounts.length} non-zero vaults`);
  
  const activeVaults: VaultAccount[] = [];
  const inactiveVaults: string[] = [];

  try {
    logger.info('Fetching underlying accounts in batches of 100');
    const batches = [];
    
    for (let i = 0; i < adjustedAllVaultAccounts.length; i += BATCH_SIZE) {
      batches.push(adjustedAllVaultAccounts.slice(i, i + BATCH_SIZE));
    }
    
    logger.info(`Processing ${batches.length} batches of vaults`);
    
    for (const batch of batches) {
      const underlyingTokenAccounts = batch.map(vault => vault.account.underlyingTokenAccount);
      const underlyingAccounts = await splToken.getMultipleAccounts(connection, underlyingTokenAccounts);
      
      const vaultMap = new Map(
        batch.map(vault => [vault.publicKey.toBase58(), vault])
      );
      
      for (const underlyingAccount of underlyingAccounts) {
        const vaultKey = underlyingAccount.owner.toBase58();
        const vault = vaultMap.get(vaultKey);
        
        if (vault) {
          if (underlyingAccount.amount > 0) {
            activeVaults.push({
              publicKey: vaultKey,
              account: vault.account
            });
          } else {
            inactiveVaults.push(vaultKey);
          }
        }
      }
      
      await delay(RPC_DELAY_MS);
    }
  } catch (error) {
    logger.error(`Unable to fetch underlying accounts: ${error}`);
  }

  logger.info(`Found ${inactiveVaults.length} inactive vaults add to your ignore list`);
  logger.info(inactiveVaults.join(', '));
  logger.info(`Found ${activeVaults.length} active vaults with non-zero balances`);
  
  return activeVaults;
}

function collectConditionalMints(activeVaults: VaultAccount[]): Map<string, PublicKey> {
  const conditionalMints = new Set<string>();
  const conditionalMintPubkeys = new Map<string, PublicKey>();
  
  for (const vault of activeVaults) {
    if (vault.account.conditionalOnFinalizeTokenMint) {
      const mintStr = vault.account.conditionalOnFinalizeTokenMint.toString();
      conditionalMints.add(mintStr);
      conditionalMintPubkeys.set(mintStr, vault.account.conditionalOnFinalizeTokenMint);
    }
    if (vault.account.conditionalOnRevertTokenMint) {
      const mintStr = vault.account.conditionalOnRevertTokenMint.toString();
      conditionalMints.add(mintStr);
      conditionalMintPubkeys.set(mintStr, vault.account.conditionalOnRevertTokenMint);
    }
  }
  
  logger.info(`Found ${conditionalMints.size} unique conditional token mints`);
  return conditionalMintPubkeys;
}

async function getMarketActors(conditionalMints: Set<string>): Promise<{
  marketToMintsMap: Map<string, Set<string>>;
  actorToMintsMap: Map<string, Set<string>>;
  marketResults: any[];
}> {
  const mintsArray = Array.from(conditionalMints);
  if (mintsArray.length === 0) {
    return { marketToMintsMap: new Map(), actorToMintsMap: new Map(), marketResults: [] };
  }

  const marketResults = await db.select({
    marketAcct: schema.markets.marketAcct,
    baseMintAcct: schema.markets.baseMintAcct,
    quoteMintAcct: schema.markets.quoteMintAcct
  })
  .from(schema.markets)
  .where(
    or(
      inArray(schema.markets.baseMintAcct, mintsArray),
      inArray(schema.markets.quoteMintAcct, mintsArray)
    )
  );

  logger.info(`Found ${marketResults.length} markets related to conditional tokens`);

  const marketToMintsMap = new Map<string, Set<string>>();
  for (const market of marketResults) {
    if (!market.marketAcct) continue;
    
    const marketAcct = market.marketAcct;
    marketToMintsMap.set(marketAcct, new Set<string>());
    
    if (market.baseMintAcct && conditionalMints.has(market.baseMintAcct)) {
      marketToMintsMap.get(marketAcct)?.add(market.baseMintAcct);
    }
    if (market.quoteMintAcct && conditionalMints.has(market.quoteMintAcct)) {
      marketToMintsMap.get(marketAcct)?.add(market.quoteMintAcct);
    }
  }

  const marketAccounts = marketResults
    .filter(market => market.marketAcct)
    .map(market => market.marketAcct as string);

  const actorToMintsMap = new Map<string, Set<string>>();

  try {
    const actorResults = await db.selectDistinct({
      marketAcct: schema.orders.marketAcct,
      actorAcct: schema.orders.actorAcct
    })
    .from(schema.orders)
    .where(inArray(schema.orders.marketAcct, marketAccounts))
    .orderBy(schema.orders.actorAcct, schema.orders.marketAcct);

    for (const row of actorResults) {
      if (!row.marketAcct || !row.actorAcct) continue;
      
      const marketMints = marketToMintsMap.get(row.marketAcct);
      if (!marketMints || marketMints.size === 0) continue;
      
      if (!actorToMintsMap.has(row.actorAcct)) {
        actorToMintsMap.set(row.actorAcct, new Set<string>());
      }
      
      const actorMints = actorToMintsMap.get(row.actorAcct) as Set<string>;
      for (const mint of marketMints) {
        actorMints.add(mint);
      }
    }
  } catch (error) {
    logger.error(`Error querying actors for markets: ${error}`);
  }

  logger.info(`Found ${actorToMintsMap.size} unique actors across all markets`);
  return { marketToMintsMap, actorToMintsMap, marketResults };
}

async function processTokenAccounts(
  enhancedPairs: EnhancedActorMintPair[]
): Promise<{ tokenAccountCount: number; updatedBalanceCount: number; errorCount: number }> {
  let tokenAccountCount = 0;
  let updatedBalanceCount = 0;
  let errorCount = 0;

  const batches = [];
  for (let i = 0; i < enhancedPairs.length; i += BATCH_SIZE) {
    batches.push(enhancedPairs.slice(i, i + BATCH_SIZE));
  }
  
  logger.info(`Processing ${batches.length} batches of enhanced pairs`);
  
  for (const batch of batches) {
    try {
      // Extract token accounts for RPC call
      const tokenAccounts = batch.map(pair => pair.tokenAcct);
      
      // Get account info for all token accounts
      const accountInfos = await connection.getMultipleAccountsInfo(tokenAccounts);
      
      // Process each account
      for (let i = 0; i < batch.length; i++) {
        const pair = batch[i];
        const accountInfo = accountInfos[i];
        
        tokenAccountCount++;
        
        if (accountInfo) {
          // Account exists - try to unpack it
          try {
            const tokenAccountData = splToken.unpackAccount(
              pair.tokenAcct,
              accountInfo,
              splToken.TOKEN_PROGRAM_ID
            );
            
            // Update token balance in DB
            await updateOrInsertTokenBalance(
              db,
              pair.tokenAcct,
              BigInt(tokenAccountData.amount.toString() || "0"),
              pair.mintPubkey,
              tokenAccountData.owner,
              "market_actor_snapshot",
              "0",
              Math.floor(Date.now() / 1000)
            );

            updatedBalanceCount++;
          } catch (error) {
            logger.error(`Error unpacking account ${pair.tokenAcct.toString()}: ${error}`);
            errorCount++;
          }
        } else {
          // Account is closed or doesn't exist - insert with zero balance
          logger.debug(`Token account ${pair.tokenAcct.toString()} is closed or doesn't exist`);
          
          await updateOrInsertTokenBalance(
            db,
            pair.tokenAcct,
            BigInt(0),  // Zero balance for closed accounts
            pair.mintPubkey,
            pair.actorPubkey, // Use actor as owner for closed accounts
            "market_actor_snapshot",
            "0",
            Math.floor(Date.now() / 1000)
          );
          
          logger.debug(`Inserted zero balance for closed token account: ${pair.tokenAcct.toString()}`);
          updatedBalanceCount++;
        }
      }
      
      await delay(RPC_DELAY_MS);
    } catch (error) {
      logger.error(`Error processing batch of token accounts: ${error}`);
      errorCount++;
    }
  }

  return { tokenAccountCount, updatedBalanceCount, errorCount };
}

async function filterRecentlyUpdatedPairs(
  pairs: ActorMintPair[],
  conditionalMintPubkeys: Map<string, PublicKey>
): Promise<ActorMintPair[]> {
  try {
    if (pairs.length === 0) {
      return [];
    }
    
    // Calculate token accounts only for database lookup purposes
    const tokenAccountsMap = new Map<string, string>(); // key: actorAddr-mintAddr, value: tokenAcct
    
    for (const pair of pairs) {
      try {
        const actorPubkey = new PublicKey(pair.actorAddrStr);
        const mintPubkey = conditionalMintPubkeys.get(pair.mintStr);
        if (!mintPubkey) continue;
        
        const tokenAcct = splToken.getAssociatedTokenAddressSync(
          mintPubkey,
          actorPubkey,
          true
        ).toString();
        
        // Create a unique key for this pair
        const pairKey = `${pair.actorAddrStr}-${pair.mintStr}`;
        tokenAccountsMap.set(pairKey, tokenAcct);
      } catch (error) {
        logger.debug(`Error creating token account for actor ${pair.actorAddrStr} and mint ${pair.mintStr}: ${error}`);
      }
    }
    
    // Get all token accounts for filtering
    const tokenAccountsToProcess = Array.from(tokenAccountsMap.values());
    
    if (tokenAccountsToProcess.length === 0) {
      return [];
    }

    const recentUpdates = await db.select({
      tokenAcct: schema.tokenAccts.tokenAcct,
      updatedAt: schema.tokenAccts.updatedAt
    })
    .from(schema.tokenAccts)
    .where(inArray(schema.tokenAccts.tokenAcct, tokenAccountsToProcess));

    const thresholdTime = Math.floor(Date.now() / 1000) - (UPDATE_THRESHOLD_HOURS * 60 * 60);

    const recentlyUpdatedAccounts = new Set(
      recentUpdates
        .filter(account => account.updatedAt && new Date(account.updatedAt).getTime() / 1000 > thresholdTime)
        .map(account => account.tokenAcct)
    );

    // Filter pairs without creating token accounts
    const filteredPairs = pairs.filter(pair => {
      const pairKey = `${pair.actorAddrStr}-${pair.mintStr}`;
      const tokenAccount = tokenAccountsMap.get(pairKey);
      
      // Include pairs that don't have token accounts yet (calculation failed) or
      // if the token account doesn't appear in recently updated accounts
      return !tokenAccount || !recentlyUpdatedAccounts.has(tokenAccount);
    });

    logger.info(`Filtered out ${pairs.length - filteredPairs.length} pairs that were updated in the last ${UPDATE_THRESHOLD_HOURS} hours`);
    return filteredPairs;
  } catch (error) {
    logger.error(`Error filtering recently updated accounts: ${error}`);
    return pairs; // Return original pairs if filtering fails
  }
}

async function filterZeroBalanceAccounts(
  pairs: ActorMintPair[],
  conditionalMintPubkeys: Map<string, PublicKey>
): Promise<ActorMintPair[]> {
  try {
    if (pairs.length === 0) {
      return pairs;
    }
    
    // Calculate token accounts only for database lookup purposes
    const tokenAccountsMap = new Map<string, string>(); // key: actorAddr-mintAddr, value: tokenAcct
    
    for (const pair of pairs) {
      try {
        const actorPubkey = new PublicKey(pair.actorAddrStr);
        const mintPubkey = conditionalMintPubkeys.get(pair.mintStr);
        if (!mintPubkey) continue;
        
        const tokenAcct = splToken.getAssociatedTokenAddressSync(
          mintPubkey,
          actorPubkey,
          true
        ).toString();
        
        // Create a unique key for this pair
        const pairKey = `${pair.actorAddrStr}-${pair.mintStr}`;
        tokenAccountsMap.set(pairKey, tokenAcct);
      } catch (error) {
        logger.debug(`Error creating token account for actor ${pair.actorAddrStr} and mint ${pair.mintStr}: ${error}`);
      }
    }
    
    // Get all token accounts for filtering
    const tokenAccountsToProcess = Array.from(tokenAccountsMap.values());
    
    if (tokenAccountsToProcess.length === 0) {
      return pairs;
    }

    const zeroBalanceAccounts = await db.select({
      tokenAcct: schema.tokenAccts.tokenAcct
    })
    .from(schema.tokenAccts)
    .where(
      and(
        inArray(schema.tokenAccts.tokenAcct, tokenAccountsToProcess),
        eq(schema.tokenAccts.amount, "0") 
      )
    );

    const zeroBalanceSet = new Set(
      zeroBalanceAccounts.map(account => account.tokenAcct)
    );

    // Filter pairs without creating token accounts
    const filteredPairs = pairs.filter(pair => {
      const pairKey = `${pair.actorAddrStr}-${pair.mintStr}`;
      const tokenAccount = tokenAccountsMap.get(pairKey);
      
      // Include pairs that don't have token accounts yet (calculation failed) or
      // if the token account doesn't appear in zero balance accounts
      return !tokenAccount || !zeroBalanceSet.has(tokenAccount);
    });

    logger.info(`Filtered out ${pairs.length - filteredPairs.length} pairs with zero balances`);
    return filteredPairs;
  } catch (error) {
    logger.error(`Error filtering zero balance accounts: ${error}`);
    return pairs; // Return original pairs if filtering fails
  }
}

export async function captureTokenBalanceSnapshotV3(): Promise<{message: string, error: Error | undefined}> {
  try {
    logger.info("Starting token balance snapshot for active vaults");
    
    const activeVaults = await getActiveVaults();
    const conditionalMintPubkeys = collectConditionalMints(activeVaults);
    const { actorToMintsMap, marketResults } = await getMarketActors(new Set(conditionalMintPubkeys.keys()));

    if (marketResults.length === 0) {
      return {
        message: "No markets found for conditional token mints",
        error: undefined
      };
    }

    const allActorMintPairs: ActorMintPair[] = [];
    for (const [actorAddrStr, mintStrSet] of actorToMintsMap.entries()) {
      for (const mintStr of mintStrSet) {
        allActorMintPairs.push({ actorAddrStr, mintStr });
      }
    }

    // Filter pairs first - without calculating token accounts
    logger.info(`Filtering ${allActorMintPairs.length} actor-mint pairs by last update time`);
    const filteredByTimePairs = await filterRecentlyUpdatedPairs(allActorMintPairs, conditionalMintPubkeys);
    
    logger.info(`Filtering ${filteredByTimePairs.length} actor-mint pairs by zero balance`);
    const fullyFilteredPairs = await filterZeroBalanceAccounts(filteredByTimePairs, conditionalMintPubkeys);
    
    // Create enhanced pairs only for the filtered pairs that will actually be processed
    logger.info(`Creating token account info for ${fullyFilteredPairs.length} filtered actor-mint pairs`);
    const enhancedPairs = createEnhancedPairs(fullyFilteredPairs, conditionalMintPubkeys);

    // Process token accounts with pre-calculated information
    const { tokenAccountCount, updatedBalanceCount, errorCount } = await processTokenAccounts(enhancedPairs);

    let totalMintChecks = 0;
    for (const mintSet of actorToMintsMap.values()) {
      totalMintChecks += mintSet.size;
    }
    const avgMintsPerActor = actorToMintsMap.size > 0 ? 
      totalMintChecks / actorToMintsMap.size : 0;

    return {
      message: `Successfully analyzed ${conditionalMintPubkeys.size} conditional mints and found ${marketResults.length} markets. Processed ${actorToMintsMap.size} unique actors with an average of ${avgMintsPerActor.toFixed(2)} mints per actor. Updated ${updatedBalanceCount} token balances from ${tokenAccountCount} token accounts. Encountered ${errorCount} errors.`,
      error: undefined
    };
  } catch (error) {
    logger.error("Error capturing token balance snapshot", error);
    return {
      message: "Failed to capture token balance snapshot",
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}
