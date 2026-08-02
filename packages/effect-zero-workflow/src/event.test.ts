import { Deferred, Effect, Predicate, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { defineEvent, parseWorkflowEventId } from "./event";

const ApprovalEvent = defineEvent({
  name: "approval.decided",
  value: Schema.Struct({
    approved: Schema.Boolean,
  }),
});

const ApprovalWorkflow = Workflow.make({
  name: "approval.workflow",
  payload: Schema.Struct({
    requestId: Schema.String,
  }),
  success: ApprovalEvent.valueSchema,
  idempotencyKey: ({ requestId }) => requestId,
});

const approvalWorkflowLayer = (awaiting?: Deferred.Deferred<void>) =>
  ApprovalWorkflow.toLayer(
    Effect.fnUntraced(function* () {
      const eventId = yield* ApprovalEvent.createCurrent("review");
      if (Predicate.isNotUndefined(awaiting)) {
        yield* Deferred.succeed(awaiting, undefined);
      }
      return yield* ApprovalEvent.await(eventId).pipe(Effect.orDie);
    }),
  );

const eventIdFor = (requestId: string) =>
  Effect.map(ApprovalWorkflow.executionId({ requestId }), (executionId) =>
    ApprovalEvent.create({
      workflow: ApprovalWorkflow,
      executionId,
      eventKey: "review",
    }),
  );

describe("workflow events", () => {
  it.effect("creates an opaque event ID tied to one workflow execution", () =>
    Effect.gen(function* () {
      const eventId = yield* eventIdFor("approval-1");
      const parsed = yield* parseWorkflowEventId(eventId);

      expect(parsed).toMatchObject({
        eventName: "approval.decided",
        workflowName: "approval.workflow",
      });
    }),
  );

  it.effect("delivers a value sent before the workflow awaits its mailbox", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const eventId = yield* eventIdFor("approval-2");

        yield* ApprovalEvent.send(eventId, { approved: true }).pipe(Effect.orDie);
        const result = yield* ApprovalWorkflow.execute({ requestId: "approval-2" });

        expect(result).toEqual({ approved: true });
      }).pipe(Effect.provide(approvalWorkflowLayer()), Effect.provide(WorkflowEngine.layerMemory)),
    ),
  );

  it.effect("suspends until the matching mailbox receives a value", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const awaiting = yield* Deferred.make<void>();
        const eventId = yield* eventIdFor("approval-3");
        yield* Effect.gen(function* () {
          yield* ApprovalWorkflow.execute({ requestId: "approval-3" }, { discard: true });
          yield* Deferred.await(awaiting);

          yield* ApprovalEvent.send(eventId, { approved: false }).pipe(Effect.orDie);
          const completed = yield* ApprovalWorkflow.execute({ requestId: "approval-3" });

          expect(completed).toEqual({ approved: false });
        }).pipe(
          Effect.provide(approvalWorkflowLayer(awaiting)),
          Effect.provide(WorkflowEngine.layerMemory),
        );
      }),
    ),
  );
});
