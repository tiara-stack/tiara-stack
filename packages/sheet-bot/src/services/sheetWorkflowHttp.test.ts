import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Schema } from "effect";
import { ResponseReference } from "sheet-bot-api/references";
import { WorkspaceId } from "sheet-workflow-contracts/values";
import { WorkflowInputRejected, WorkflowTransportUnavailable } from "sheet-workflow-http-client";
import {
  enqueueCheckinsOpenWorkflow,
  enqueueConversationsSetLockdownWorkflow,
  enqueueScheduleWorkflow,
  enqueueStatusWorkflow,
  type CheckinsOpenEnqueue,
  type CheckinsOpenInput,
  type CheckinsOpenReference,
  type ConversationsSetLockdownEnqueue,
  type ConversationsSetLockdownInput,
  type SchedulesDeliverUserScheduleEnqueue,
  type SchedulesDeliverUserScheduleInput,
  type SchedulesDeliverUserScheduleReference,
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
