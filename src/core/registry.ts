import { PublicKey } from "@solana/web3.js";
import type { VersionedTransactionResponse } from "@solana/web3.js";
import { log } from "../logger/logger";
import vm from "node:vm";

const logger = log.child({ module: "registry" });

// Timeout for event decoding to prevent Anchor's infinite loop bug
const DECODE_TIMEOUT_MS = 1000;

/**
 * Safely decode with timeout protection against Anchor's infinite loop bug.
 * Uses vm.Script with timeout to kill runaway decoding.
 */
function decodeWithTimeout(
  decoder: (data: string) => { name: string; data: any } | null,
  eventData: string,
  timeoutMs: number = DECODE_TIMEOUT_MS
): { name: string; data: any } | null {
  const context = { decoder, eventData, result: null as { name: string; data: any } | null };
  vm.createContext(context);
  
  const script = new vm.Script('result = decoder(eventData)');
  script.runInContext(context, { timeout: timeoutMs });
  
  return context.result;
}

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

  // Events to skip when processing via RPC logs (e.g., high-volume events like "SpotSwapEvent")
  skipEvents?: string[];
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

/**
 * Factory configuration for creating a program indexer
 */
export interface ProgramIndexerConfig {
  programId: PublicKey;
  name: string;
  // The Anchor program with coder (e.g., futarchyClient.autocrat, launchpadClient.launchpad)
  program: {
    coder: {
      accounts: {
        memcmp: (accountType: string) => { bytes: string };
        decode: (accountType: string, data: Buffer) => any;
      };
      events: {
        decode: (data: string) => { name: string; data: any } | null;
      };
    };
  };
  // Account types to generate discriminators for
  accountTypes: string[];
  // Event processor
  processEvent: (event: { name: string; data: any }, signature: string, txResponse: VersionedTransactionResponse) => Promise<void>;
  // Account update processor
  processAccountUpdate: (pubkey: string, accountType: string, accountData: any, slot: bigint) => Promise<void>;
  // Optional snapshot function for backfill
  snapshotAccounts?: () => Promise<void>;
  // Events to skip when processing via RPC logs (e.g., high-volume events like "SpotSwapEvent")
  skipEvents?: string[];
}

/**
 * Factory function to create and register a program indexer with minimal boilerplate
 */
export function createProgramIndexer(config: ProgramIndexerConfig): ProgramIndexer {
  const { programId, name, program, accountTypes, processEvent, processAccountUpdate, snapshotAccounts, skipEvents } = config;

  // Generate discriminators from account types
  const discriminators: Record<string, string> = {};
  for (const accountType of accountTypes) {
    discriminators[accountType] = program.coder.accounts.memcmp(accountType).bytes;
  }

  // Reverse lookup: discriminator -> account type
  const discriminatorToType: Record<string, string> = Object.fromEntries(
    Object.entries(discriminators).map(([type, disc]) => [disc, type])
  );

  const indexer: ProgramIndexer = {
    programId,
    name,
    discriminators,

    decodeEvent(data: Buffer): { name: string; data: any } | null {
      try {
        // Skip first 8 bytes (discriminator), encode rest as base64
        const eventData = Buffer.from(data.slice(8)).toString('base64');
        // Use timeout-protected decode to prevent Anchor's infinite loop bug
        const event = decodeWithTimeout(
          (d) => program.coder.events.decode(d),
          eventData
        );
        return event;
      } catch (error) {
        // Timeout errors will have code 'ERR_SCRIPT_EXECUTION_TIMEOUT'
        if ((error as any)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
          logger.warn({ dataLength: data.length }, "Event decode timed out (possible Anchor infinite loop)");
        } else {
          logger.error({ error }, "Error decoding event");
        }
        return null;
      }
    },

    async processEvent(event, signature, txResponse) {
      await processEvent(event, signature, txResponse);
    },

    decodeAccount(discriminator: string, data: Buffer): { type: string; data: any } | null {
      const accountType = discriminatorToType[discriminator];
      if (!accountType) {
        return null;
      }
      try {
        const decoded = program.coder.accounts.decode(accountType, data);
        return { type: accountType, data: decoded };
      } catch {
        return null;
      }
    },

    async processAccountUpdate(pubkey, accountType, accountData, slot) {
      await processAccountUpdate(pubkey, accountType, accountData, slot);
    },

    backfillConfig: {
      signatureAddresses: [programId],
      snapshotAccounts,
    },

    skipEvents,
  };

  // Auto-register
  registerProgram(indexer);

  return indexer;
}
