import { registerProgram, ProgramIndexer } from "../../../core/registry";
import { processVaultEvent, processVaultAccountUpdate } from "./processor";
import { CONDITIONAL_VAULT_PROGRAM_ID } from "@metadaoproject/futarchy/v0.6";
import { conditionalVaultClient } from "../../../v6_indexer/connection";
import * as anchor from "@coral-xyz/anchor";

// Account discriminators (first 8 bytes identify account type)
const DISCRIMINATORS: Record<string, string> = {
  conditionalVault: conditionalVaultClient.vaultProgram.coder.accounts.memcmp("conditionalVault").bytes,
  question: conditionalVaultClient.vaultProgram.coder.accounts.memcmp("question").bytes,
};

// Reverse lookup: discriminator -> account type
const DISCRIMINATOR_TO_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(DISCRIMINATORS).map(([type, disc]) => [disc, type])
);

const vaultIndexer: ProgramIndexer = {
  programId: CONDITIONAL_VAULT_PROGRAM_ID,
  name: "conditional-vault-v0.4",
  discriminators: DISCRIMINATORS,

  decodeEvent(data: Buffer): { name: string; data: any } | null {
    try {
      const eventData = anchor.utils.bytes.base64.encode(data.slice(8));
      const event = conditionalVaultClient.vaultProgram.coder.events.decode(eventData);
      if (event) {
        return { name: event.name, data: event.data };
      }
    } catch {
      // Not an event, expected
    }
    return null;
  },

  async processEvent(event, signature, txResponse) {
    await processVaultEvent(event, signature, txResponse);
  },

  decodeAccount(discriminator: string, data: Buffer): { type: string; data: any } | null {
    const accountType = DISCRIMINATOR_TO_TYPE[discriminator];
    if (!accountType) {
      return null;
    }

    try {
      const decoded = conditionalVaultClient.vaultProgram.coder.accounts.decode(accountType, data);
      return { type: accountType, data: decoded };
    } catch {
      return null;
    }
  },

  async processAccountUpdate(pubkey, accountType, accountData, slot) {
    await processVaultAccountUpdate(pubkey, accountType, accountData, slot);
  },
};

// Register the indexer
registerProgram(vaultIndexer);

export { vaultIndexer };
