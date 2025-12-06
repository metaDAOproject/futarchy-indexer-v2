import { createProgramIndexer } from "../../../core/registry";
import { processFutarchyEvent, processFutarchyAccountUpdate } from "./processor";
import { FUTARCHY_PROGRAM_ID } from "@metadaoproject/futarchy/v0.6";
import { futarchyClient } from "../../../connections/v0.6";
import { snapshotFutarchyAccounts } from "./snapshot";

export const futarchyIndexer = createProgramIndexer({
  programId: FUTARCHY_PROGRAM_ID,
  name: "futarchy-v0.6",
  program: futarchyClient.futarchy,
  accountTypes: ["dao", "proposal", "stakeAccount"],
  processEvent: processFutarchyEvent,
  processAccountUpdate: processFutarchyAccountUpdate,
  snapshotAccounts: snapshotFutarchyAccounts,
  // Skip high-volume swap events in RPC fallback mode (indexed via GRPC account updates)
  skipEvents: ["SpotSwap"],
});
