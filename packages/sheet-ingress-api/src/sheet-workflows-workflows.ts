import { Schema } from "effect";
import { Workflow } from "effect/unstable/workflow";
import type { ClientRef } from "./schemas/client";
import { MessageRoomOrder } from "./schemas/messageRoomOrder";
import {
  AutoCheckinTestDispatchPayload,
  AutoCheckinTestDispatchResult,
  CheckinDispatchError,
  CheckinDispatchPayload,
  CheckinDispatchResult,
  CheckinHandleButtonError,
  CheckinHandleButtonPayload,
  CheckinHandleButtonResult,
  BotCommandDispatchError,
  ConversationListConfigDispatchPayload,
  ConversationListConfigDispatchResult,
  ConversationSetDispatchPayload,
  ConversationSetDispatchResult,
  ConversationUnsetDispatchPayload,
  ConversationUnsetDispatchResult,
  DispatchAcceptedResult,
  DispatchRoomOrderButtonMethods,
  DispatchTeamSubmissionButtonMethods,
  WorkspaceWelcomeDispatchError,
  WorkspaceWelcomeDispatchPayload,
  WorkspaceWelcomeDispatchResult,
  KickoutDispatchError,
  KickoutDispatchPayload,
  KickoutDispatchResult,
  PreferenceDmDisableDispatchPayload,
  PreferenceDmDispatchResult,
  PreferenceDmEnableDispatchPayload,
  PreferenceDmSetClientDispatchPayload,
  PreferenceDmStatusDispatchPayload,
  RoomOrderDispatchError,
  RoomOrderDispatchPayload,
  RoomOrderDispatchResult,
  RoomOrderHandleButtonError,
  RoomOrderNextButtonPayload,
  RoomOrderNextButtonResult,
  RoomOrderPinTentativeButtonPayload,
  RoomOrderPinTentativeButtonResult,
  RoomOrderPreviousButtonPayload,
  RoomOrderPreviousButtonResult,
  RoomOrderSendButtonPayload,
  RoomOrderSendButtonResult,
  ScheduleListDispatchPayload,
  ScheduleListDispatchResult,
  ServiceWorkspaceFeatureFlagDispatchPayload,
  ServiceWorkspaceFeatureFlagDispatchResult,
  ServiceStatusDispatchError,
  ServiceStatusDispatchPayload,
  ServiceStatusDispatchResult,
  WorkspaceAddMonitorRoleDispatchPayload,
  WorkspaceAddMonitorRoleDispatchResult,
  WorkspaceListConfigDispatchPayload,
  WorkspaceListConfigDispatchResult,
  WorkspaceRemoveMonitorRoleDispatchPayload,
  WorkspaceRemoveMonitorRoleDispatchResult,
  WorkspaceSetAutoCheckinDispatchPayload,
  WorkspaceSetAutoCheckinDispatchResult,
  WorkspaceSetSheetDispatchPayload,
  WorkspaceSetSheetDispatchResult,
  ScreenshotDispatchPayload,
  ScreenshotDispatchResult,
  SlotButtonDispatchPayload,
  SlotButtonDispatchResult,
  SlotDispatchError,
  SlotListDispatchPayload,
  SlotListDispatchResult,
  SlotOpenButtonPayload,
  SlotOpenButtonResult,
  TeamListDispatchPayload,
  TeamListDispatchResult,
  TeamSubmissionDispatchError,
  TeamSubmissionButtonDispatchError,
  TeamSubmissionConfirmButtonDispatchPayload,
  TeamSubmissionConfirmButtonDispatchResult,
  TeamSubmissionDispatchPayload,
  TeamSubmissionDispatchResult,
  TeamSubmissionRejectButtonDispatchPayload,
  TeamSubmissionRejectButtonDispatchResult,
  UpdateAnnouncementDispatchError,
  UpdateAnnouncementDispatchPayload,
  UpdateAnnouncementDispatchResult,
} from "./handlers/dispatch/schema";

export const DispatchRequesterSchema = Schema.Struct({
  accountId: Schema.String,
  userId: Schema.String,
});

export type DispatchRequester = Schema.Schema.Type<typeof DispatchRequesterSchema>;

export const DispatchAuthorizationSnapshotSchema = Schema.Struct({
  workspaceId: Schema.String,
  scope: Schema.Literals(["member", "monitor", "manage"]),
});

export type DispatchAuthorizationSnapshot = Schema.Schema.Type<
  typeof DispatchAuthorizationSnapshotSchema
>;

/** Public execution-id schema returned by workflow discard dispatch RPCs. */
export const DispatchWorkflowExecutionId = Schema.String;
/** Public resume payload schema shared by workflow RPC and HTTP dispatch contracts. */
export const DispatchWorkflowResumePayload = Schema.Struct({ executionId: Schema.String });
/** Public accepted-result alias for sheet-workflows workflow dispatch APIs. */
export const DispatchWorkflowAcceptedResult = DispatchAcceptedResult;

const dispatchPayload = <Payload extends Schema.Top>(payload: Payload) =>
  Schema.Struct({
    requester: DispatchRequesterSchema,
    authorization: Schema.optional(DispatchAuthorizationSnapshotSchema),
    interactionResponseDeadlineEpochMs: Schema.optional(Schema.Number),
    payload,
  });

/**
 * Room-order button workflows persist the ingress-provided authorization snapshot
 * for deterministic replay. The cluster registry re-fetches and validates the
 * current MessageRoomOrder before execution, and uses that fresh value for the
 * service call.
 */
const roomOrderButtonPayload = <Payload extends Schema.Top>(payload: Payload) =>
  Schema.Struct({
    requester: DispatchRequesterSchema,
    interactionResponseDeadlineEpochMs: Schema.optional(Schema.Number),
    payload,
    authorizedRoomOrder: MessageRoomOrder,
  });

/**
 * Pin-tentative accepts a missing persisted snapshot so legacy tentative messages
 * can still be pinned. The cluster registry still re-fetches authorization state
 * and passes the fresh MessageRoomOrder or null to execution.
 */
const roomOrderPinTentativePayload = Schema.Struct({
  requester: DispatchRequesterSchema,
  interactionResponseDeadlineEpochMs: Schema.optional(Schema.Number),
  payload: RoomOrderPinTentativeButtonPayload,
  authorizedRoomOrder: Schema.optional(Schema.NullOr(MessageRoomOrder)),
});

const workflowName = {
  autoCheckinTest: "dispatch.autoCheckinTest",
  checkin: "dispatch.checkin",
  roomOrder: "dispatch.roomOrder",
  kickout: "dispatch.kickout",
  slotButton: "dispatch.slotButton",
  slotList: "dispatch.slotList",
  slotOpenButton: "dispatch.slotOpenButton",
  serviceStatus: "dispatch.serviceStatus",
  preferenceDmStatus: "dispatch.preferenceDmStatus",
  preferenceDmEnable: "dispatch.preferenceDmEnable",
  preferenceDmDisable: "dispatch.preferenceDmDisable",
  preferenceDmSetClient: "dispatch.preferenceDmSetClient",
  workspaceWelcome: "dispatch.workspaceWelcome",
  updateAnnouncement: "dispatch.updateAnnouncement",
  serviceAddWorkspaceFeatureFlag: "dispatch.serviceAddWorkspaceFeatureFlag",
  serviceRemoveWorkspaceFeatureFlag: "dispatch.serviceRemoveWorkspaceFeatureFlag",
  checkinButton: "dispatch.checkinButton",
  roomOrderPreviousButton: "dispatch.roomOrderPreviousButton",
  roomOrderNextButton: "dispatch.roomOrderNextButton",
  roomOrderSendButton: "dispatch.roomOrderSendButton",
  roomOrderPinTentativeButton: "dispatch.roomOrderPinTentativeButton",
  conversationListConfig: "dispatch.conversationListConfig",
  conversationSet: "dispatch.conversationSet",
  conversationUnset: "dispatch.conversationUnset",
  workspaceListConfig: "dispatch.workspaceListConfig",
  workspaceAddMonitorRole: "dispatch.workspaceAddMonitorRole",
  workspaceRemoveMonitorRole: "dispatch.workspaceRemoveMonitorRole",
  workspaceSetSheet: "dispatch.workspaceSetSheet",
  workspaceSetAutoCheckin: "dispatch.workspaceSetAutoCheckin",
  teamList: "dispatch.teamList",
  teamSubmission: "dispatch.teamSubmission",
  teamSubmissionConfirmButton: "dispatch.teamSubmission.confirmButton",
  teamSubmissionRejectButton: "dispatch.teamSubmission.rejectButton",
  scheduleList: "dispatch.scheduleList",
  screenshot: "dispatch.screenshot",
} as const;

const clientKey = (payload: { readonly client: ClientRef }) =>
  `${payload.client.platform}:${payload.client.clientId}`;

const dispatchRequestIdempotencyKey = (payload: {
  readonly client: ClientRef;
  readonly dispatchRequestId: string;
}) => `${clientKey(payload)}:${payload.dispatchRequestId}`;

const buttonIdempotencyKey = (
  operation: string,
  payload: {
    readonly client: ClientRef;
    readonly messageId: string;
    readonly interactionResponseToken: string;
  },
) =>
  `${clientKey(payload)}:button:${operation}:${payload.messageId}:${payload.interactionResponseToken}`;

export const DispatchAutoCheckinTestWorkflow = Workflow.make({
  name: workflowName.autoCheckinTest,
  payload: dispatchPayload(AutoCheckinTestDispatchPayload),
  success: AutoCheckinTestDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchCheckinWorkflow = Workflow.make({
  name: workflowName.checkin,
  payload: dispatchPayload(CheckinDispatchPayload),
  success: CheckinDispatchResult,
  error: CheckinDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchRoomOrderWorkflow = Workflow.make({
  name: workflowName.roomOrder,
  payload: dispatchPayload(RoomOrderDispatchPayload),
  success: RoomOrderDispatchResult,
  error: RoomOrderDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchKickoutWorkflow = Workflow.make({
  name: workflowName.kickout,
  payload: dispatchPayload(KickoutDispatchPayload),
  success: KickoutDispatchResult,
  error: KickoutDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchSlotButtonWorkflow = Workflow.make({
  name: workflowName.slotButton,
  payload: dispatchPayload(SlotButtonDispatchPayload),
  success: SlotButtonDispatchResult,
  error: SlotDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchSlotListWorkflow = Workflow.make({
  name: workflowName.slotList,
  payload: dispatchPayload(SlotListDispatchPayload),
  success: SlotListDispatchResult,
  error: SlotDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchSlotOpenButtonWorkflow = Workflow.make({
  name: workflowName.slotOpenButton,
  payload: dispatchPayload(SlotOpenButtonPayload),
  success: SlotOpenButtonResult,
  error: SlotDispatchError,
  idempotencyKey: ({ payload }) => buttonIdempotencyKey("slotOpenButton", payload),
});

export const DispatchServiceStatusWorkflow = Workflow.make({
  name: workflowName.serviceStatus,
  payload: dispatchPayload(ServiceStatusDispatchPayload),
  success: ServiceStatusDispatchResult,
  error: ServiceStatusDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchPreferenceDmStatusWorkflow = Workflow.make({
  name: workflowName.preferenceDmStatus,
  payload: dispatchPayload(PreferenceDmStatusDispatchPayload),
  success: PreferenceDmDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchPreferenceDmEnableWorkflow = Workflow.make({
  name: workflowName.preferenceDmEnable,
  payload: dispatchPayload(PreferenceDmEnableDispatchPayload),
  success: PreferenceDmDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchPreferenceDmDisableWorkflow = Workflow.make({
  name: workflowName.preferenceDmDisable,
  payload: dispatchPayload(PreferenceDmDisableDispatchPayload),
  success: PreferenceDmDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchPreferenceDmSetClientWorkflow = Workflow.make({
  name: workflowName.preferenceDmSetClient,
  payload: dispatchPayload(PreferenceDmSetClientDispatchPayload),
  success: PreferenceDmDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchWorkspaceWelcomeWorkflow = Workflow.make({
  name: workflowName.workspaceWelcome,
  payload: dispatchPayload(WorkspaceWelcomeDispatchPayload),
  success: WorkspaceWelcomeDispatchResult,
  error: WorkspaceWelcomeDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchUpdateAnnouncementWorkflow = Workflow.make({
  name: workflowName.updateAnnouncement,
  payload: dispatchPayload(UpdateAnnouncementDispatchPayload),
  success: UpdateAnnouncementDispatchResult,
  error: UpdateAnnouncementDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchServiceAddWorkspaceFeatureFlagWorkflow = Workflow.make({
  name: workflowName.serviceAddWorkspaceFeatureFlag,
  payload: dispatchPayload(ServiceWorkspaceFeatureFlagDispatchPayload),
  success: ServiceWorkspaceFeatureFlagDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchServiceRemoveWorkspaceFeatureFlagWorkflow = Workflow.make({
  name: workflowName.serviceRemoveWorkspaceFeatureFlag,
  payload: dispatchPayload(ServiceWorkspaceFeatureFlagDispatchPayload),
  success: ServiceWorkspaceFeatureFlagDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchCheckinButtonWorkflow = Workflow.make({
  name: workflowName.checkinButton,
  payload: dispatchPayload(CheckinHandleButtonPayload),
  success: CheckinHandleButtonResult,
  error: CheckinHandleButtonError,
  idempotencyKey: ({ payload }) => buttonIdempotencyKey("checkinButton", payload),
});

export const DispatchRoomOrderPreviousButtonWorkflow = Workflow.make({
  name: workflowName.roomOrderPreviousButton,
  payload: roomOrderButtonPayload(RoomOrderPreviousButtonPayload),
  success: RoomOrderPreviousButtonResult,
  error: RoomOrderHandleButtonError,
  idempotencyKey: ({ payload }) => buttonIdempotencyKey("roomOrderPreviousButton", payload),
});

export const DispatchRoomOrderNextButtonWorkflow = Workflow.make({
  name: workflowName.roomOrderNextButton,
  payload: roomOrderButtonPayload(RoomOrderNextButtonPayload),
  success: RoomOrderNextButtonResult,
  error: RoomOrderHandleButtonError,
  idempotencyKey: ({ payload }) => buttonIdempotencyKey("roomOrderNextButton", payload),
});

export const DispatchRoomOrderSendButtonWorkflow = Workflow.make({
  name: workflowName.roomOrderSendButton,
  payload: roomOrderButtonPayload(RoomOrderSendButtonPayload),
  success: RoomOrderSendButtonResult,
  error: RoomOrderHandleButtonError,
  idempotencyKey: ({ payload }) => buttonIdempotencyKey("roomOrderSendButton", payload),
});

export const DispatchRoomOrderPinTentativeButtonWorkflow = Workflow.make({
  name: workflowName.roomOrderPinTentativeButton,
  payload: roomOrderPinTentativePayload,
  success: RoomOrderPinTentativeButtonResult,
  error: RoomOrderHandleButtonError,
  idempotencyKey: ({ payload }) => buttonIdempotencyKey("roomOrderPinTentativeButton", payload),
});

export const DispatchConversationListConfigWorkflow = Workflow.make({
  name: workflowName.conversationListConfig,
  payload: dispatchPayload(ConversationListConfigDispatchPayload),
  success: ConversationListConfigDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchConversationSetWorkflow = Workflow.make({
  name: workflowName.conversationSet,
  payload: dispatchPayload(ConversationSetDispatchPayload),
  success: ConversationSetDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchConversationUnsetWorkflow = Workflow.make({
  name: workflowName.conversationUnset,
  payload: dispatchPayload(ConversationUnsetDispatchPayload),
  success: ConversationUnsetDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchWorkspaceListConfigWorkflow = Workflow.make({
  name: workflowName.workspaceListConfig,
  payload: dispatchPayload(WorkspaceListConfigDispatchPayload),
  success: WorkspaceListConfigDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchWorkspaceAddMonitorRoleWorkflow = Workflow.make({
  name: workflowName.workspaceAddMonitorRole,
  payload: dispatchPayload(WorkspaceAddMonitorRoleDispatchPayload),
  success: WorkspaceAddMonitorRoleDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchWorkspaceRemoveMonitorRoleWorkflow = Workflow.make({
  name: workflowName.workspaceRemoveMonitorRole,
  payload: dispatchPayload(WorkspaceRemoveMonitorRoleDispatchPayload),
  success: WorkspaceRemoveMonitorRoleDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchWorkspaceSetSheetWorkflow = Workflow.make({
  name: workflowName.workspaceSetSheet,
  payload: dispatchPayload(WorkspaceSetSheetDispatchPayload),
  success: WorkspaceSetSheetDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchWorkspaceSetAutoCheckinWorkflow = Workflow.make({
  name: workflowName.workspaceSetAutoCheckin,
  payload: dispatchPayload(WorkspaceSetAutoCheckinDispatchPayload),
  success: WorkspaceSetAutoCheckinDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchTeamListWorkflow = Workflow.make({
  name: workflowName.teamList,
  payload: dispatchPayload(TeamListDispatchPayload),
  success: TeamListDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchScheduleListWorkflow = Workflow.make({
  name: workflowName.scheduleList,
  payload: dispatchPayload(ScheduleListDispatchPayload),
  success: ScheduleListDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchScreenshotWorkflow = Workflow.make({
  name: workflowName.screenshot,
  payload: dispatchPayload(ScreenshotDispatchPayload),
  success: ScreenshotDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => dispatchRequestIdempotencyKey(payload),
});

export const DispatchTeamSubmissionWorkflow = Workflow.make({
  name: workflowName.teamSubmission,
  payload: dispatchPayload(TeamSubmissionDispatchPayload),
  success: TeamSubmissionDispatchResult,
  error: TeamSubmissionDispatchError,
  idempotencyKey: ({ payload }) =>
    `${clientKey(payload)}:team-submission:${payload.workspaceId}:${payload.conversationId}:${payload.messageId}:${payload.dispatchRequestId}`,
});

export const DispatchTeamSubmissionConfirmButtonWorkflow = Workflow.make({
  name: workflowName.teamSubmissionConfirmButton,
  payload: dispatchPayload(TeamSubmissionConfirmButtonDispatchPayload),
  success: TeamSubmissionConfirmButtonDispatchResult,
  error: TeamSubmissionButtonDispatchError,
  idempotencyKey: ({ payload }) => buttonIdempotencyKey("teamSubmissionConfirmButton", payload),
});

export const DispatchTeamSubmissionRejectButtonWorkflow = Workflow.make({
  name: workflowName.teamSubmissionRejectButton,
  payload: dispatchPayload(TeamSubmissionRejectButtonDispatchPayload),
  success: TeamSubmissionRejectButtonDispatchResult,
  error: TeamSubmissionButtonDispatchError,
  idempotencyKey: ({ payload }) => buttonIdempotencyKey("teamSubmissionRejectButton", payload),
});

export const DispatchWorkflows = [
  DispatchAutoCheckinTestWorkflow,
  DispatchCheckinWorkflow,
  DispatchRoomOrderWorkflow,
  DispatchKickoutWorkflow,
  DispatchSlotButtonWorkflow,
  DispatchSlotListWorkflow,
  DispatchSlotOpenButtonWorkflow,
  DispatchServiceStatusWorkflow,
  DispatchPreferenceDmStatusWorkflow,
  DispatchPreferenceDmEnableWorkflow,
  DispatchPreferenceDmDisableWorkflow,
  DispatchPreferenceDmSetClientWorkflow,
  DispatchWorkspaceWelcomeWorkflow,
  DispatchUpdateAnnouncementWorkflow,
  DispatchServiceAddWorkspaceFeatureFlagWorkflow,
  DispatchServiceRemoveWorkspaceFeatureFlagWorkflow,
  DispatchCheckinButtonWorkflow,
  DispatchRoomOrderPreviousButtonWorkflow,
  DispatchRoomOrderNextButtonWorkflow,
  DispatchRoomOrderSendButtonWorkflow,
  DispatchRoomOrderPinTentativeButtonWorkflow,
  DispatchConversationListConfigWorkflow,
  DispatchConversationSetWorkflow,
  DispatchConversationUnsetWorkflow,
  DispatchWorkspaceListConfigWorkflow,
  DispatchWorkspaceAddMonitorRoleWorkflow,
  DispatchWorkspaceRemoveMonitorRoleWorkflow,
  DispatchWorkspaceSetSheetWorkflow,
  DispatchWorkspaceSetAutoCheckinWorkflow,
  DispatchTeamListWorkflow,
  DispatchTeamSubmissionWorkflow,
  DispatchTeamSubmissionConfirmButtonWorkflow,
  DispatchTeamSubmissionRejectButtonWorkflow,
  DispatchScheduleListWorkflow,
  DispatchScreenshotWorkflow,
] as const;

export type DispatchWorkflowRequestDescriptor = {
  readonly _tag: string;
  readonly payloadSchema?: Schema.Decoder<unknown>;
  readonly successSchema: Schema.Decoder<unknown>;
  readonly errorSchema?: Schema.Decoder<unknown>;
};

export const DispatchWorkflowRequests = new Map<string, DispatchWorkflowRequestDescriptor>(
  DispatchWorkflows.flatMap(
    (workflow): ReadonlyArray<readonly [string, DispatchWorkflowRequestDescriptor]> => [
      [
        workflow.name,
        {
          _tag: workflow.name,
          payloadSchema: workflow.payloadSchema,
          successSchema: workflow.successSchema,
          errorSchema: workflow.errorSchema,
        },
      ] as const,
      [
        `${workflow.name}Discard`,
        {
          _tag: `${workflow.name}Discard`,
          payloadSchema: workflow.payloadSchema,
          successSchema: DispatchWorkflowExecutionId,
        },
      ] as const,
      [
        `${workflow.name}Resume`,
        {
          _tag: `${workflow.name}Resume`,
          payloadSchema: DispatchWorkflowResumePayload,
          successSchema: Schema.Void,
        },
      ] as const,
    ],
  ),
);

export const DispatchWorkflowRpcs = {
  requests: DispatchWorkflowRequests,
};

export const DispatchWorkflowOperations = {
  autoCheckinTest: {
    operation: "autoCheckinTest",
    endpointName: "autoCheckinTest",
    workflow: DispatchAutoCheckinTestWorkflow,
    rpcTag: DispatchAutoCheckinTestWorkflow.name,
    discardRpcTag: `${DispatchAutoCheckinTestWorkflow.name}Discard`,
  },
  checkin: {
    operation: "checkin",
    endpointName: "checkin",
    workflow: DispatchCheckinWorkflow,
    rpcTag: DispatchCheckinWorkflow.name,
    discardRpcTag: `${DispatchCheckinWorkflow.name}Discard`,
  },
  roomOrder: {
    operation: "roomOrder",
    endpointName: "roomOrder",
    workflow: DispatchRoomOrderWorkflow,
    rpcTag: DispatchRoomOrderWorkflow.name,
    discardRpcTag: `${DispatchRoomOrderWorkflow.name}Discard`,
  },
  kickout: {
    operation: "kickout",
    endpointName: "kickout",
    workflow: DispatchKickoutWorkflow,
    rpcTag: DispatchKickoutWorkflow.name,
    discardRpcTag: `${DispatchKickoutWorkflow.name}Discard`,
  },
  slotButton: {
    operation: "slotButton",
    endpointName: "slotButton",
    workflow: DispatchSlotButtonWorkflow,
    rpcTag: DispatchSlotButtonWorkflow.name,
    discardRpcTag: `${DispatchSlotButtonWorkflow.name}Discard`,
  },
  slotList: {
    operation: "slotList",
    endpointName: "slotList",
    workflow: DispatchSlotListWorkflow,
    rpcTag: DispatchSlotListWorkflow.name,
    discardRpcTag: `${DispatchSlotListWorkflow.name}Discard`,
  },
  slotOpenButton: {
    operation: "slotOpenButton",
    endpointName: "slotOpenButton",
    workflow: DispatchSlotOpenButtonWorkflow,
    rpcTag: DispatchSlotOpenButtonWorkflow.name,
    discardRpcTag: `${DispatchSlotOpenButtonWorkflow.name}Discard`,
  },
  serviceStatus: {
    operation: "serviceStatus",
    endpointName: "serviceStatus",
    workflow: DispatchServiceStatusWorkflow,
    rpcTag: DispatchServiceStatusWorkflow.name,
    discardRpcTag: `${DispatchServiceStatusWorkflow.name}Discard`,
  },
  preferenceDmStatus: {
    operation: "preferenceDmStatus",
    endpointName: "preferenceDmStatus",
    workflow: DispatchPreferenceDmStatusWorkflow,
    rpcTag: DispatchPreferenceDmStatusWorkflow.name,
    discardRpcTag: `${DispatchPreferenceDmStatusWorkflow.name}Discard`,
  },
  preferenceDmEnable: {
    operation: "preferenceDmEnable",
    endpointName: "preferenceDmEnable",
    workflow: DispatchPreferenceDmEnableWorkflow,
    rpcTag: DispatchPreferenceDmEnableWorkflow.name,
    discardRpcTag: `${DispatchPreferenceDmEnableWorkflow.name}Discard`,
  },
  preferenceDmDisable: {
    operation: "preferenceDmDisable",
    endpointName: "preferenceDmDisable",
    workflow: DispatchPreferenceDmDisableWorkflow,
    rpcTag: DispatchPreferenceDmDisableWorkflow.name,
    discardRpcTag: `${DispatchPreferenceDmDisableWorkflow.name}Discard`,
  },
  preferenceDmSetClient: {
    operation: "preferenceDmSetClient",
    endpointName: "preferenceDmSetClient",
    workflow: DispatchPreferenceDmSetClientWorkflow,
    rpcTag: DispatchPreferenceDmSetClientWorkflow.name,
    discardRpcTag: `${DispatchPreferenceDmSetClientWorkflow.name}Discard`,
  },
  workspaceWelcome: {
    operation: "workspaceWelcome",
    endpointName: "workspaceWelcome",
    workflow: DispatchWorkspaceWelcomeWorkflow,
    rpcTag: DispatchWorkspaceWelcomeWorkflow.name,
    discardRpcTag: `${DispatchWorkspaceWelcomeWorkflow.name}Discard`,
  },
  updateAnnouncement: {
    operation: "updateAnnouncement",
    endpointName: "updateAnnouncement",
    workflow: DispatchUpdateAnnouncementWorkflow,
    rpcTag: DispatchUpdateAnnouncementWorkflow.name,
    discardRpcTag: `${DispatchUpdateAnnouncementWorkflow.name}Discard`,
  },
  serviceAddWorkspaceFeatureFlag: {
    operation: "serviceAddWorkspaceFeatureFlag",
    endpointName: "serviceAddWorkspaceFeatureFlag",
    workflow: DispatchServiceAddWorkspaceFeatureFlagWorkflow,
    rpcTag: DispatchServiceAddWorkspaceFeatureFlagWorkflow.name,
    discardRpcTag: `${DispatchServiceAddWorkspaceFeatureFlagWorkflow.name}Discard`,
  },
  serviceRemoveWorkspaceFeatureFlag: {
    operation: "serviceRemoveWorkspaceFeatureFlag",
    endpointName: "serviceRemoveWorkspaceFeatureFlag",
    workflow: DispatchServiceRemoveWorkspaceFeatureFlagWorkflow,
    rpcTag: DispatchServiceRemoveWorkspaceFeatureFlagWorkflow.name,
    discardRpcTag: `${DispatchServiceRemoveWorkspaceFeatureFlagWorkflow.name}Discard`,
  },
  checkinButton: {
    operation: "checkinButton",
    endpointName: "checkinButton",
    workflow: DispatchCheckinButtonWorkflow,
    rpcTag: DispatchCheckinButtonWorkflow.name,
    discardRpcTag: `${DispatchCheckinButtonWorkflow.name}Discard`,
  },
  roomOrderPreviousButton: {
    operation: "roomOrderPreviousButton",
    endpointName: DispatchRoomOrderButtonMethods.previous.endpointName,
    workflow: DispatchRoomOrderPreviousButtonWorkflow,
    rpcTag: DispatchRoomOrderPreviousButtonWorkflow.name,
    discardRpcTag: `${DispatchRoomOrderPreviousButtonWorkflow.name}Discard`,
  },
  roomOrderNextButton: {
    operation: "roomOrderNextButton",
    endpointName: DispatchRoomOrderButtonMethods.next.endpointName,
    workflow: DispatchRoomOrderNextButtonWorkflow,
    rpcTag: DispatchRoomOrderNextButtonWorkflow.name,
    discardRpcTag: `${DispatchRoomOrderNextButtonWorkflow.name}Discard`,
  },
  roomOrderSendButton: {
    operation: "roomOrderSendButton",
    endpointName: DispatchRoomOrderButtonMethods.send.endpointName,
    workflow: DispatchRoomOrderSendButtonWorkflow,
    rpcTag: DispatchRoomOrderSendButtonWorkflow.name,
    discardRpcTag: `${DispatchRoomOrderSendButtonWorkflow.name}Discard`,
  },
  roomOrderPinTentativeButton: {
    operation: "roomOrderPinTentativeButton",
    endpointName: DispatchRoomOrderButtonMethods.pinTentative.endpointName,
    workflow: DispatchRoomOrderPinTentativeButtonWorkflow,
    rpcTag: DispatchRoomOrderPinTentativeButtonWorkflow.name,
    discardRpcTag: `${DispatchRoomOrderPinTentativeButtonWorkflow.name}Discard`,
  },
  conversationListConfig: {
    operation: "conversationListConfig",
    endpointName: "conversationListConfig",
    workflow: DispatchConversationListConfigWorkflow,
    rpcTag: DispatchConversationListConfigWorkflow.name,
    discardRpcTag: `${DispatchConversationListConfigWorkflow.name}Discard`,
  },
  conversationSet: {
    operation: "conversationSet",
    endpointName: "conversationSet",
    workflow: DispatchConversationSetWorkflow,
    rpcTag: DispatchConversationSetWorkflow.name,
    discardRpcTag: `${DispatchConversationSetWorkflow.name}Discard`,
  },
  conversationUnset: {
    operation: "conversationUnset",
    endpointName: "conversationUnset",
    workflow: DispatchConversationUnsetWorkflow,
    rpcTag: DispatchConversationUnsetWorkflow.name,
    discardRpcTag: `${DispatchConversationUnsetWorkflow.name}Discard`,
  },
  workspaceListConfig: {
    operation: "workspaceListConfig",
    endpointName: "workspaceListConfig",
    workflow: DispatchWorkspaceListConfigWorkflow,
    rpcTag: DispatchWorkspaceListConfigWorkflow.name,
    discardRpcTag: `${DispatchWorkspaceListConfigWorkflow.name}Discard`,
  },
  workspaceAddMonitorRole: {
    operation: "workspaceAddMonitorRole",
    endpointName: "workspaceAddMonitorRole",
    workflow: DispatchWorkspaceAddMonitorRoleWorkflow,
    rpcTag: DispatchWorkspaceAddMonitorRoleWorkflow.name,
    discardRpcTag: `${DispatchWorkspaceAddMonitorRoleWorkflow.name}Discard`,
  },
  workspaceRemoveMonitorRole: {
    operation: "workspaceRemoveMonitorRole",
    endpointName: "workspaceRemoveMonitorRole",
    workflow: DispatchWorkspaceRemoveMonitorRoleWorkflow,
    rpcTag: DispatchWorkspaceRemoveMonitorRoleWorkflow.name,
    discardRpcTag: `${DispatchWorkspaceRemoveMonitorRoleWorkflow.name}Discard`,
  },
  workspaceSetSheet: {
    operation: "workspaceSetSheet",
    endpointName: "workspaceSetSheet",
    workflow: DispatchWorkspaceSetSheetWorkflow,
    rpcTag: DispatchWorkspaceSetSheetWorkflow.name,
    discardRpcTag: `${DispatchWorkspaceSetSheetWorkflow.name}Discard`,
  },
  workspaceSetAutoCheckin: {
    operation: "workspaceSetAutoCheckin",
    endpointName: "workspaceSetAutoCheckin",
    workflow: DispatchWorkspaceSetAutoCheckinWorkflow,
    rpcTag: DispatchWorkspaceSetAutoCheckinWorkflow.name,
    discardRpcTag: `${DispatchWorkspaceSetAutoCheckinWorkflow.name}Discard`,
  },
  teamList: {
    operation: "teamList",
    endpointName: "teamList",
    workflow: DispatchTeamListWorkflow,
    rpcTag: DispatchTeamListWorkflow.name,
    discardRpcTag: `${DispatchTeamListWorkflow.name}Discard`,
  },
  teamSubmission: {
    operation: "teamSubmission",
    endpointName: "teamSubmission",
    workflow: DispatchTeamSubmissionWorkflow,
    rpcTag: DispatchTeamSubmissionWorkflow.name,
    discardRpcTag: `${DispatchTeamSubmissionWorkflow.name}Discard`,
  },
  teamSubmissionConfirmButton: {
    operation: "teamSubmissionConfirmButton",
    endpointName: DispatchTeamSubmissionButtonMethods.confirm.endpointName,
    workflow: DispatchTeamSubmissionConfirmButtonWorkflow,
    rpcTag: DispatchTeamSubmissionConfirmButtonWorkflow.name,
    discardRpcTag: `${DispatchTeamSubmissionConfirmButtonWorkflow.name}Discard`,
  },
  teamSubmissionRejectButton: {
    operation: "teamSubmissionRejectButton",
    endpointName: DispatchTeamSubmissionButtonMethods.reject.endpointName,
    workflow: DispatchTeamSubmissionRejectButtonWorkflow,
    rpcTag: DispatchTeamSubmissionRejectButtonWorkflow.name,
    discardRpcTag: `${DispatchTeamSubmissionRejectButtonWorkflow.name}Discard`,
  },
  scheduleList: {
    operation: "scheduleList",
    endpointName: "scheduleList",
    workflow: DispatchScheduleListWorkflow,
    rpcTag: DispatchScheduleListWorkflow.name,
    discardRpcTag: `${DispatchScheduleListWorkflow.name}Discard`,
  },
  screenshot: {
    operation: "screenshot",
    endpointName: "screenshot",
    workflow: DispatchScreenshotWorkflow,
    rpcTag: DispatchScreenshotWorkflow.name,
    discardRpcTag: `${DispatchScreenshotWorkflow.name}Discard`,
  },
} as const;

export type DispatchWorkflowOperation =
  (typeof DispatchWorkflowOperations)[keyof typeof DispatchWorkflowOperations]["operation"];
