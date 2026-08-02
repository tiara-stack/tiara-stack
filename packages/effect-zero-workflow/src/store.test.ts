import { Effect, Exit, Ref } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  enqueueWorkflowInTransaction,
  isTerminalWorkflowRunStatus,
  isWorkflowCommandLeaseCurrent,
  workflowTableNames,
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
  it("normalizes and validates workflow table prefixes", () => {
    expect(workflowTableNames()).toEqual({
      command: "workflow_command",
      run: "workflow_run",
    });
    expect(workflowTableNames("sheet_db")).toEqual({
      command: "sheet_db_workflow_command",
      run: "sheet_db_workflow_run",
    });
    expect(workflowTableNames("sheet_db___")).toEqual(workflowTableNames("sheet_db"));
    expect(() => workflowTableNames("sheet-db")).toThrow();
    expect(() => workflowTableNames("a".repeat(47))).toThrow();
  });

  it("recognizes terminal workflow run statuses", () => {
    expect(isTerminalWorkflowRunStatus("pending")).toBe(false);
    expect(isTerminalWorkflowRunStatus("running")).toBe(false);
    expect(isTerminalWorkflowRunStatus("succeeded")).toBe(true);
    expect(isTerminalWorkflowRunStatus("failed")).toBe(true);
    expect(isTerminalWorkflowRunStatus("cancelled")).toBe(true);
  });

  it.effect("writes the invocation and start intent through the same adapter", () =>
    Effect.gen(function* () {
      const runAfter = new Date("2026-01-01T00:00:00.000Z");
      const writes = yield* Ref.make<ReadonlyArray<string>>([]);
      const commands = yield* Ref.make<ReadonlyArray<EnqueueWorkflowCommand>>([]);
      const transaction: WorkflowEnqueueTransaction = {
        insertRun: (run): Effect.Effect<EnqueuedWorkflow> =>
          Ref.update(writes, (events) => [...events, `run:${run.runId}`]).pipe(
            Effect.as({ runId: run.runId, executionId: run.executionId }),
          ),
        insertCommand: (command: EnqueueWorkflowCommand) =>
          Ref.update(writes, (events) => [...events, `command:${command.commandId}`]).pipe(
            Effect.andThen(Ref.update(commands, (current) => [...current, command])),
          ),
      };

      expect(yield* enqueueWorkflowInTransaction(transaction, { ...input, runAfter })).toEqual({
        runId: "invocation-1",
        executionId: "execution-1",
      });
      expect(yield* Ref.get(writes)).toEqual(["run:invocation-1", "command:start:invocation-1"]);
      expect(yield* Ref.get(commands)).toEqual([
        {
          commandId: "start:invocation-1",
          runId: "invocation-1",
          kind: "start",
          payload: input.payload,
          availableAt: runAfter,
        },
      ]);
    }),
  );

  it.effect("uses the persisted identifiers when enqueue reuses an existing run", () =>
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<EnqueueWorkflowCommand>>([]);
      const transaction: WorkflowEnqueueTransaction = {
        insertRun: () =>
          Effect.succeed({ runId: "existing-run", executionId: "existing-execution" }),
        insertCommand: (command) => Ref.update(commands, (current) => [...current, command]),
      };

      expect(yield* enqueueWorkflowInTransaction(transaction, input)).toEqual({
        runId: "existing-run",
        executionId: "existing-execution",
      });
      expect(yield* Ref.get(commands)).toEqual([
        {
          commandId: "start:existing-run",
          runId: "existing-run",
          kind: "start",
          payload: input.payload,
          availableAt: undefined,
        },
      ]);
    }),
  );

  it.effect("does not write a start command when the run insert fails", () =>
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<EnqueueWorkflowCommand>>([]);
      const transaction: WorkflowEnqueueTransaction<string> = {
        insertRun: () => Effect.fail("insert failed"),
        insertCommand: (command) => Ref.update(commands, (current) => [...current, command]),
      };

      const exit = yield* Effect.exit(enqueueWorkflowInTransaction(transaction, input));

      expect(exit).toEqual(Exit.fail("insert failed"));
      expect(yield* Ref.get(commands)).toEqual([]);
    }),
  );

  it("checks lease ownership and requires a positive fencing token", () => {
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
    expect(isWorkflowCommandLeaseCurrent({ ...claimed, leaseToken: 1 }, "worker-2")).toBe(true);
    expect(isWorkflowCommandLeaseCurrent({ ...claimed, leaseToken: 0 }, "worker-2")).toBe(false);
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
