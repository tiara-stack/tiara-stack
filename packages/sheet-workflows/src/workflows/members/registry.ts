import type { SheetWorkflowRegistration } from "../shared/registration";
import { makeSheetWorkflowRegistration } from "../shared/registration";
import { memberSheetWorkflowDefinitionVersion, MemberSheetWorkflowContracts } from "./catalog";

export const MemberSheetWorkflowRegistrations: ReadonlyArray<SheetWorkflowRegistration> =
  Object.freeze(
    MemberSheetWorkflowContracts.map(
      makeSheetWorkflowRegistration(memberSheetWorkflowDefinitionVersion),
    ),
  );
