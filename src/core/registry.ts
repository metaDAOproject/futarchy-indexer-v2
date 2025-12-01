import { PublicKey } from "@solana/web3.js";
import type { VersionedTransactionResponse } from "@solana/web3.js";
import { log } from "../logger/logger";

const logger = log.child({ module: "registry" });

/**
 * Configuration for backfill operations
 * Phase 1: snapshotAccounts - fast .all() snapshot of current state
 * Phase 2: signature crawl - handled by signatureFetcher using signatureAddresses
 */
export interface BackfillConfig {
  // Programs to fetch signatures for (usually just the program itself)
  signatureAddresses: PublicKey[];

  // Phase 1: Fast snapshot of current on-chain account state
  // Runs .all() for each account type, inserts with onConflictDoNothing()
  // Gets current state into DB quickly before signature crawl
  snapshotAccounts?: () => Promise<void>;
}

export interface ProgramIndexer {
  programId: PublicKey;
  name: string;
  discriminators: Record<string, string>;
  decodeEvent: (data: Buffer) => { name: string; data: any } | null;
  processEvent: (event: { name: string; data: any }, signature: string, txResponse: VersionedTransactionResponse) => Promise<void>;
  decodeAccount: (discriminator: string, data: Buffer) => { type: string; data: any } | null;
  processAccountUpdate: (pubkey: string, accountType: string, accountData: any, slot: bigint) => Promise<void>;

  // Optional backfill configuration
  backfillConfig?: BackfillConfig;
}

const programs: Map<string, ProgramIndexer> = new Map();

export function registerProgram(indexer: ProgramIndexer): void {
  const key = `${indexer.name}`;
  programs.set(key, indexer);
  logger.info({ program: indexer.name, programId: indexer.programId.toString() }, "Registered program indexer");
}

export function getAllPrograms(): ProgramIndexer[] {
  return Array.from(programs.values());
}

export function getProgramByOwner(owner: PublicKey): ProgramIndexer | undefined {
  return Array.from(programs.values()).find(p => p.programId.equals(owner));
}

export function getProgramByName(name: string): ProgramIndexer | undefined {
  return programs.get(name);
}

export function getRegisteredProgramIds(): string[] {
  return Array.from(programs.values()).map(p => p.programId.toString());
}
