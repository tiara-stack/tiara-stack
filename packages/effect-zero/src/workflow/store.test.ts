import { Effect, Ref } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  enqueueWorkflowInTransaction,
  isWorkflowCommandLeaseCurrent,
  type EnqueueWorkflowCommand,
  type EnqueuedWorkflow,
  type EnqueueWorkflow,
  type WorkflowCommand,
  type WorkflowEnqueueTransaction,
} from "./store";

const input: EnqueueWorkflow = {
  runId: "invocation-1",
  workflowName: "example",
  definitionVersion: "v1",
  executionId: "execution-1",
  idempotencyKey: "key-1",
  visibilityKey: "workspace-1",
  payload: { value: 1 },
};

describe("workflow enqueue transaction", () => {
  it.effect("writes the invocation and start intent through the same adapter", () =>
    Effect.gen(function* () {
      const writes = yield* Ref.make<ReadonlyArray<string>>([]);
      const transaction: WorkflowEnqueueTransaction = {
        insertRun: (run): Effect.Effect<EnqueuedWorkflow> =>
          Ref.update(writes, (events) => [...events, `run:${run.runId}`]).pipe(
            Effect.as({ runId: run.runId, executionId: run.executionId }),
          ),
        insertCommand: (command: EnqueueWorkflowCommand) =>
          Ref.update(writes, (events) => [...events, `command:${command.commandId}`]),
      };

      expect(yield* enqueueWorkflowInTransaction(transaction, input)).toEqual({
        runId: "invocation-1",
        executionId: "execution-1",
      });
      expect(yield* Ref.get(writes)).toEqual(["run:invocation-1", "command:start:invocation-1"]);
    }),
  );

  it("rejects a reclaimed worker's stale fencing token", () => {
    const claimed: WorkflowCommand = {
      commandId: "start:invocation-1",
      runId: "invocation-1",
      workflowName: "example",
      definitionVersion: "v1",
      executionId: "execution-1",
      kind: "start",
      payload: input.payload,
      status: "delivering",
      attempts: 2,
      maxAttempts: 10,
      leaseOwner: "worker-2",
      leaseToken: 2,
    };

    expect(isWorkflowCommandLeaseCurrent(claimed, "worker-2")).toBe(true);
    expect(
      isWorkflowCommandLeaseCurrent(
        {
          ...claimed,
          leaseOwner: "worker-1",
          leaseToken: 1,
        },
        "worker-2",
      ),
    ).toBe(false);
  });
});
