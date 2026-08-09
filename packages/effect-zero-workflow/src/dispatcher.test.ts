import { Cause, Duration, Effect, Exit, Layer, Ref, Schema } from "effect";
import { describe, expect, layer } from "@effect/vitest";
import {
  dispatchWorkflowCommandBatch,
  WorkflowCommandExecutor,
  type WorkflowCommandExecutorService,
} from "./dispatcher";
import { WorkflowStore, type WorkflowCommand, type WorkflowStoreService } from "./store";

const command = (attempts = 1): WorkflowCommand => ({
  commandId: "start:run-1",
  runId: "run-1",
  workflowName: "example.v1",
  executionId: "execution-1",
  definitionVersion: "1",
  kind: "start",
  payload: { input: "value" },
  status: "delivering",
  attempts,
  maxAttempts: 10,
  leaseOwner: "worker-1",
  leaseToken: 1,
});

type Events = ReadonlyArray<string>;

const WorkflowFailure = Schema.Struct({ message: Schema.String });

const makeTestLayer = (
  execute: WorkflowCommandExecutorService["execute"],
  attempts = 1,
  failCommandSettles = true,
) =>
  Layer.effect(
    WorkflowStore,
    Effect.gen(function* () {
      const events = yield* Ref.make<Events>([]);
      const failure = yield* Ref.make<unknown>(undefined);
      const append = (event: string) => Ref.update(events, (current) => [...current, event]);
      const service: WorkflowStoreService & {
        readonly events: Ref.Ref<Events>;
        readonly failure: Ref.Ref<unknown>;
      } = {
        events,
        failure,
        enqueue: () => Effect.die("unused"),
        enqueueCommand: () => Effect.die("unused"),
        claim: () => append("claim").pipe(Effect.as([command(attempts)])),
        getRun: () => Effect.die("unused"),
        listRuns: () => Effect.die("unused"),
        markCommandDelivered: () => append("delivered").pipe(Effect.as(true)),
        retryCommand: (_, __, error) =>
          append(`retry:${Schema.decodeUnknownSync(WorkflowFailure)(error).message}`).pipe(
            Effect.as(true),
          ),
        failCommand: (_, error) =>
          Ref.set(failure, error).pipe(
            Effect.andThen(append(`failed:${failCommandSettles}`)),
            Effect.as(failCommandSettles),
          ),
        markRun: (_, status) => append(`run:${status}`),
      };
      return service;
    }),
  ).pipe(Layer.merge(Layer.succeed(WorkflowCommandExecutor, { execute })));

const events = Effect.gen(function* () {
  const store = yield* WorkflowStore;
  return yield* Ref.get(
    (store as WorkflowStoreService & { readonly events: Ref.Ref<Events> }).events,
  );
});

const failure = Effect.gen(function* () {
  const store = yield* WorkflowStore;
  return yield* Ref.get(
    (store as WorkflowStoreService & { readonly failure: Ref.Ref<unknown> }).failure,
  );
});

describe("workflow command dispatcher", () => {
  layer(makeTestLayer(() => Effect.void))("successful delivery", (it) => {
    it.effect("marks commands delivered", () =>
      Effect.gen(function* () {
        expect(yield* dispatchWorkflowCommandBatch()).toBe(1);
        expect(yield* events).toEqual(["claim", "delivered"]);
      }),
    );
  });

  layer(makeTestLayer(() => Effect.fail("temporary")))("retryable delivery", (it) => {
    it.effect("reschedules commands below the attempt limit", () =>
      Effect.gen(function* () {
        expect(
          yield* dispatchWorkflowCommandBatch({
            maxAttempts: 3,
            retryDelay: () => Duration.zero,
          }),
        ).toBe(1);
        expect(yield* events).toEqual(["claim", "retry:temporary"]);
      }),
    );
  });

  layer(makeTestLayer(() => Effect.fail({ code: "temporary" })))(
    "structured delivery failure",
    (it) => {
      it.effect("preserves structured errors in the stored message", () =>
        Effect.gen(function* () {
          expect(
            yield* dispatchWorkflowCommandBatch({
              maxAttempts: 3,
              retryDelay: () => Duration.zero,
            }),
          ).toBe(1);
          expect(yield* events).toEqual(["claim", 'retry:{"code":"temporary"}']);
        }),
      );
    },
  );

  layer(makeTestLayer(() => Effect.fail(new Error("boom"))))("native delivery failure", (it) => {
    it.effect("stores the native error message", () =>
      Effect.gen(function* () {
        expect(
          yield* dispatchWorkflowCommandBatch({
            maxAttempts: 3,
            retryDelay: () => Duration.zero,
          }),
        ).toBe(1);
        expect(yield* events).toEqual(["claim", "retry:boom"]);
      }),
    );
  });

  layer(makeTestLayer(() => Effect.interrupt))("interrupted delivery", (it) => {
    it.effect("propagates interruption without settling the command", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(dispatchWorkflowCommandBatch());

        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(yield* events).toEqual(["claim"]);
      }),
    );
  });

  layer(makeTestLayer(() => Effect.failCause(Cause.fail("permanent")), 3))(
    "exhausted delivery",
    (it) => {
      it.effect("marks commands failed at the attempt limit", () =>
        Effect.gen(function* () {
          expect(yield* dispatchWorkflowCommandBatch({ maxAttempts: 3 })).toBe(1);
          expect(yield* events).toEqual(["claim", "failed:true"]);
        }),
      );
    },
  );

  layer(makeTestLayer(() => Effect.failCause(Cause.fail("permanent")), 3))(
    "throwing permanent failure materializer",
    (it) => {
      it.effect("falls back to the original failure and settles the command", () =>
        Effect.gen(function* () {
          expect(
            yield* dispatchWorkflowCommandBatch({
              maxAttempts: 3,
              materializePermanentFailure: () => {
                throw new Error("materializer failed");
              },
            }),
          ).toBe(1);
          expect(yield* events).toEqual(["claim", "failed:true"]);
          expect(yield* failure).toEqual({ message: "permanent" });
        }),
      );
    },
  );

  layer(makeTestLayer(() => Effect.failCause(Cause.fail("stale")), 3, false))(
    "stale exhausted delivery",
    (it) => {
      it.effect("does not fail the run after lease settlement is rejected", () =>
        Effect.gen(function* () {
          expect(yield* dispatchWorkflowCommandBatch({ maxAttempts: 3 })).toBe(1);
          expect(yield* events).toEqual(["claim", "failed:false"]);
        }),
      );
    },
  );
});
