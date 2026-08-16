import type { SheetWorkflowRegistration } from "../shared/registration";
import { makeSheetWorkflowRegistration } from "../shared/registration";
import { ScreenshotSheetWorkflowContracts, screenshotWorkflowDefinitionVersion } from "./catalog";

export const ScreenshotSheetWorkflowRegistrations: ReadonlyArray<SheetWorkflowRegistration> =
  Object.freeze(
    ScreenshotSheetWorkflowContracts.map(
      makeSheetWorkflowRegistration(screenshotWorkflowDefinitionVersion),
    ),
  );
