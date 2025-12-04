import { createProgramIndexer } from "../../../core/registry";
import { processLaunchpadV7Event, processLaunchpadV7AccountUpdate } from "./processor";
import { LAUNCHPAD_PROGRAM_ID } from "@metadaoproject/futarchy/v0.7";
import { launchpadV7Client } from "../../../connections/v0.7";
import { snapshotLaunchpadV7Accounts } from "./snapshot";

export const launchpadV7Indexer = createProgramIndexer({
  programId: LAUNCHPAD_PROGRAM_ID,
  name: "launchpad-v0.7",
  program: launchpadV7Client.launchpad,
  accountTypes: ["launch", "fundingRecord"],
  processEvent: processLaunchpadV7Event,
  processAccountUpdate: processLaunchpadV7AccountUpdate,
  snapshotAccounts: snapshotLaunchpadV7Accounts,
});
