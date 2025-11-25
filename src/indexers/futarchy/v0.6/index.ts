import { registerProgram, ProgramIndexer } from "../../../core/registry";
import { processFutarchyEvent, processFutarchyAccountUpdate } from "./processor";
import { FUTARCHY_PROGRAM_ID } from "@metadaoproject/futarchy/v0.6";
import { futarchyClient } from "../../../v6_indexer/connection";
import * as anchor from "@coral-xyz/anchor";

// Account discriminators (first 8 bytes identify account type)
const DISCRIMINATORS: Record<string, string> = {
  dao: futarchyClient.autocrat.coder.accounts.memcmp("dao").bytes,
  proposal: futarchyClient.autocrat.coder.accounts.memcmp("proposal").bytes,
  stakeAccount: futarchyClient.autocrat.coder.accounts.memcmp("stakeAccount").bytes,
};

// Reverse lookup: discriminator -> account type
const DISCRIMINATOR_TO_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(DISCRIMINATORS).map(([type, disc]) => [disc, type])
);

const futarchyIndexer: ProgramIndexer = {
  programId: FUTARCHY_PROGRAM_ID,
  name: "futarchy-v0.6",
  discriminators: DISCRIMINATORS,

  decodeEvent(data: Buffer): { name: string; data: any } | null {
    try {
      const eventData = anchor.utils.bytes.base64.encode(data.slice(8));
      const event = futarchyClient.autocrat.coder.events.decode(eventData);
      if (event) {
        return { name: event.name, data: event.data };
      }
    } catch {
      // Not an event, expected
    }
    return null;
  },

  async processEvent(event, signature, txResponse) {
    await processFutarchyEvent(event, signature, txResponse);
  },

  decodeAccount(discriminator: string, data: Buffer): { type: string; data: any } | null {
    const accountType = DISCRIMINATOR_TO_TYPE[discriminator];
    if (!accountType) {
      return null;
    }

    try {
      const decoded = futarchyClient.autocrat.coder.accounts.decode(accountType, data);
      return { type: accountType, data: decoded };
    } catch {
      return null;
    }
  },

  async processAccountUpdate(pubkey, accountType, accountData, slot) {
    await processFutarchyAccountUpdate(pubkey, accountType, accountData, slot);
  },
};

// Register the indexer
registerProgram(futarchyIndexer);

export { futarchyIndexer };
