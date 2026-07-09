import { type Effect, Layer, Schema } from "effect";
import { ClusterSchema, Entity } from "effect/unstable/cluster";
import { Rpc } from "effect/unstable/rpc";
import {
  DispatchCheckinButtonWorkflow,
  DispatchRoomOrderNextButtonWorkflow,
  DispatchRoomOrderPinTentativeButtonWorkflow,
  DispatchRoomOrderPreviousButtonWorkflow,
  DispatchRoomOrderSendButtonWorkflow,
  DispatchSlotOpenButtonWorkflow,
  DispatchTeamSubmissionConfirmButtonWorkflow,
  DispatchTeamSubmissionRejectButtonWorkflow,
} from "@/workflows/dispatchWorkflows";

const dispatchShardGroup = () => "dispatch";

const dispatchButtonPayload = <Request extends Schema.Top>(request: Request) =>
  Schema.Struct({
    request,
    executionId: Schema.String,
  });

export const DispatchButtonEntity = Entity.make("DispatchButton", [
  Rpc.make("slotOpenButton", {
    payload: dispatchButtonPayload(DispatchSlotOpenButtonWorkflow.payloadSchema),
    success: DispatchSlotOpenButtonWorkflow.successSchema,
    error: DispatchSlotOpenButtonWorkflow.errorSchema,
  }),
  Rpc.make("checkinButton", {
    payload: dispatchButtonPayload(DispatchCheckinButtonWorkflow.payloadSchema),
    success: DispatchCheckinButtonWorkflow.successSchema,
    error: DispatchCheckinButtonWorkflow.errorSchema,
  }),
  Rpc.make("roomOrderPreviousButton", {
    payload: dispatchButtonPayload(DispatchRoomOrderPreviousButtonWorkflow.payloadSchema),
    success: DispatchRoomOrderPreviousButtonWorkflow.successSchema,
    error: DispatchRoomOrderPreviousButtonWorkflow.errorSchema,
  }),
  Rpc.make("roomOrderNextButton", {
    payload: dispatchButtonPayload(DispatchRoomOrderNextButtonWorkflow.payloadSchema),
    success: DispatchRoomOrderNextButtonWorkflow.successSchema,
    error: DispatchRoomOrderNextButtonWorkflow.errorSchema,
  }),
  Rpc.make("roomOrderSendButton", {
    payload: dispatchButtonPayload(DispatchRoomOrderSendButtonWorkflow.payloadSchema),
    success: DispatchRoomOrderSendButtonWorkflow.successSchema,
    error: DispatchRoomOrderSendButtonWorkflow.errorSchema,
  }),
  Rpc.make("roomOrderPinTentativeButton", {
    payload: dispatchButtonPayload(DispatchRoomOrderPinTentativeButtonWorkflow.payloadSchema),
    success: DispatchRoomOrderPinTentativeButtonWorkflow.successSchema,
    error: DispatchRoomOrderPinTentativeButtonWorkflow.errorSchema,
  }),
  Rpc.make("teamSubmissionConfirmButton", {
    payload: dispatchButtonPayload(DispatchTeamSubmissionConfirmButtonWorkflow.payloadSchema),
    success: DispatchTeamSubmissionConfirmButtonWorkflow.successSchema,
    error: DispatchTeamSubmissionConfirmButtonWorkflow.errorSchema,
  }),
  Rpc.make("teamSubmissionRejectButton", {
    payload: dispatchButtonPayload(DispatchTeamSubmissionRejectButtonWorkflow.payloadSchema),
    success: DispatchTeamSubmissionRejectButtonWorkflow.successSchema,
    error: DispatchTeamSubmissionRejectButtonWorkflow.errorSchema,
  }),
]).annotate(ClusterSchema.ShardGroup, dispatchShardGroup);

const dispatchButtonOperations = [
  "slotOpenButton",
  "checkinButton",
  "roomOrderPreviousButton",
  "roomOrderNextButton",
  "roomOrderSendButton",
  "roomOrderPinTentativeButton",
  "teamSubmissionConfirmButton",
  "teamSubmissionRejectButton",
] as const;

export type DispatchButtonOperation = (typeof dispatchButtonOperations)[number];

type DispatchButtonRequest<TWorkflow extends { readonly payloadSchema: Schema.Top }> = {
  readonly payload: {
    readonly request: TWorkflow["payloadSchema"]["Type"];
    readonly executionId: string;
  };
};

export type DispatchButtonEntityHandlers<R = never> = {
  readonly slotOpenButton: (
    request: DispatchButtonRequest<typeof DispatchSlotOpenButtonWorkflow>,
  ) => Effect.Effect<
    typeof DispatchSlotOpenButtonWorkflow.successSchema.Type,
    typeof DispatchSlotOpenButtonWorkflow.errorSchema.Type,
    R
  >;
  readonly checkinButton: (
    request: DispatchButtonRequest<typeof DispatchCheckinButtonWorkflow>,
  ) => Effect.Effect<
    typeof DispatchCheckinButtonWorkflow.successSchema.Type,
    typeof DispatchCheckinButtonWorkflow.errorSchema.Type,
    R
  >;
  readonly roomOrderPreviousButton: (
    request: DispatchButtonRequest<typeof DispatchRoomOrderPreviousButtonWorkflow>,
  ) => Effect.Effect<
    typeof DispatchRoomOrderPreviousButtonWorkflow.successSchema.Type,
    typeof DispatchRoomOrderPreviousButtonWorkflow.errorSchema.Type,
    R
  >;
  readonly roomOrderNextButton: (
    request: DispatchButtonRequest<typeof DispatchRoomOrderNextButtonWorkflow>,
  ) => Effect.Effect<
    typeof DispatchRoomOrderNextButtonWorkflow.successSchema.Type,
    typeof DispatchRoomOrderNextButtonWorkflow.errorSchema.Type,
    R
  >;
  readonly roomOrderSendButton: (
    request: DispatchButtonRequest<typeof DispatchRoomOrderSendButtonWorkflow>,
  ) => Effect.Effect<
    typeof DispatchRoomOrderSendButtonWorkflow.successSchema.Type,
    typeof DispatchRoomOrderSendButtonWorkflow.errorSchema.Type,
    R
  >;
  readonly roomOrderPinTentativeButton: (
    request: DispatchButtonRequest<typeof DispatchRoomOrderPinTentativeButtonWorkflow>,
  ) => Effect.Effect<
    typeof DispatchRoomOrderPinTentativeButtonWorkflow.successSchema.Type,
    typeof DispatchRoomOrderPinTentativeButtonWorkflow.errorSchema.Type,
    R
  >;
  readonly teamSubmissionConfirmButton: (
    request: DispatchButtonRequest<typeof DispatchTeamSubmissionConfirmButtonWorkflow>,
  ) => Effect.Effect<
    typeof DispatchTeamSubmissionConfirmButtonWorkflow.successSchema.Type,
    typeof DispatchTeamSubmissionConfirmButtonWorkflow.errorSchema.Type,
    R
  >;
  readonly teamSubmissionRejectButton: (
    request: DispatchButtonRequest<typeof DispatchTeamSubmissionRejectButtonWorkflow>,
  ) => Effect.Effect<
    typeof DispatchTeamSubmissionRejectButtonWorkflow.successSchema.Type,
    typeof DispatchTeamSubmissionRejectButtonWorkflow.errorSchema.Type,
    R
  >;
};

export const makeDispatchButtonEntityLayer = <R>(handlers: DispatchButtonEntityHandlers<R>) =>
  DispatchButtonEntity.toLayer(DispatchButtonEntity.of(handlers), {
    maxIdleTime: "5 minutes",
    concurrency: 1,
  }).pipe(Layer.withSpan("sheet-workflows.dispatchButtonEntity"));
