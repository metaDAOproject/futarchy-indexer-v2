import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

/**
 * Compare public keys - returns larger key buffer
 */
export function maxKey(left: PublicKey, right: PublicKey): Buffer {
  const leftBytes = left.toBuffer();
  const rightBytes = right.toBuffer();
  for (let i = 0; i < 32; i++) {
    if (leftBytes[i] > rightBytes[i]) return leftBytes;
    if (leftBytes[i] < rightBytes[i]) return rightBytes;
  }
  return leftBytes;
}

/**
 * Compare public keys - returns smaller key buffer
 */
export function minKey(left: PublicKey, right: PublicKey): Buffer {
  const leftBytes = left.toBuffer();
  const rightBytes = right.toBuffer();
  for (let i = 0; i < 32; i++) {
    if (leftBytes[i] < rightBytes[i]) return leftBytes;
    if (leftBytes[i] > rightBytes[i]) return rightBytes;
  }
  return leftBytes;
}

/**
 * Get block time and slot for a transaction signature
 */
export async function getBlockTimeAndSlot(
  connection: Connection,
  signature: string
): Promise<{ blockTime: Date; slot: bigint } | null> {
  try {
    const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
    if (tx?.blockTime && tx?.slot) {
      return {
        blockTime: new Date(tx.blockTime * 1000),
        slot: BigInt(tx.slot),
      };
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Extract AMM state info from DAO account
 * Matches pattern from indexer's extractReservesFromAmmState
 */
export function extractAmmState(daoAccount: any): {
  isSpot: boolean;
  baseProtocolFeeBalance: BN;
  quoteProtocolFeeBalance: BN;
  lastPrice: string;
} {
  let isSpot = false;
  let baseProtocolFeeBalance = new BN(0);
  let quoteProtocolFeeBalance = new BN(0);
  let lastPrice = "0";

  try {
    const state = daoAccount.amm?.state;
    if (!state) {
      return { isSpot: false, baseProtocolFeeBalance, quoteProtocolFeeBalance, lastPrice };
    }

    if ("spot" in state) {
      isSpot = true;
      const pool = state.spot?.spot;
      baseProtocolFeeBalance = new BN(pool?.baseProtocolFeeBalance?.toString() || "0");
      quoteProtocolFeeBalance = new BN(pool?.quoteProtocolFeeBalance?.toString() || "0");
      lastPrice = pool?.oracle?.lastPrice?.toString() || "0";
    } else if ("futarchy" in state) {
      isSpot = false;
      const pool = state.futarchy?.spot?.spot;
      baseProtocolFeeBalance = new BN(pool?.baseProtocolFeeBalance?.toString() || "0");
      quoteProtocolFeeBalance = new BN(pool?.quoteProtocolFeeBalance?.toString() || "0");
      lastPrice = pool?.oracle?.lastPrice?.toString() || "0";
    }
  } catch {
    // Ignore errors extracting AMM state
  }

  return { isSpot, baseProtocolFeeBalance, quoteProtocolFeeBalance, lastPrice };
}
