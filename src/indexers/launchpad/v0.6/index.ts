import { registerProgram, ProgramIndexer } from "../../../core/registry";
import { processLaunchpadEvent, processLaunchpadAccountUpdate } from "./processor";
import { LAUNCHPAD_PROGRAM_ID } from "@metadaoproject/futarchy/v0.6";
import { launchpadClient } from "../../../connections/v0.6";
import { snapshotLaunchpadAccounts } from "./snapshot";
import * as anchor from "@coral-xyz/anchor";

// Account discriminators (first 8 bytes identify account type)
const DISCRIMINATORS: Record<string, string> = {
  launch: launchpadClient.launchpad.coder.accounts.memcmp("launch").bytes,
  fundingRecord: launchpadClient.launchpad.coder.accounts.memcmp("fundingRecord").bytes,
};

// Reverse lookup: discriminator -> account type
const DISCRIMINATOR_TO_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(DISCRIMINATORS).map(([type, disc]) => [disc, type])
);

const launchpadIndexer: ProgramIndexer = {
  programId: LAUNCHPAD_PROGRAM_ID,
  name: "launchpad-v0.6",
  discriminators: DISCRIMINATORS,

  decodeEvent(data: Buffer): { name: string; data: any } | null {
    try {
      const eventData = anchor.utils.bytes.base64.encode(data.slice(8));
      const event = launchpadClient.launchpad.coder.events.decode(eventData);
      if (event) {
        return { name: event.name, data: event.data };
      }
    } catch {
      // Not an event, expected
    }
    return null;
  },

  async processEvent(event, signature, txResponse) {
    await processLaunchpadEvent(event, signature, txResponse);
  },

  decodeAccount(discriminator: string, data: Buffer): { type: string; data: any } | null {
    const accountType = DISCRIMINATOR_TO_TYPE[discriminator];
    if (!accountType) {
      return null;
    }

    try {
      const decoded = launchpadClient.launchpad.coder.accounts.decode(accountType, data);
      return { type: accountType, data: decoded };
    } catch {
      return null;
    }
  },

  async processAccountUpdate(pubkey, accountType, accountData, slot) {
    await processLaunchpadAccountUpdate(pubkey, accountType, accountData, slot);
  },

  // Backfill configuration
  backfillConfig: {
    // Launchpad program handles launches, funding records, claims, refunds
    signatureAddresses: [LAUNCHPAD_PROGRAM_ID],
    // Snapshot current state before signature crawl
    snapshotAccounts: snapshotLaunchpadAccounts,
  },
};

// Register the indexer
registerProgram(launchpadIndexer);

export { launchpadIndexer };
