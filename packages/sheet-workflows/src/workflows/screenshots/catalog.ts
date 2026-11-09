import { ScreenshotsCaptureAndDeliver } from "sheet-workflow-contracts";

export const ScreenshotSheetWorkflowContracts = Object.freeze([
  ScreenshotsCaptureAndDeliver,
] as const);

/** Shard identities used by the screenshot workflow and its runtime ownership checks. */
export const screenshotShardGroups = Object.freeze({
  workflow: "dispatch",
  source: "dispatch",
  browser: "browser",
} as const);

export const screenshotWorkflowDefinitionVersion = "1";
export const screenshotActionVersion = "2";
