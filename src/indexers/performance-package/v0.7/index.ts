import { createProgramIndexer } from "../../../core/registry";
import { processPerformancePackageEvent, processPerformancePackageAccountUpdate } from "./processor";
import { PRICE_BASED_PERFORMANCE_PACKAGE_PROGRAM_ID } from "@metadaoproject/futarchy/v0.7";
import { priceBasedPerformancePackageClient } from "../../../connections/v0.7";
import { snapshotPerformancePackageAccounts } from "./snapshot";

export const performancePackageIndexer = createProgramIndexer({
  programId: PRICE_BASED_PERFORMANCE_PACKAGE_PROGRAM_ID,
  name: "performance-package-v0.7",
  programs: [priceBasedPerformancePackageClient.program],
  accountTypes: ["performancePackage"],
  processEvent: processPerformancePackageEvent,
  processAccountUpdate: processPerformancePackageAccountUpdate,
  snapshotAccounts: snapshotPerformancePackageAccounts,
});
