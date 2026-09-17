import { make, type ZeroApi, type ZeroApiGroup, ZeroFunctionReference } from "typhoon-zero/zeroApi";
import type { Schema as ZeroSchema } from "./schema";
import { makeCheckinMessagesGroup, type CheckinMessagesGroup } from "./api/checkinMessages";
import { makeMessageCheckinGroup, type MessageCheckinGroup } from "./api/messageCheckin";
import { makeMessageRoomOrderGroup, type MessageRoomOrderGroup } from "./api/messageRoomOrder";
import { makeMessageSlotGroup, type MessageSlotGroup } from "./api/messageSlot";
import {
  makeMessageTeamSubmissionGroup,
  type MessageTeamSubmissionGroup,
} from "./api/messageTeamSubmission";
import { defaultSuccessSchemas, type SheetZeroApiSuccessSchemas } from "./api/successSchemas";
import { makeUserConfigGroup, type UserConfigGroup } from "./api/userConfig";
import { makeWorkspaceConfigGroup, type WorkspaceConfigGroup } from "./api/workspaceConfig";
import {
  makeSheetConfigurationGroup,
  type SheetConfigurationGroup,
} from "./api/sheetConfiguration";
import { runsGroup, type RunsGroup } from "./api/runs";
import {
  sheetWorkflowZeroObservationGroups,
  type SheetWorkflowZeroObservationGroup,
} from "./workflows";

export type { SheetZeroApiSuccessSchemas } from "./api/successSchemas";

declare module "@rocicorp/zero" {
  interface DefaultTypes {
    schema: ZeroSchema;
  }
}

type SheetZeroApi<SuccessSchemas extends SheetZeroApiSuccessSchemas> = ZeroApi<
  "sheet",
  | UserConfigGroup<SuccessSchemas>
  | WorkspaceConfigGroup<SuccessSchemas>
  | SheetConfigurationGroup<SuccessSchemas>
  | CheckinMessagesGroup<SuccessSchemas>
  | MessageCheckinGroup<SuccessSchemas>
  | MessageRoomOrderGroup<SuccessSchemas>
  | MessageSlotGroup<SuccessSchemas>
  | MessageTeamSubmissionGroup<SuccessSchemas>
  | SheetWorkflowZeroObservationGroup
  | RunsGroup
>;

export type SheetWorkflowZeroObservationApi = ZeroApi<"sheet", SheetWorkflowZeroObservationGroup>;

const addWorkflowObservationGroups = <Groups extends ZeroApiGroup.Any>(
  api: ZeroApi<"sheet", Groups>,
): ZeroApi<"sheet", Groups | SheetWorkflowZeroObservationGroup> => {
  let current = api as ZeroApi<"sheet", Groups | SheetWorkflowZeroObservationGroup>;
  for (const group of sheetWorkflowZeroObservationGroups) {
    current = current.add(group);
  }
  return current;
};

export const SheetWorkflowZeroObservationApi: SheetWorkflowZeroObservationApi =
  addWorkflowObservationGroups(make("sheet"));

const makeSheetZeroApiWithSuccess = <const SuccessSchemas extends SheetZeroApiSuccessSchemas>(
  success: SuccessSchemas,
): SheetZeroApi<SuccessSchemas> =>
  addWorkflowObservationGroups(
    make("sheet")
      .add(makeUserConfigGroup(success))
      .add(makeWorkspaceConfigGroup(success))
      .add(makeSheetConfigurationGroup(success))
      .add(makeCheckinMessagesGroup(success))
      .add(makeMessageCheckinGroup(success))
      .add(makeMessageRoomOrderGroup(success))
      .add(makeMessageSlotGroup(success))
      .add(makeMessageTeamSubmissionGroup(success))
      .add(runsGroup),
  );

export function makeSheetZeroApi(): ReturnType<
  typeof makeSheetZeroApiWithSuccess<typeof defaultSuccessSchemas>
>;
export function makeSheetZeroApi<const SuccessSchemas extends SheetZeroApiSuccessSchemas>(
  success: SuccessSchemas,
): ReturnType<typeof makeSheetZeroApiWithSuccess<SuccessSchemas>>;
export function makeSheetZeroApi(success: SheetZeroApiSuccessSchemas = defaultSuccessSchemas) {
  return makeSheetZeroApiWithSuccess(success);
}

export const SheetZeroApi = makeSheetZeroApi();

/** Public application functions available to web and authenticated clients. */
export const api: ZeroFunctionReference.References<typeof SheetZeroApi, "public"> =
  ZeroFunctionReference.makeReferences(SheetZeroApi, ["public"]);

/** Trusted service functions, including delegated workflow enqueue. */
export const serviceApi: ZeroFunctionReference.References<typeof SheetZeroApi, "service"> =
  ZeroFunctionReference.makeReferences(SheetZeroApi, ["service"]);
