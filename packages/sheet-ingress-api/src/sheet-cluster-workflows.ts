import { Schema } from "effect";
import { Workflow, WorkflowProxy } from "effect/unstable/workflow";
import { SheetApisRpcAuthorization } from "./middlewares/sheetApisRpcAuthorization/tag";
import { MessageRoomOrder } from "./schemas/messageRoomOrder";
import {
  CheckinDispatchError,
  CheckinDispatchPayload,
  CheckinDispatchResult,
  CheckinHandleButtonError,
  CheckinHandleButtonPayload,
  CheckinHandleButtonResult,
  DispatchAcceptedResult,
  DispatchRoomOrderButtonMethods,
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
} from "./handlers/dispatch/schema";

export const DispatchRequesterSchema = Schema.Struct({
  accountId: Schema.String,
  userId: Schema.String,
});

export type DispatchRequester = Schema.Schema.Type<typeof DispatchRequesterSchema>;

/** Public execution-id schema returned by workflow discard dispatch RPCs. */
export const DispatchWorkflowExecutionId = Schema.String;
/** Public accepted-result alias for sheet-cluster workflow dispatch APIs. */
export const DispatchWorkflowAcceptedResult = DispatchAcceptedResult;

const dispatchPayload = <Payload extends Schema.Top>(payload: Payload) =>
  Schema.Struct({
    requester: DispatchRequesterSchema,
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
  checkinButton: "dispatch.checkinButton",
  roomOrderPreviousButton: "dispatch.roomOrderPreviousButton",
  roomOrderNextButton: "dispatch.roomOrderNextButton",
  roomOrderSendButton: "dispatch.roomOrderSendButton",
  roomOrderPinTentativeButton: "dispatch.roomOrderPinTentativeButton",
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

export const DispatchWorkflows = [
  DispatchCheckinWorkflow,
  DispatchRoomOrderWorkflow,
  DispatchCheckinButtonWorkflow,
  DispatchRoomOrderPreviousButtonWorkflow,
  DispatchRoomOrderNextButtonWorkflow,
  DispatchRoomOrderSendButtonWorkflow,
  DispatchRoomOrderPinTentativeButtonWorkflow,
] as const;

export const DispatchWorkflowRpcs =
  WorkflowProxy.toRpcGroup(DispatchWorkflows).middleware(SheetApisRpcAuthorization);

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
} as const;

export type DispatchWorkflowOperation =
  (typeof DispatchWorkflowOperations)[keyof typeof DispatchWorkflowOperations]["operation"];
