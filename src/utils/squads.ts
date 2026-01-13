import { PublicKey, Connection } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { log } from "../logger/logger";

const logger = log.child({ module: "squads-utils" });

/**
 * Get multisig, spending limit, and vault PDAs from DAO address
 */
export const getSquadsPdasFromDao = async (
  daoAddress: string | PublicKey,
): Promise<{
  multisigPda: PublicKey;
  spendingLimitPda: PublicKey;
  vaultPda: PublicKey;
}> => {
  const dao =
    typeof daoAddress === "string" ? new PublicKey(daoAddress) : daoAddress;
  const [multisigPda] = multisig.getMultisigPda({
    createKey: dao,
  });

  const [spendingLimitPda] = multisig.getSpendingLimitPda({
    multisigPda: multisigPda,
    createKey: dao,
  });

  const [vaultPda] = multisig.getVaultPda({
    multisigPda: multisigPda,
    index: 0,
  });

  return {
    multisigPda,
    spendingLimitPda,
    vaultPda,
  };
};

/**
 * Fetch current transaction index from Squads multisig account
 */
export const getSquadsTransactionIndex = async (
  connection: Connection,
  daoAddress: string | PublicKey,
): Promise<bigint | null> => {
  try {
    const { multisigPda } = await getSquadsPdasFromDao(daoAddress);

    const multisigInfo = await multisig.accounts.Multisig.fromAccountAddress(
      connection,
      multisigPda
    );

    // Convert BN to bigint (transactionIndex from @sqds/multisig is a BN)
    return BigInt(multisigInfo.transactionIndex.toString());
  } catch (error) {
    logger.error(
      { error, daoAddress: daoAddress.toString() },
      "Failed to fetch Squads transaction index"
    );
    return null;
  }
};
