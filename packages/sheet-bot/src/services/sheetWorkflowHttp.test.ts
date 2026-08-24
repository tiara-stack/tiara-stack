import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Schema } from "effect";
import { ResponseReference } from "sheet-bot-api/references";
import { WorkspaceId } from "sheet-workflow-contracts/values";
import { WorkflowInputRejected, WorkflowTransportUnavailable } from "sheet-workflow-http-client";
import {
  enqueueCheckinsOpenWorkflow,
  enqueueConversationsSetLockdownWorkflow,
  enqueueMembersKickWorkflow,
  enqueueRoomOrdersCreateWorkflow,
  enqueueRoomOrdersNavigateWorkflow,
  enqueueRoomOrdersPinTentativeWorkflow,
  enqueueRoomOrdersSendWorkflow,
  enqueueScheduleWorkflow,
  enqueueScreenshotsCaptureAndDeliverWorkflow,
  enqueueStatusWorkflow,
  type CheckinsOpenEnqueue,
  type CheckinsOpenInput,
  type CheckinsOpenReference,
  type ConversationsSetLockdownEnqueue,
  type ConversationsSetLockdownInput,
  type MembersKickEnqueue,
  type MembersKickInput,
  type MembersKickReference,
  type RoomOrdersCreateEnqueue,
  type RoomOrdersCreateInput,
  type RoomOrdersCreateReference,
  type RoomOrdersNavigateEnqueue,
  type RoomOrdersNavigateInput,
  type RoomOrdersNavigateReference,
  type RoomOrdersPinTentativeEnqueue,
  type RoomOrdersPinTentativeInput,
  type RoomOrdersPinTentativeReference,
  type RoomOrdersSendEnqueue,
  type RoomOrdersSendInput,
  type RoomOrdersSendReference,
  type SchedulesDeliverUserScheduleEnqueue,
  type SchedulesDeliverUserScheduleInput,
  type SchedulesDeliverUserScheduleReference,
  type ScreenshotsCaptureAndDeliverEnqueue,
  type ScreenshotsCaptureAndDeliverInput,
  type ScreenshotsCaptureAndDeliverReference,
  type ServicesDeliverStatusEnqueue,
  type ServicesDeliverStatusInput,
  type ServicesDeliverStatusReference,
  type SheetWorkflowHttpClientShape,
} from "./sheetWorkflowHttp";

const input = {
  responseReference: Schema.decodeUnknownSync(ResponseReference)("opaque-response-reference"),
} satisfies ServicesDeliverStatusInput;

const makeRunReference = (
  invocationId: ServicesDeliverStatusReference["invocationId"],
): ServicesDeliverStatusReference => ({
  invocationId,
  contractIdentity: "services.deliverStatus",
  wireVersion: "1",
});

const makeClient = (
  enqueue: ServicesDeliverStatusEnqueue,
): Pick<SheetWorkflowHttpClientShape, "enqueueServicesDeliverStatus"> => ({
  enqueueServicesDeliverStatus: enqueue,
});

const scheduleInput = {
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)("workspace-1"),
  responseReference: Schema.decodeUnknownSync(ResponseReference)("opaque-response-reference"),
  day: 2,
  targetUserId: "target-user-1",
  targetUsername: "target-user",
} satisfies SchedulesDeliverUserScheduleInput;

const makeScheduleRunReference = (
  invocationId: SchedulesDeliverUserScheduleReference["invocationId"],
): SchedulesDeliverUserScheduleReference => ({
  invocationId,
  contractIdentity: "schedules.deliverUserSchedule",
  wireVersion: "1",
});

const makeScheduleClient = (
  enqueue: SchedulesDeliverUserScheduleEnqueue,
): Pick<SheetWorkflowHttpClientShape, "enqueueSchedulesDeliverUserSchedule"> => ({
  enqueueSchedulesDeliverUserSchedule: enqueue,
});

const checkinInput = {
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)("workspace-1"),
  responseReference: Schema.decodeUnknownSync(ResponseReference)("opaque-response-reference"),
  conversationName: "running",
  hour: 12,
  template: "Check in",
} satisfies CheckinsOpenInput;

const makeCheckinRunReference = (
  invocationId: CheckinsOpenReference["invocationId"],
): CheckinsOpenReference => ({
  invocationId,
  contractIdentity: "checkins.open",
  wireVersion: "1",
});

const makeCheckinClient = (
  enqueue: CheckinsOpenEnqueue,
): Pick<SheetWorkflowHttpClientShape, "enqueueCheckinsOpen"> => ({
  enqueueCheckinsOpen: enqueue,
});

const lockdownInput = {
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)("workspace-1"),
  responseReference: Schema.decodeUnknownSync(ResponseReference)("opaque-response-reference"),
  conversationId: "conversation-1",
  enabled: true,
} satisfies ConversationsSetLockdownInput;

const makeLockdownClient = (
  enqueue: ConversationsSetLockdownEnqueue,
): Pick<SheetWorkflowHttpClientShape, "enqueueConversationsSetLockdown"> => ({
  enqueueConversationsSetLockdown: enqueue,
});

const makeRoomOrderCreateClient = (
  enqueue: RoomOrdersCreateEnqueue,
): Pick<SheetWorkflowHttpClientShape, "enqueueRoomOrdersCreate"> => ({
  enqueueRoomOrdersCreate: enqueue,
});

const makeRoomOrderNavigateClient = (
  enqueue: RoomOrdersNavigateEnqueue,
): Pick<SheetWorkflowHttpClientShape, "enqueueRoomOrdersNavigate"> => ({
  enqueueRoomOrdersNavigate: enqueue,
});

const makeRoomOrderSendClient = (
  enqueue: RoomOrdersSendEnqueue,
): Pick<SheetWorkflowHttpClientShape, "enqueueRoomOrdersSend"> => ({
  enqueueRoomOrdersSend: enqueue,
});

const makeRoomOrderPinTentativeClient = (
  enqueue: RoomOrdersPinTentativeEnqueue,
): Pick<SheetWorkflowHttpClientShape, "enqueueRoomOrdersPinTentative"> => ({
  enqueueRoomOrdersPinTentative: enqueue,
});

const makeMembersKickClient = (
  enqueue: MembersKickEnqueue,
): Pick<SheetWorkflowHttpClientShape, "enqueueMembersKick"> => ({
  enqueueMembersKick: enqueue,
});

const makeScreenshotClient = (
  enqueue: ScreenshotsCaptureAndDeliverEnqueue,
): Pick<SheetWorkflowHttpClientShape, "enqueueScreenshotsCaptureAndDeliver"> => ({
  enqueueScreenshotsCaptureAndDeliver: enqueue,
});

const roomOrderCreateInput = {
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)("workspace-1"),
  responseReference: input.responseReference,
  conversationName: "running",
  hour: 12,
  healNeeded: 1,
} satisfies RoomOrdersCreateInput;

const roomOrderMessageInput = {
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)("workspace-1"),
  responseReference: input.responseReference,
  messageId: "room-order-message-1",
  messageConversationId: "running-channel-1",
  messageContent: "Room order",
} satisfies RoomOrdersSendInput;

const roomOrderNavigateInput = {
  ...roomOrderMessageInput,
  direction: "previous" as const,
} satisfies RoomOrdersNavigateInput;

const roomOrderPinTentativeInput = roomOrderMessageInput satisfies RoomOrdersPinTentativeInput;

const membersKickInput = {
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)("workspace-1"),
  responseReference: input.responseReference,
  conversationName: "running",
  hour: 12,
} satisfies MembersKickInput;

const screenshotInput = {
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)("workspace-1"),
  responseReference: input.responseReference,
  conversationName: "running",
  day: 2,
} satisfies ScreenshotsCaptureAndDeliverInput;

const makeRoomOrderCreateReference = (
  invocationId: RoomOrdersCreateReference["invocationId"],
): RoomOrdersCreateReference => ({
  invocationId,
  contractIdentity: "roomOrders.create",
  wireVersion: "1",
});

const makeRoomOrderNavigateReference = (
  invocationId: RoomOrdersNavigateReference["invocationId"],
): RoomOrdersNavigateReference => ({
  invocationId,
  contractIdentity: "roomOrders.navigate",
  wireVersion: "1",
});

const makeRoomOrderSendReference = (
  invocationId: RoomOrdersSendReference["invocationId"],
): RoomOrdersSendReference => ({
  invocationId,
  contractIdentity: "roomOrders.send",
  wireVersion: "1",
});

const makeRoomOrderPinTentativeReference = (
  invocationId: RoomOrdersPinTentativeReference["invocationId"],
): RoomOrdersPinTentativeReference => ({
  invocationId,
  contractIdentity: "roomOrders.pinTentative",
  wireVersion: "1",
});

const makeMembersKickReference = (
  invocationId: MembersKickReference["invocationId"],
): MembersKickReference => ({
  invocationId,
  contractIdentity: "members.kick",
  wireVersion: "1",
});

const makeScreenshotReference = (
  invocationId: ScreenshotsCaptureAndDeliverReference["invocationId"],
): ScreenshotsCaptureAndDeliverReference => ({
  invocationId,
  contractIdentity: "screenshots.captureAndDeliver",
  wireVersion: "1",
});

describe("SheetWorkflowHttpClient status enqueue", () => {
  it.live("maps the opaque response reference and reuses invocation identity on retry", () =>
    Effect.gen(function* () {
      const calls: Array<{
        readonly input: ServicesDeliverStatusInput;
        readonly invocationId: ServicesDeliverStatusReference["invocationId"];
      }> = [];
      let attempts = 0;
      const client = makeClient((requestInput, options) => {
        const invocationId = options?.invocationId;
        if (invocationId === undefined) return Effect.die("invocation ID is required");
        calls.push({ input: requestInput, invocationId });
        attempts += 1;
        return attempts === 1
          ? Effect.fail(
              new WorkflowTransportUnavailable({
                operation: "Enqueue",
                retryable: true,
                message: "enqueue response was ambiguous",
              }),
            )
          : Effect.succeed(makeRunReference(invocationId));
      });

      const reference = yield* enqueueStatusWorkflow(client, input);

      expect(calls).toHaveLength(2);
      expect(calls[0]?.input).toEqual(input);
      expect(calls[1]?.input).toEqual(input);
      expect(calls[0]?.invocationId).toBe(calls[1]?.invocationId);
      expect(reference.invocationId).toBe(calls[0]?.invocationId);
    }),
  );

  it.effect("does not retry a definitive workflow input rejection", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client = makeClient(() => {
        attempts += 1;
        return Effect.fail(new WorkflowInputRejected({ message: "workflow input was rejected" }));
      });

      const exit = yield* Effect.exit(enqueueStatusWorkflow(client, input));

      expect(attempts).toBe(1);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) return;
      expect(Cause.squash(exit.cause)).toBeInstanceOf(WorkflowInputRejected);
    }),
  );
});

describe("SheetWorkflowHttpClient schedule enqueue", () => {
  it.live("preserves the schedule payload and reuses invocation identity on retry", () =>
    Effect.gen(function* () {
      const calls: Array<{
        readonly input: SchedulesDeliverUserScheduleInput;
        readonly invocationId: SchedulesDeliverUserScheduleReference["invocationId"];
      }> = [];
      let attempts = 0;
      const client = makeScheduleClient((requestInput, options) => {
        const invocationId = options?.invocationId;
        if (invocationId === undefined) return Effect.die("invocation ID is required");
        calls.push({ input: requestInput, invocationId });
        attempts += 1;
        return attempts === 1
          ? Effect.fail(
              new WorkflowTransportUnavailable({
                operation: "Enqueue",
                retryable: true,
                message: "enqueue response was ambiguous",
              }),
            )
          : Effect.succeed(makeScheduleRunReference(invocationId));
      });

      const reference = yield* enqueueScheduleWorkflow(client, scheduleInput);

      expect(calls).toHaveLength(2);
      expect(calls[0]?.input).toEqual(scheduleInput);
      expect(calls[1]?.input).toEqual(scheduleInput);
      expect(calls[0]?.invocationId).toBe(calls[1]?.invocationId);
      expect(reference).toEqual(makeScheduleRunReference(calls[0]!.invocationId));
    }),
  );

  it.effect("does not retry a definitive workflow input rejection", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client = makeScheduleClient(() => {
        attempts += 1;
        return Effect.fail(new WorkflowInputRejected({ message: "workflow input was rejected" }));
      });

      const exit = yield* Effect.exit(enqueueScheduleWorkflow(client, scheduleInput));

      expect(attempts).toBe(1);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) return;
      expect(Cause.squash(exit.cause)).toBeInstanceOf(WorkflowInputRejected);
    }),
  );
});

describe("SheetWorkflowHttpClient expanded catalog enqueue", () => {
  it.live("preserves a check-in payload and invocation identity across an ambiguous retry", () =>
    Effect.gen(function* () {
      const calls: Array<{
        readonly input: CheckinsOpenInput;
        readonly invocationId: CheckinsOpenReference["invocationId"];
      }> = [];
      let attempts = 0;
      const client = makeCheckinClient((requestInput, options) => {
        const invocationId = options?.invocationId;
        if (invocationId === undefined) return Effect.die("invocation ID is required");
        calls.push({ input: requestInput, invocationId });
        attempts += 1;
        return attempts === 1
          ? Effect.fail(
              new WorkflowTransportUnavailable({
                operation: "Enqueue",
                retryable: true,
                message: "enqueue response was ambiguous",
              }),
            )
          : Effect.succeed(makeCheckinRunReference(invocationId));
      });

      const reference = yield* enqueueCheckinsOpenWorkflow(client, checkinInput);

      expect(calls).toHaveLength(2);
      expect(calls[0]?.input).toEqual(checkinInput);
      expect(calls[1]?.input).toEqual(checkinInput);
      expect(calls[0]?.invocationId).toBe(calls[1]?.invocationId);
      expect(reference).toEqual(makeCheckinRunReference(calls[0]!.invocationId));
    }),
  );

  it.effect("keeps a typed input rejection definitive for a lockdown enqueue", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client = makeLockdownClient(() => {
        attempts += 1;
        return Effect.fail(new WorkflowInputRejected({ message: "lockdown was rejected" }));
      });

      const exit = yield* Effect.exit(
        enqueueConversationsSetLockdownWorkflow(client, lockdownInput),
      );

      expect(attempts).toBe(1);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) return;
      expect(Cause.squash(exit.cause)).toBeInstanceOf(WorkflowInputRejected);
    }),
  );
});

describe("SheetWorkflowHttpClient room-order, member, and screenshot enqueue", () => {
  it.live("preserves every migrated payload and retries room creation with one invocation ID", () =>
    Effect.gen(function* () {
      const roomOrderCreateCalls: Array<{
        readonly input: RoomOrdersCreateInput;
        readonly invocationId: RoomOrdersCreateReference["invocationId"];
      }> = [];
      const roomOrderNavigateCalls: Array<{
        readonly input: RoomOrdersNavigateInput;
        readonly invocationId: RoomOrdersNavigateReference["invocationId"];
      }> = [];
      const roomOrderSendCalls: Array<{
        readonly input: RoomOrdersSendInput;
        readonly invocationId: RoomOrdersSendReference["invocationId"];
      }> = [];
      const roomOrderPinTentativeCalls: Array<{
        readonly input: RoomOrdersPinTentativeInput;
        readonly invocationId: RoomOrdersPinTentativeReference["invocationId"];
      }> = [];
      const membersKickCalls: Array<{
        readonly input: MembersKickInput;
        readonly invocationId: MembersKickReference["invocationId"];
      }> = [];
      const screenshotCalls: Array<{
        readonly input: ScreenshotsCaptureAndDeliverInput;
        readonly invocationId: ScreenshotsCaptureAndDeliverReference["invocationId"];
      }> = [];
      let roomOrderCreateAttempts = 0;

      const roomOrderCreateClient = makeRoomOrderCreateClient((requestInput, options) => {
        const invocationId = options?.invocationId;
        if (invocationId === undefined) return Effect.die("invocation ID is required");
        roomOrderCreateCalls.push({ input: requestInput, invocationId });
        roomOrderCreateAttempts += 1;
        return roomOrderCreateAttempts === 1
          ? Effect.fail(
              new WorkflowTransportUnavailable({
                operation: "Enqueue",
                retryable: true,
                message: "enqueue response was ambiguous",
              }),
            )
          : Effect.succeed(makeRoomOrderCreateReference(invocationId));
      });
      const roomOrderNavigateClient = makeRoomOrderNavigateClient((requestInput, options) => {
        const invocationId = options?.invocationId;
        if (invocationId === undefined) return Effect.die("invocation ID is required");
        roomOrderNavigateCalls.push({ input: requestInput, invocationId });
        return Effect.succeed(makeRoomOrderNavigateReference(invocationId));
      });
      const roomOrderSendClient = makeRoomOrderSendClient((requestInput, options) => {
        const invocationId = options?.invocationId;
        if (invocationId === undefined) return Effect.die("invocation ID is required");
        roomOrderSendCalls.push({ input: requestInput, invocationId });
        return Effect.succeed(makeRoomOrderSendReference(invocationId));
      });
      const roomOrderPinTentativeClient = makeRoomOrderPinTentativeClient(
        (requestInput, options) => {
          const invocationId = options?.invocationId;
          if (invocationId === undefined) return Effect.die("invocation ID is required");
          roomOrderPinTentativeCalls.push({ input: requestInput, invocationId });
          return Effect.succeed(makeRoomOrderPinTentativeReference(invocationId));
        },
      );
      const membersKickClient = makeMembersKickClient((requestInput, options) => {
        const invocationId = options?.invocationId;
        if (invocationId === undefined) return Effect.die("invocation ID is required");
        membersKickCalls.push({ input: requestInput, invocationId });
        return Effect.succeed(makeMembersKickReference(invocationId));
      });
      const screenshotClient = makeScreenshotClient((requestInput, options) => {
        const invocationId = options?.invocationId;
        if (invocationId === undefined) return Effect.die("invocation ID is required");
        screenshotCalls.push({ input: requestInput, invocationId });
        return Effect.succeed(makeScreenshotReference(invocationId));
      });

      const roomOrderCreateReference = yield* enqueueRoomOrdersCreateWorkflow(
        roomOrderCreateClient,
        roomOrderCreateInput,
      );
      const roomOrderNavigateReference = yield* enqueueRoomOrdersNavigateWorkflow(
        roomOrderNavigateClient,
        roomOrderNavigateInput,
      );
      const roomOrderSendReference = yield* enqueueRoomOrdersSendWorkflow(
        roomOrderSendClient,
        roomOrderMessageInput,
      );
      const roomOrderPinTentativeReference = yield* enqueueRoomOrdersPinTentativeWorkflow(
        roomOrderPinTentativeClient,
        roomOrderPinTentativeInput,
      );
      const membersKickReference = yield* enqueueMembersKickWorkflow(
        membersKickClient,
        membersKickInput,
      );
      const screenshotReference = yield* enqueueScreenshotsCaptureAndDeliverWorkflow(
        screenshotClient,
        screenshotInput,
      );

      expect(roomOrderCreateCalls).toHaveLength(2);
      expect(roomOrderCreateCalls[0]?.input).toEqual(roomOrderCreateInput);
      expect(roomOrderCreateCalls[1]?.input).toEqual(roomOrderCreateInput);
      expect(roomOrderCreateCalls[0]?.invocationId).toBe(roomOrderCreateCalls[1]?.invocationId);
      expect(roomOrderCreateReference).toEqual(
        makeRoomOrderCreateReference(roomOrderCreateCalls[0]!.invocationId),
      );
      expect(roomOrderNavigateCalls).toEqual([
        { input: roomOrderNavigateInput, invocationId: roomOrderNavigateReference.invocationId },
      ]);
      expect(roomOrderSendCalls).toEqual([
        { input: roomOrderMessageInput, invocationId: roomOrderSendReference.invocationId },
      ]);
      expect(roomOrderPinTentativeCalls).toEqual([
        {
          input: roomOrderPinTentativeInput,
          invocationId: roomOrderPinTentativeReference.invocationId,
        },
      ]);
      expect(membersKickCalls).toEqual([
        { input: membersKickInput, invocationId: membersKickReference.invocationId },
      ]);
      expect(screenshotCalls).toEqual([
        { input: screenshotInput, invocationId: screenshotReference.invocationId },
      ]);
    }),
  );

  it.effect("does not retry a definitive screenshot input rejection", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client = makeScreenshotClient(() => {
        attempts += 1;
        return Effect.fail(new WorkflowInputRejected({ message: "screenshot was rejected" }));
      });

      const exit = yield* Effect.exit(
        enqueueScreenshotsCaptureAndDeliverWorkflow(client, screenshotInput),
      );

      expect(attempts).toBe(1);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) return;
      expect(Cause.squash(exit.cause)).toBeInstanceOf(WorkflowInputRejected);
    }),
  );
});
