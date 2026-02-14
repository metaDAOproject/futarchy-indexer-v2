import { createProgramIndexer } from "../../../core/registry";
import { processVaultEvent, processVaultAccountUpdate } from "./processor";
import { CONDITIONAL_VAULT_PROGRAM_ID } from "@metadaoproject/futarchy/v0.6";
import { conditionalVaultClient } from "../../../connections/v0.6";
import { snapshotVaultAccounts } from "./snapshot";

export const vaultIndexer = createProgramIndexer({
  programId: CONDITIONAL_VAULT_PROGRAM_ID,
  name: "conditional-vault-v0.4",
  programs: [conditionalVaultClient.vaultProgram],
  accountTypes: ["conditionalVault", "question"],
  processEvent: processVaultEvent,
  processAccountUpdate: processVaultAccountUpdate,
  snapshotAccounts: snapshotVaultAccounts,
});
