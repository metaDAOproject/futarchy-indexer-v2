import { Connection } from "@solana/web3.js";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { LaunchpadClient, BidWallClient, PriceBasedPerformancePackageClient } from "@metadaoproject/futarchy/v0.7";

export const RPC_ENDPOINT = process.env.RPC_ENDPOINT ?? "";

if (!RPC_ENDPOINT) {
  throw new Error("RPC_ENDPOINT is not set");
}

export const connection: Connection = new Connection(RPC_ENDPOINT, "confirmed");

// The indexer will only be reading, not writing
export const readonlyWallet: Wallet = undefined as unknown as Wallet;
export const provider = new AnchorProvider(connection, readonlyWallet, {
  commitment: "confirmed",
});

// SDK v0.7 clients - used by:
// - launchpad/v0.7
// - bid-wall/v0.7
// - performance-package/v0.7
export const launchpadV7Client = LaunchpadClient.createClient({ provider });
export const bidWallClient = BidWallClient.createClient({ provider });
export const priceBasedPerformancePackageClient = PriceBasedPerformancePackageClient.createClient({ provider });
