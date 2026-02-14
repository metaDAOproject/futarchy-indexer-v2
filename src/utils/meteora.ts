import { Connection, PublicKey } from "@solana/web3.js";
import { DAMM_V2_PROGRAM_ID } from "@metadaoproject/futarchy/v0.7";
import { CpAmm, getUnClaimLpFee } from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";
import { maxKey, minKey } from "./general";

/**
 * Check Meteora DAMM claimable fees for a DAO position
 */
export async function getMeteoraDammFees(
  connection: Connection,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  launchpadProgramId: PublicKey,
  meteoraConfig: PublicKey
): Promise<{ feeA: BN; feeB: BN } | null> {
  const cpAmm = new CpAmm(connection);

  // Derive position NFT mint (from launchpad program)
  const [positionNftMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("position_nft_mint"), baseMint.toBuffer()],
    launchpadProgramId
  );

  // Derive pool address
  const [poolAddress] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      meteoraConfig.toBuffer(),
      maxKey(baseMint, quoteMint),
      minKey(baseMint, quoteMint),
    ],
    DAMM_V2_PROGRAM_ID
  );

  // Derive position address
  const [positionAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), positionNftMint.toBuffer()],
    DAMM_V2_PROGRAM_ID
  );

  try {
    const poolState = await cpAmm.fetchPoolState(poolAddress);
    const positionState = await cpAmm.fetchPositionState(positionAddress);
    const unclaimedFees = getUnClaimLpFee(poolState, positionState);

    return {
      feeA: unclaimedFees.feeTokenA,
      feeB: unclaimedFees.feeTokenB,
    };
  } catch {
    return null; // Pool or position doesn't exist
  }
}
