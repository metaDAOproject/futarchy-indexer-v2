import { createProgramIndexer } from "../../../core/registry";
import { processLaunchpadEvent, processLaunchpadAccountUpdate } from "./processor";
import { LAUNCHPAD_PROGRAM_ID } from "@metadaoproject/futarchy/v0.6";
import { launchpadClient } from "../../../connections/v0.6";
import { snapshotLaunchpadAccounts } from "./snapshot";

export const launchpadIndexer = createProgramIndexer({
  programId: LAUNCHPAD_PROGRAM_ID,
  name: "launchpad-v0.6",
  programs: [
    launchpadClient.launchpad,         // v0.6.1 (current)
    launchpadClient.v0_6_0_launchpad,  // v0.6.0 (old)
  ],
  accountTypes: ["launch", "fundingRecord"],
  processEvent: processLaunchpadEvent,
  processAccountUpdate: processLaunchpadAccountUpdate,
  snapshotAccounts: snapshotLaunchpadAccounts,
});
