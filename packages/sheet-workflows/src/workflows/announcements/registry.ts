import type { SheetWorkflowRegistration } from "../shared/registration";
import { makeSheetWorkflowRegistration } from "../shared/registration";
import {
  announcementSheetWorkflowDefinitionVersion,
  AnnouncementSheetWorkflowContracts,
} from "./catalog";

export const AnnouncementSheetWorkflowRegistrations: ReadonlyArray<SheetWorkflowRegistration> =
  Object.freeze(
    AnnouncementSheetWorkflowContracts.map(
      makeSheetWorkflowRegistration(announcementSheetWorkflowDefinitionVersion),
    ),
  );
