import { Connection } from "@solana/web3.js";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { ConditionalVaultClient, FutarchyClient } from "@metadaoproject/futarchy/v0.7";
import { FutarchyClient as FutarchyClientV06, LaunchpadClient } from "@metadaoproject/futarchy/v0.6";
import dns from 'dns';
import { promisify } from 'util';

const resolve4 = promisify(dns.resolve4);

export const RPC_ENDPOINT = process.env.RPC_ENDPOINT ?? "";

if (!RPC_ENDPOINT) {
  throw new Error("RPC_ENDPOINT is not set");
}

export const connection: Connection = new Connection(RPC_ENDPOINT, "confirmed");

// Log the IP we're connecting to for debugging
try {
  const hostname = new URL(RPC_ENDPOINT).hostname;
  const addresses = await resolve4(hostname);
  console.log("IP we're connecting to: ", addresses[0]);
} catch (error) {
  console.error('Error resolving IP:', error);
  const hostname = new URL(RPC_ENDPOINT).hostname;
  console.log("Hostname we're connecting to: ", hostname);
}

// The indexer will only be reading, not writing
export const readonlyWallet: Wallet = undefined as unknown as Wallet;
export const provider = new AnchorProvider(connection, readonlyWallet, {
  commitment: "confirmed",
});

// SDK v0.6 clients - used by:
// - futarchy/v0.6
// - launchpad/v0.6
// - conditional-vault/v0.4
export const conditionalVaultClient = ConditionalVaultClient.createClient({ provider });
export const launchpadClient = LaunchpadClient.createClient({ provider });
export const futarchyClient = FutarchyClient.createClient({ provider });
export const futarchyClientV06 = FutarchyClientV06.createClient({ provider });