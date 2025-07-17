import { Connection } from "@solana/web3.js";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { ConditionalVaultClient, AmmClient, LaunchpadClient, AutocratClient } from "@metadaoproject/futarchy/v0.5";
import dns from 'dns';
import { promisify } from 'util';

const resolve4 = promisify(dns.resolve4);

export const RPC_ENDPOINT = process.env.RPC_ENDPOINT ?? "";

if (!RPC_ENDPOINT) {
  throw new Error("RPC_ENDPOINT is not set");
}

export const connection: Connection = new Connection(RPC_ENDPOINT, "confirmed");


try {
  const hostname = new URL(RPC_ENDPOINT).hostname;
  const addresses = await resolve4(hostname);
  console.log("IP we're connecting to: ", addresses[0]);
} catch (error) {
  console.error('Error resolving IP:', error);
  const hostname = new URL(RPC_ENDPOINT).hostname;
  console.log("Hostname we're connecting to: ", hostname);
}


// the indexer will only be reading, not writing
export const readonlyWallet: Wallet = undefined as unknown as Wallet;
export const provider = new AnchorProvider(connection, readonlyWallet, {
  commitment: "confirmed",
});

export const ammClient = AmmClient.createClient({ provider });
export const conditionalVaultClient = ConditionalVaultClient.createClient({ provider });
export const launchpadClient = LaunchpadClient.createClient({ provider });
export const autocratClient = AutocratClient.createClient({ provider });