import { createProgramIndexer } from "../../../core/registry";
import { processLaunchpadEvent, processLaunchpadAccountUpdate } from "./processor";
import { LAUNCHPAD_PROGRAM_ID } from "@metadaoproject/futarchy/v0.6";
import { launchpadClient } from "../../../connections/v0.6";
import { snapshotLaunchpadAccounts } from "./snapshot";

export const launchpadIndexer = createProgramIndexer({
  programId: LAUNCHPAD_PROGRAM_ID,
  name: "launchpad-v0.6",
  program: launchpadClient.launchpad,
  accountTypes: ["launch", "fundingRecord"],
  processEvent: processLaunchpadEvent,
  processAccountUpdate: processLaunchpadAccountUpdate,
  snapshotAccounts: snapshotLaunchpadAccounts,
});
