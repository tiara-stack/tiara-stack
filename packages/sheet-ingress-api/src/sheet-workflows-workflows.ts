import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { Workflow, WorkflowProxy } from "effect/unstable/workflow";
import { UnknownError } from "typhoon-core/error";
import { SheetApisRpcAuthorization } from "./middlewares/sheetApisRpcAuthorization/tag";
import { MessageRoomOrder } from "./schemas/messageRoomOrder";
import {
  CheckinDispatchError,
  CheckinDispatchPayload,
  CheckinDispatchResult,
  CheckinHandleButtonError,
  CheckinHandleButtonPayload,
  CheckinHandleButtonResult,
  BotCommandDispatchError,
  ChannelListConfigDispatchPayload,
  ChannelListConfigDispatchResult,
  ChannelSetDispatchPayload,
  ChannelSetDispatchResult,
  ChannelUnsetDispatchPayload,
  ChannelUnsetDispatchResult,
  DispatchAcceptedResult,
  DispatchRoomOrderButtonMethods,
  GuildWelcomeDispatchError,
  GuildWelcomeDispatchPayload,
  GuildWelcomeDispatchResult,
  KickoutDispatchError,
  KickoutDispatchPayload,
  KickoutDispatchResult,
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
  ServiceStatusDispatchPayload,
  ServiceStatusDispatchResult,
  ServerAddMonitorRoleDispatchPayload,
  ServerAddMonitorRoleDispatchResult,
  ServerListConfigDispatchPayload,
  ServerListConfigDispatchResult,
  ServerRemoveMonitorRoleDispatchPayload,
  ServerRemoveMonitorRoleDispatchResult,
  ServerSetAutoCheckinDispatchPayload,
  ServerSetAutoCheckinDispatchResult,
  ServerSetSheetDispatchPayload,
  ServerSetSheetDispatchResult,
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
} from "./handlers/dispatch/schema";

export const DispatchRequesterSchema = Schema.Struct({
  accountId: Schema.String,
  userId: Schema.String,
});

export type DispatchRequester = Schema.Schema.Type<typeof DispatchRequesterSchema>;

export const DispatchAuthorizationSnapshotSchema = Schema.Struct({
  guildId: Schema.String,
  scope: Schema.Literals(["member", "monitor", "manage"]),
});

export type DispatchAuthorizationSnapshot = Schema.Schema.Type<
  typeof DispatchAuthorizationSnapshotSchema
>;

/** Public execution-id schema returned by workflow discard dispatch RPCs. */
export const DispatchWorkflowExecutionId = Schema.String;
/** Public accepted-result alias for sheet-workflows workflow dispatch APIs. */
export const DispatchWorkflowAcceptedResult = DispatchAcceptedResult;

const dispatchPayload = <Payload extends Schema.Top>(payload: Payload) =>
  Schema.Struct({
    requester: DispatchRequesterSchema,
    authorization: Schema.optional(DispatchAuthorizationSnapshotSchema),
    interactionDeadlineEpochMs: Schema.optional(Schema.Number),
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
    interactionDeadlineEpochMs: Schema.optional(Schema.Number),
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
  interactionDeadlineEpochMs: Schema.optional(Schema.Number),
  payload: RoomOrderPinTentativeButtonPayload,
  authorizedRoomOrder: Schema.optional(Schema.NullOr(MessageRoomOrder)),
});

const workflowName = {
  checkin: "dispatch.checkin",
  roomOrder: "dispatch.roomOrder",
  kickout: "dispatch.kickout",
  slotButton: "dispatch.slotButton",
  slotList: "dispatch.slotList",
  slotOpenButton: "dispatch.slotOpenButton",
  serviceStatus: "dispatch.serviceStatus",
  guildWelcome: "dispatch.guildWelcome",
  checkinButton: "dispatch.checkinButton",
  roomOrderPreviousButton: "dispatch.roomOrderPreviousButton",
  roomOrderNextButton: "dispatch.roomOrderNextButton",
  roomOrderSendButton: "dispatch.roomOrderSendButton",
  roomOrderPinTentativeButton: "dispatch.roomOrderPinTentativeButton",
  channelListConfig: "dispatch.channelListConfig",
  channelSet: "dispatch.channelSet",
  channelUnset: "dispatch.channelUnset",
  serverListConfig: "dispatch.serverListConfig",
  serverAddMonitorRole: "dispatch.serverAddMonitorRole",
  serverRemoveMonitorRole: "dispatch.serverRemoveMonitorRole",
  serverSetSheet: "dispatch.serverSetSheet",
  serverSetAutoCheckin: "dispatch.serverSetAutoCheckin",
  teamList: "dispatch.teamList",
  scheduleList: "dispatch.scheduleList",
  screenshot: "dispatch.screenshot",
} as const;

export const DispatchCheckinWorkflow = Workflow.make({
  name: workflowName.checkin,
  payload: dispatchPayload(CheckinDispatchPayload),
  success: CheckinDispatchResult,
  error: CheckinDispatchError,
  idempotencyKey: ({ payload }) => payload.dispatchRequestId,
});

export const DispatchRoomOrderWorkflow = Workflow.make({
  name: workflowName.roomOrder,
  payload: dispatchPayload(RoomOrderDispatchPayload),
  success: RoomOrderDispatchResult,
  error: RoomOrderDispatchError,
  idempotencyKey: ({ payload }) => payload.dispatchRequestId,
});

export const DispatchKickoutWorkflow = Workflow.make({
  name: workflowName.kickout,
  payload: dispatchPayload(KickoutDispatchPayload),
  success: KickoutDispatchResult,
  error: KickoutDispatchError,
  idempotencyKey: ({ payload }) => payload.dispatchRequestId,
});

export const DispatchSlotButtonWorkflow = Workflow.make({
  name: workflowName.slotButton,
  payload: dispatchPayload(SlotButtonDispatchPayload),
  success: SlotButtonDispatchResult,
  error: SlotDispatchError,
  idempotencyKey: ({ payload }) => payload.dispatchRequestId,
});

export const DispatchSlotListWorkflow = Workflow.make({
  name: workflowName.slotList,
  payload: dispatchPayload(SlotListDispatchPayload),
  success: SlotListDispatchResult,
  error: SlotDispatchError,
  idempotencyKey: ({ payload }) => payload.dispatchRequestId,
});

export const DispatchSlotOpenButtonWorkflow = Workflow.make({
  name: workflowName.slotOpenButton,
  payload: dispatchPayload(SlotOpenButtonPayload),
  success: SlotOpenButtonResult,
  error: SlotDispatchError,
  idempotencyKey: ({ payload }) =>
    `button:slotOpenButton:${payload.messageId}:${payload.interactionToken}`,
});

export const DispatchServiceStatusWorkflow = Workflow.make({
  name: workflowName.serviceStatus,
  payload: dispatchPayload(ServiceStatusDispatchPayload),
  success: ServiceStatusDispatchResult,
  error: UnknownError,
  idempotencyKey: ({ payload }) => payload.dispatchRequestId,
});

export const DispatchGuildWelcomeWorkflow = Workflow.make({
  name: workflowName.guildWelcome,
  payload: dispatchPayload(GuildWelcomeDispatchPayload),
  success: GuildWelcomeDispatchResult,
  error: GuildWelcomeDispatchError,
  idempotencyKey: ({ payload }) => payload.dispatchRequestId,
});

export const DispatchCheckinButtonWorkflow = Workflow.make({
  name: workflowName.checkinButton,
  payload: dispatchPayload(CheckinHandleButtonPayload),
  success: CheckinHandleButtonResult,
  error: CheckinHandleButtonError,
  idempotencyKey: ({ payload }) =>
    `button:checkinButton:${payload.messageId}:${payload.interactionToken}`,
});

export const DispatchRoomOrderPreviousButtonWorkflow = Workflow.make({
  name: workflowName.roomOrderPreviousButton,
  payload: roomOrderButtonPayload(RoomOrderPreviousButtonPayload),
  success: RoomOrderPreviousButtonResult,
  error: RoomOrderHandleButtonError,
  idempotencyKey: ({ payload }) =>
    `button:roomOrderPreviousButton:${payload.messageId}:${payload.interactionToken}`,
});

export const DispatchRoomOrderNextButtonWorkflow = Workflow.make({
  name: workflowName.roomOrderNextButton,
  payload: roomOrderButtonPayload(RoomOrderNextButtonPayload),
  success: RoomOrderNextButtonResult,
  error: RoomOrderHandleButtonError,
  idempotencyKey: ({ payload }) =>
    `button:roomOrderNextButton:${payload.messageId}:${payload.interactionToken}`,
});

export const DispatchRoomOrderSendButtonWorkflow = Workflow.make({
  name: workflowName.roomOrderSendButton,
  payload: roomOrderButtonPayload(RoomOrderSendButtonPayload),
  success: RoomOrderSendButtonResult,
  error: RoomOrderHandleButtonError,
  idempotencyKey: ({ payload }) =>
    `button:roomOrderSendButton:${payload.messageId}:${payload.interactionToken}`,
});

export const DispatchRoomOrderPinTentativeButtonWorkflow = Workflow.make({
  name: workflowName.roomOrderPinTentativeButton,
  payload: roomOrderPinTentativePayload,
  success: RoomOrderPinTentativeButtonResult,
  error: RoomOrderHandleButtonError,
  idempotencyKey: ({ payload }) =>
    `button:roomOrderPinTentativeButton:${payload.messageId}:${payload.interactionToken}`,
});

export const DispatchChannelListConfigWorkflow = Workflow.make({
  name: workflowName.channelListConfig,
  payload: dispatchPayload(ChannelListConfigDispatchPayload),
  success: ChannelListConfigDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => payload.dispatchRequestId,
});

export const DispatchChannelSetWorkflow = Workflow.make({
  name: workflowName.channelSet,
  payload: dispatchPayload(ChannelSetDispatchPayload),
  success: ChannelSetDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => payload.dispatchRequestId,
});

export const DispatchChannelUnsetWorkflow = Workflow.make({
  name: workflowName.channelUnset,
  payload: dispatchPayload(ChannelUnsetDispatchPayload),
  success: ChannelUnsetDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => payload.dispatchRequestId,
});

export const DispatchServerListConfigWorkflow = Workflow.make({
  name: workflowName.serverListConfig,
  payload: dispatchPayload(ServerListConfigDispatchPayload),
  success: ServerListConfigDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => payload.dispatchRequestId,
});

export const DispatchServerAddMonitorRoleWorkflow = Workflow.make({
  name: workflowName.serverAddMonitorRole,
  payload: dispatchPayload(ServerAddMonitorRoleDispatchPayload),
  success: ServerAddMonitorRoleDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => payload.dispatchRequestId,
});

export const DispatchServerRemoveMonitorRoleWorkflow = Workflow.make({
  name: workflowName.serverRemoveMonitorRole,
  payload: dispatchPayload(ServerRemoveMonitorRoleDispatchPayload),
  success: ServerRemoveMonitorRoleDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => payload.dispatchRequestId,
});

export const DispatchServerSetSheetWorkflow = Workflow.make({
  name: workflowName.serverSetSheet,
  payload: dispatchPayload(ServerSetSheetDispatchPayload),
  success: ServerSetSheetDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => payload.dispatchRequestId,
});

export const DispatchServerSetAutoCheckinWorkflow = Workflow.make({
  name: workflowName.serverSetAutoCheckin,
  payload: dispatchPayload(ServerSetAutoCheckinDispatchPayload),
  success: ServerSetAutoCheckinDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => payload.dispatchRequestId,
});

export const DispatchTeamListWorkflow = Workflow.make({
  name: workflowName.teamList,
  payload: dispatchPayload(TeamListDispatchPayload),
  success: TeamListDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => payload.dispatchRequestId,
});

export const DispatchScheduleListWorkflow = Workflow.make({
  name: workflowName.scheduleList,
  payload: dispatchPayload(ScheduleListDispatchPayload),
  success: ScheduleListDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => payload.dispatchRequestId,
});

export const DispatchScreenshotWorkflow = Workflow.make({
  name: workflowName.screenshot,
  payload: dispatchPayload(ScreenshotDispatchPayload),
  success: ScreenshotDispatchResult,
  error: BotCommandDispatchError,
  idempotencyKey: ({ payload }) => payload.dispatchRequestId,
});

export const DispatchWorkflows = [
  DispatchCheckinWorkflow,
  DispatchRoomOrderWorkflow,
  DispatchKickoutWorkflow,
  DispatchSlotButtonWorkflow,
  DispatchSlotListWorkflow,
  DispatchSlotOpenButtonWorkflow,
  DispatchServiceStatusWorkflow,
  DispatchGuildWelcomeWorkflow,
  DispatchCheckinButtonWorkflow,
  DispatchRoomOrderPreviousButtonWorkflow,
  DispatchRoomOrderNextButtonWorkflow,
  DispatchRoomOrderSendButtonWorkflow,
  DispatchRoomOrderPinTentativeButtonWorkflow,
  DispatchChannelListConfigWorkflow,
  DispatchChannelSetWorkflow,
  DispatchChannelUnsetWorkflow,
  DispatchServerListConfigWorkflow,
  DispatchServerAddMonitorRoleWorkflow,
  DispatchServerRemoveMonitorRoleWorkflow,
  DispatchServerSetSheetWorkflow,
  DispatchServerSetAutoCheckinWorkflow,
  DispatchTeamListWorkflow,
  DispatchScheduleListWorkflow,
  DispatchScreenshotWorkflow,
] as const;

const makeDispatchWorkflowRpcs = (workflows: typeof DispatchWorkflows) =>
  WorkflowProxy.toRpcGroup(workflows).add(
    ...workflows.map((workflow) =>
      Rpc.make(`${workflow.name}Discard`, {
        payload: workflow.payloadSchema,
        success: DispatchWorkflowExecutionId,
      }).annotateMerge(workflow.annotations),
    ),
  );

export const DispatchWorkflowRpcs =
  makeDispatchWorkflowRpcs(DispatchWorkflows).middleware(SheetApisRpcAuthorization);

export const DispatchWorkflowOperations = {
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
  guildWelcome: {
    operation: "guildWelcome",
    endpointName: "guildWelcome",
    workflow: DispatchGuildWelcomeWorkflow,
    rpcTag: DispatchGuildWelcomeWorkflow.name,
    discardRpcTag: `${DispatchGuildWelcomeWorkflow.name}Discard`,
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
  channelListConfig: {
    operation: "channelListConfig",
    endpointName: "channelListConfig",
    workflow: DispatchChannelListConfigWorkflow,
    rpcTag: DispatchChannelListConfigWorkflow.name,
    discardRpcTag: `${DispatchChannelListConfigWorkflow.name}Discard`,
  },
  channelSet: {
    operation: "channelSet",
    endpointName: "channelSet",
    workflow: DispatchChannelSetWorkflow,
    rpcTag: DispatchChannelSetWorkflow.name,
    discardRpcTag: `${DispatchChannelSetWorkflow.name}Discard`,
  },
  channelUnset: {
    operation: "channelUnset",
    endpointName: "channelUnset",
    workflow: DispatchChannelUnsetWorkflow,
    rpcTag: DispatchChannelUnsetWorkflow.name,
    discardRpcTag: `${DispatchChannelUnsetWorkflow.name}Discard`,
  },
  serverListConfig: {
    operation: "serverListConfig",
    endpointName: "serverListConfig",
    workflow: DispatchServerListConfigWorkflow,
    rpcTag: DispatchServerListConfigWorkflow.name,
    discardRpcTag: `${DispatchServerListConfigWorkflow.name}Discard`,
  },
  serverAddMonitorRole: {
    operation: "serverAddMonitorRole",
    endpointName: "serverAddMonitorRole",
    workflow: DispatchServerAddMonitorRoleWorkflow,
    rpcTag: DispatchServerAddMonitorRoleWorkflow.name,
    discardRpcTag: `${DispatchServerAddMonitorRoleWorkflow.name}Discard`,
  },
  serverRemoveMonitorRole: {
    operation: "serverRemoveMonitorRole",
    endpointName: "serverRemoveMonitorRole",
    workflow: DispatchServerRemoveMonitorRoleWorkflow,
    rpcTag: DispatchServerRemoveMonitorRoleWorkflow.name,
    discardRpcTag: `${DispatchServerRemoveMonitorRoleWorkflow.name}Discard`,
  },
  serverSetSheet: {
    operation: "serverSetSheet",
    endpointName: "serverSetSheet",
    workflow: DispatchServerSetSheetWorkflow,
    rpcTag: DispatchServerSetSheetWorkflow.name,
    discardRpcTag: `${DispatchServerSetSheetWorkflow.name}Discard`,
  },
  serverSetAutoCheckin: {
    operation: "serverSetAutoCheckin",
    endpointName: "serverSetAutoCheckin",
    workflow: DispatchServerSetAutoCheckinWorkflow,
    rpcTag: DispatchServerSetAutoCheckinWorkflow.name,
    discardRpcTag: `${DispatchServerSetAutoCheckinWorkflow.name}Discard`,
  },
  teamList: {
    operation: "teamList",
    endpointName: "teamList",
    workflow: DispatchTeamListWorkflow,
    rpcTag: DispatchTeamListWorkflow.name,
    discardRpcTag: `${DispatchTeamListWorkflow.name}Discard`,
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
