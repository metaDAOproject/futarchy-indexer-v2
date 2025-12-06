import { createProgramIndexer } from "../../../core/registry";
import { processLaunchpadEvent, processLaunchpadAccountUpdate } from "./processor";
import { LAUNCHPAD_PROGRAM_ID } from "@metadaoproject/futarchy/v0.6";
import { launchpadClient } from "../../../connections/v0.6";
import { snapshotLaunchpadAccounts } from "./snapshot";

export const launchpadIndexer = createProgramIndexer({
  programId: LAUNCHPAD_PROGRAM_ID,
  name: "launchpad-v0.6.1",
  program: launchpadClient.launchpad,
  accountTypes: ["launch", "fundingRecord"],
  processEvent: processLaunchpadEvent,
  processAccountUpdate: processLaunchpadAccountUpdate,
  snapshotAccounts: snapshotLaunchpadAccounts,
});

export const launchpadV06Indexer = createProgramIndexer({
  programId: LAUNCHPAD_PROGRAM_ID,
  name: "launchpad-v0.6.0",
  program: launchpadClient.v0_6_0_launchpad,
  accountTypes: ["launch", "fundingRecord"],
  processEvent: processLaunchpadEvent,
  processAccountUpdate: processLaunchpadAccountUpdate,
  snapshotAccounts: snapshotLaunchpadAccounts,
});
