import { make, type ZeroApi, ZeroFunctionReference } from "typhoon-zero/zeroApi";
import type { Schema as ZeroSchema } from "./index";
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
import { runsGroup, type RunsGroup } from "./api/runs";

export {
  DelegatedWorkflowEnqueueRequest,
  enqueueWorkflowCommandInZeroTransaction,
  enqueueWorkflowEventInZeroTransaction,
  enqueueWorkflowInZeroTransaction,
  isWorkflowZeroContext,
  mutateWithWorkflow,
  WorkflowCommandRequest,
  WorkflowEnqueueRequest,
  WorkflowEventRequest,
  WorkflowRunNotAccessibleError,
  type WorkflowZeroContext,
} from "./api/runs";

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
  | MessageCheckinGroup<SuccessSchemas>
  | MessageRoomOrderGroup<SuccessSchemas>
  | MessageSlotGroup<SuccessSchemas>
  | MessageTeamSubmissionGroup<SuccessSchemas>
  | RunsGroup
>;

const makeSheetZeroApiWithSuccess = <const SuccessSchemas extends SheetZeroApiSuccessSchemas>(
  success: SuccessSchemas,
): SheetZeroApi<SuccessSchemas> =>
  make("sheet")
    .add(makeUserConfigGroup(success))
    .add(makeWorkspaceConfigGroup(success))
    .add(makeMessageCheckinGroup(success))
    .add(makeMessageRoomOrderGroup(success))
    .add(makeMessageSlotGroup(success))
    .add(makeMessageTeamSubmissionGroup(success))
    .add(runsGroup);

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
