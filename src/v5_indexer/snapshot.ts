import { PublicKey } from "@solana/web3.js";
import { log } from "../logger/logger";
import pLimit from "p-limit";
import { updateOrInsertTokenBalance } from "./processor";
import { connection, conditionalVaultClient, ammClient } from "./connection";
import { db, schema, eq, inArray, and } from "@metadaoproject/indexer-db";
import * as splToken from '@solana/spl-token';

const logger = log.child({
  module: "V5_Dashboard_Snapshots",
});

// Constants
const BATCH_SIZE = 100;
const RPC_DELAY_MS = 500;
const UPDATE_THRESHOLD_HOURS = 6;
const IGNORE_VAULTS = process.env.V5_VAULT_BLACKLIST_DASHBOARDS 
  ? process.env.V5_VAULT_BLACKLIST_DASHBOARDS.split(',') 
  : [];

// Types 
interface VaultAccount {
  publicKey: string;
  account: any;
  question?: any;
}

// Utility functions
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function getActiveVaults(): Promise<VaultAccount[]> {
  logger.info("Fetching conditional vaults from chain...");
  const allVaultAccounts = await conditionalVaultClient.vaultProgram.account.conditionalVault.all();
  logger.info(`Found ${allVaultAccounts.length} total conditional vaults`);
  
  const adjustedAllVaultAccounts = allVaultAccounts.filter(vault => !IGNORE_VAULTS.includes(vault.publicKey.toString()));
  logger.info(`Processing ${adjustedAllVaultAccounts.length} non-ignored vaults`);
  
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
            // Optionally fetch question for additional filtering
            try {
              const question = await conditionalVaultClient.fetchQuestion(vault.account.question);
              // Check if the question is resolved (has non-zero payoutDenominator)
              if (question && question.payoutDenominator > 0) {
                activeVaults.push({
                  publicKey: vaultKey,
                  account: vault.account,
                  question: question
                });
              } else {
                inactiveVaults.push(vaultKey);
              }
            } catch (error) {
              logger.warn(`Error fetching question for vault ${vaultKey}: ${error}`);
              // Still add the vault if we can't fetch the question
              activeVaults.push({
                publicKey: vaultKey,
                account: vault.account
              });
            }
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
  const conditionalMintPubkeys = new Map<string, PublicKey>();
  
  for (const vault of activeVaults) {
    if (vault.account.conditionalTokenMints && vault.account.conditionalTokenMints.length > 0) {
      for (const mint of vault.account.conditionalTokenMints) {
        const mintStr = mint.toString();
        conditionalMintPubkeys.set(mintStr, mint);
      }
    }
  }
  
  logger.info(`Found ${conditionalMintPubkeys.size} unique conditional token mints`);
  return conditionalMintPubkeys;
}

async function mapMintsToAmms(conditionalMints: Set<string>): Promise<Map<string, PublicKey[]>> {
  logger.info("Fetching all AMMs...");
  const allAmmAccounts = await ammClient.program.account.amm.all();
  
  // Create a mapping of mint address to AMMs that use it
  const mintToAmmsMap = new Map<string, PublicKey[]>();
  
  for (const ammData of allAmmAccounts) {
    const amm = ammData.account;
    const baseMint = amm.baseMint.toString();
    const quoteMint = amm.quoteMint.toString();
    
    // If this AMM uses one of our conditional mints, add it to the map
    if (conditionalMints.has(baseMint)) {
      if (!mintToAmmsMap.has(baseMint)) {
        mintToAmmsMap.set(baseMint, []);
      }
      mintToAmmsMap.get(baseMint)?.push(ammData.publicKey);
    }
    
    if (conditionalMints.has(quoteMint)) {
      if (!mintToAmmsMap.has(quoteMint)) {
        mintToAmmsMap.set(quoteMint, []);
      }
      mintToAmmsMap.get(quoteMint)?.push(ammData.publicKey);
    }
  }
  
  logger.info(`Mapped ${mintToAmmsMap.size} mints to their AMMs`);
  return mintToAmmsMap;
}

async function getUsersForAmms(amms: PublicKey[]): Promise<Map<string, string[]>> {
  const ammToUsersMap = new Map<string, string[]>();
  
  for (const ammPubkey of amms) {
    const ammAddr = ammPubkey.toString();
    
    // Get users who have swapped with this AMM
    const users = await db.selectDistinct({
      userAddr: schema.v0_5_swaps.userAddr
    })
    .from(schema.v0_5_swaps)
    .where(eq(schema.v0_5_swaps.ammAddr, ammAddr));
    
    // Filter out any null/undefined userAddrs and add to map
    const validUsers = users
      .map(user => user.userAddr)
      .filter((addr): addr is string => addr !== null && addr !== undefined);
    
    // Store the list of users for this specific AMM
    ammToUsersMap.set(ammAddr, validUsers);
  }
  
  return ammToUsersMap;
}

async function getMintUsersMapping(conditionalMints: Set<string>): Promise<Map<string, Map<string, string[]>>> {
  // First get mint -> AMMs mapping
  const mintToAmmsMap = await mapMintsToAmms(conditionalMints);
  
  // Initialize result: mint -> (AMM -> users)
  const mintToAmmToUsersMap = new Map<string, Map<string, string[]>>();
  
  // For each mint, get its AMMs and their users
  for (const [mint, amms] of mintToAmmsMap.entries()) {
    // Get the mapping of AMMs to their users
    const ammToUsersMap = await getUsersForAmms(amms);
    
    // Store this mapping for the current mint
    mintToAmmToUsersMap.set(mint, ammToUsersMap);
  }
  
  logger.info(`Created mapping of ${mintToAmmToUsersMap.size} mints to their AMMs and users`);
  return mintToAmmToUsersMap;
}

async function filterRecentlyUpdatedAccounts(accounts: string[]): Promise<string[]> {
  try {
    if (accounts.length === 0) {
      return [];
    }
    
    // Query the database for these accounts' update times
    const recentUpdates = await db.select({
      tokenAcct: schema.tokenAccts.tokenAcct,
      updatedAt: schema.tokenAccts.updatedAt
    })
    .from(schema.tokenAccts)
    .where(inArray(schema.tokenAccts.tokenAcct, accounts));

    // Calculate threshold timestamp
    const thresholdTime = Math.floor(Date.now() / 1000) - (UPDATE_THRESHOLD_HOURS * 60 * 60);

    // Create a set of recently updated accounts
    const recentlyUpdatedAccounts = new Set(
      recentUpdates
        .filter(account => account.updatedAt && new Date(account.updatedAt).getTime() / 1000 > thresholdTime)
        .map(account => account.tokenAcct)
    );

    const filteredAccounts = accounts.filter(account => !recentlyUpdatedAccounts.has(account));

    logger.info(`Filtered out ${accounts.length - filteredAccounts.length} accounts that were updated in the last ${UPDATE_THRESHOLD_HOURS} hours`);
    return filteredAccounts;
  } catch (error) {
    logger.error(`Error filtering recently updated accounts: ${error}`);
    return accounts; // Return original accounts if filtering fails
  }
}

async function filterZeroBalanceAccounts(accounts: string[]): Promise<string[]> {
  try {
    if (accounts.length === 0) {
      return [];
    }
    
    const zeroBalanceAccounts = await db.select({
      tokenAcct: schema.tokenAccts.tokenAcct
    })
    .from(schema.tokenAccts)
    .where(
      and(
        inArray(schema.tokenAccts.tokenAcct, accounts),
        eq(schema.tokenAccts.amount, "0")
      )
    );

    const zeroBalanceSet = new Set(
      zeroBalanceAccounts.map(account => account.tokenAcct)
    );

    const filteredAccounts = accounts.filter(account => !zeroBalanceSet.has(account));

    logger.info(`Filtered out ${accounts.length - filteredAccounts.length} accounts with zero balances`);
    return filteredAccounts;
  } catch (error) {
    logger.error(`Error filtering zero balance accounts: ${error}`);
    return accounts; // Return original accounts if filtering fails
  }
}

async function processUserMintTokenAccounts(
  mintToAmmToUsersMap: Map<string, Map<string, string[]>>,
  conditionalMintPubkeys: Map<string, PublicKey>
): Promise<{ updated: number, errors: number }> {
  let updated = 0;
  let errors = 0;
  
  const allTokenAccounts: { account: PublicKey, mint: PublicKey, userPubkey: PublicKey }[] = [];
  
  for (const [mintStr, ammToUsersMap] of mintToAmmToUsersMap.entries()) {
    const mintPubkey = conditionalMintPubkeys.get(mintStr);
    if (!mintPubkey) continue;
    
    logger.info(`Processing mint ${mintStr}`);
    
    // Collect all unique users across all AMMs for this mint
    const uniqueUsers = new Set<string>();
    for (const users of ammToUsersMap.values()) {
      for (const user of users) {
        uniqueUsers.add(user);
      }
    }
    
    const userCount = uniqueUsers.size;
    logger.info(`Found ${userCount} unique users for mint ${mintStr}`);
    
    // Skip processing if no users found
    if (userCount === 0) {
      continue;
    }
    
    // Create token accounts for all user-mint pairs
    const userArray = Array.from(uniqueUsers);
    for (const userAddr of userArray) {
      try {
        const userPubkey = new PublicKey(userAddr);
        const tokenAccount = splToken.getAssociatedTokenAddressSync(
          mintPubkey,
          userPubkey,
          true
        );
        allTokenAccounts.push({ 
          account: tokenAccount, 
          mint: mintPubkey,
          userPubkey
        });
      } catch (error) {
        logger.debug(`Error creating token account for user ${userAddr} and mint ${mintStr}: ${error}`);
      }
    }
  }
  
  if (allTokenAccounts.length === 0) {
    logger.info("No valid token accounts created across all mints. Nothing to process.");
    return { updated, errors };
  }
  
  logger.info(`Created a total of ${allTokenAccounts.length} token accounts across all mints`);
  
  // Convert PublicKey objects to strings for filtering
  const allTokenAccountAddrs = allTokenAccounts.map(item => item.account.toString());
  
  logger.info("Filtering all token accounts to skip recently updated ones...");
  
  // Filter out recently updated accounts
  const filteredByTimeTokenAccountAddrs = await filterRecentlyUpdatedAccounts(allTokenAccountAddrs);
  
  if (filteredByTimeTokenAccountAddrs.length === 0) {
    logger.info("All token accounts were recently updated. Nothing to process.");
    return { updated, errors };
  }
  
  logger.info("Filtering accounts to skip those with zero balances...");
  
  // Filter out zero balance accounts
  const fullyFilteredTokenAccountAddrs = await filterZeroBalanceAccounts(filteredByTimeTokenAccountAddrs);
  
  if (fullyFilteredTokenAccountAddrs.length === 0) {
    logger.info("All remaining token accounts have zero balances. Nothing to process.");
    return { updated, errors };
  }
  
  // Filter the original objects to match filtered addresses
  const filteredTokenAccounts = allTokenAccounts.filter(item => 
    fullyFilteredTokenAccountAddrs.includes(item.account.toString())
  );
  
  logger.info(`Processing ${filteredTokenAccounts.length} token accounts across all mints`);
  
  // Batch accounts for getMultipleAccounts calls (100 account limit)
  const ACCOUNT_BATCH_SIZE = 100;
  const accountBatches = [];
  for (let i = 0; i < filteredTokenAccounts.length; i += ACCOUNT_BATCH_SIZE) {
    accountBatches.push(filteredTokenAccounts.slice(i, i + ACCOUNT_BATCH_SIZE));
  }
  
  logger.info(`Split into ${accountBatches.length} batches (max 100 accounts per batch)`);
  
  // Rate limit batch processing
  const batchProcessLimit = pLimit(2);
  const batchProcessPromises = accountBatches.map((batch, batchIndex) =>
    batchProcessLimit(async () => {
      try {
        // Extract just the PublicKey objects for the API call
        const accountPublicKeys = batch.map(item => item.account);
        
        const accountInfos = await connection.getMultipleAccountsInfo(accountPublicKeys);
        
        logger.info(`Retrieved account info for batch ${batchIndex + 1}/${accountBatches.length}`);
        
        // Process each account in the batch
        for (let i = 0; i < batch.length; i++) {
          const { account, mint, userPubkey } = batch[i];
          const accountInfo = accountInfos[i];
          
          try {
            if (accountInfo) {
              // Account exists - try to unpack it
              try {
                const tokenAccountData = splToken.unpackAccount(
                  account,
                  accountInfo,
                  splToken.TOKEN_PROGRAM_ID
                );
                
                // Comment out DB update for testing
                await updateOrInsertTokenBalance(
                  db,
                  account,
                  BigInt(tokenAccountData.amount.toString() || "0"),
                  mint,
                  tokenAccountData.owner,
                  "market_actor_snapshot",
                  "0",
                  Math.floor(Date.now() / 1000)
                );
                
                updated++;
              } catch (error) {
                logger.error(`Error unpacking account ${account.toString()}: ${error}`);
                errors++;
              }
            } else {
              // Account is closed or doesn't exist - insert with zero balance
              logger.info(`Token account ${account.toString()} is closed or doesn't exist`);
              
              // Comment out DB update for testing
              await updateOrInsertTokenBalance(
                db,
                account,
                BigInt(0),  // Zero balance for closed accounts
                mint,
                userPubkey, // Use user as owner for closed accounts
                "market_actor_snapshot",
                "0",
                Math.floor(Date.now() / 1000)
              );
              
              updated++;
            }
          } catch (error) {
            logger.error(`Error processing token account ${account.toString()}: ${error}`);
            errors++;
          }
        }
      } catch (error) {
        logger.error(`Error processing account batch ${batchIndex + 1}/${accountBatches.length}: ${error}`);
        errors++;
      }
      
      await delay(RPC_DELAY_MS);
    })
  );
  
  // Wait for all batches to be processed
  await Promise.all(batchProcessPromises);
  
  return { updated, errors };
}

export async function captureTokenBalanceSnapshotV5(): Promise<{message: string, error: Error | undefined}> {
  try {
    logger.info("Starting token balance snapshot for active vaults");
    
    const activeVaults = await getActiveVaults();
    
    const conditionalMintPubkeys = collectConditionalMints(activeVaults);
    const conditionalMints = new Set(conditionalMintPubkeys.keys());
    
    const mintToAmmToUsersMap = await getMintUsersMapping(conditionalMints);
    
    const result = await processUserMintTokenAccounts(mintToAmmToUsersMap, conditionalMintPubkeys);
    
    return {
      message: `Successfully updated ${result.updated} token balances in token_accts table. Encountered ${result.errors} errors.`,
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