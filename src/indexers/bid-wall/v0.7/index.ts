import { createProgramIndexer } from "../../../core/registry";
import { processBidWallEvent, processBidWallAccountUpdate } from "./processor";
import { BID_WALL_PROGRAM_ID } from "@metadaoproject/futarchy/v0.7";
import { bidWallClient } from "../../../connections/v0.7";
import { snapshotBidWallAccounts } from "./snapshot";

export const bidWallIndexer = createProgramIndexer({
  programId: BID_WALL_PROGRAM_ID,
  name: "bid-wall-v0.7",
  programs: [bidWallClient.bidWallProgram],
  accountTypes: ["bidWall"],
  processEvent: processBidWallEvent,
  processAccountUpdate: processBidWallAccountUpdate,
  snapshotAccounts: snapshotBidWallAccounts,
});
