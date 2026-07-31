import type { Transaction } from "@rocicorp/zero";
import { Cause, Effect, Exit, Schema } from "effect";
import { WorkflowEventId } from "effect-zero/workflow";
import { describe, expect, it } from "@effect/vitest";
import type { Schema as SheetZeroSchema } from "../schema";
import {
  enqueueWorkflowCommandInZeroTransaction,
  enqueueWorkflowEventInZeroTransaction,
  mutateWithWorkflow,
  WorkflowRunNotAccessibleError,
  type WorkflowEnqueueRequest,
  type WorkflowZeroContext,
} from "./workflow";

const context: WorkflowZeroContext = {
  principalId: "account-1",
  visibilityKey: "account:account-1",
};

const input: WorkflowEnqueueRequest = {
  runId: "invocation-1",
  workflowName: "example",
  definitionVersion: "v1",
  executionId: "execution-1",
  payload: { value: 1 },
};

describe("workflow Zero transaction adapter", () => {
  it.effect("applies the optimistic domain write before the public invocation", () =>
    Effect.gen(function* () {
      const writes: Array<string> = [];
      const tx = {
        location: "client",
        mutate: {
          workflowRun: {
            insert: (row: { readonly runId: string }) => {
              writes.push(`run:${row.runId}`);
              return Promise.resolve();
            },
          },
        },
      } as unknown as Transaction<SheetZeroSchema>;

      yield* Effect.promise(() =>
        mutateWithWorkflow(tx, context, input, () => {
          writes.push("domain");
          return Promise.resolve();
        }),
      );

      expect(writes).toEqual(["domain", "run:invocation-1"]);
    }),
  );

  it.effect("uses the same authoritative transaction for invocation and outbox rows", () =>
    Effect.gen(function* () {
      const statements: Array<{ readonly sql: string; readonly args: readonly unknown[] }> = [];
      const tx = {
        location: "server",
        dbTransaction: {
          query: (sql: string, args: readonly unknown[]) => {
            statements.push({ sql, args });
            return Promise.resolve(
              sql.includes("RETURNING run_id") ? [{ run_id: input.runId }] : [],
            );
          },
        },
      } as unknown as Transaction<SheetZeroSchema>;

      yield* Effect.promise(() =>
        mutateWithWorkflow(tx, context, input, () => {
          statements.push({ sql: "domain", args: [] });
          return Promise.resolve();
        }),
      );

      expect(statements.map(({ sql }) => sql.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
        "domain",
        "INSERT INTO sheet_db_workflow_run",
        "INSERT INTO sheet_db_workflow_command",
      ]);
      expect(statements[1]?.args).toContain(context.visibilityKey);
    }),
  );

  it.effect("uses the persisted run id for idempotent enqueue conflicts", () =>
    Effect.gen(function* () {
      const statements: Array<{ readonly sql: string; readonly args: readonly unknown[] }> = [];
      const tx = {
        location: "server",
        dbTransaction: {
          query: (sql: string, args: readonly unknown[]) => {
            statements.push({ sql, args });
            return Promise.resolve(
              sql.includes("RETURNING run_id") ? [{ run_id: "persisted-run" }] : [],
            );
          },
        },
      } as unknown as Transaction<SheetZeroSchema>;

      yield* Effect.promise(() =>
        mutateWithWorkflow(tx, context, { ...input, runId: "retry-run" }, () => Promise.resolve()),
      );

      expect(statements[1]?.args).toEqual([
        "start:persisted-run",
        "persisted-run",
        input.payload,
        expect.any(Date),
        expect.any(Date),
      ]);
    }),
  );

  it.effect("keeps lifecycle commands private during optimistic execution", () =>
    Effect.gen(function* () {
      const updates: Array<unknown> = [];
      const tx = {
        location: "client",
        mutate: {
          workflowRun: {
            update: (row: unknown) => {
              updates.push(row);
              return Promise.resolve();
            },
          },
        },
      } as unknown as Transaction<SheetZeroSchema>;

      yield* Effect.promise(() =>
        enqueueWorkflowCommandInZeroTransaction(tx, context, {
          commandId: "cancel:invocation-1",
          runId: "invocation-1",
          kind: "cancel",
          payload: null,
        }),
      );

      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ runId: "invocation-1" });
    }),
  );

  it.effect("stores typed mailbox events as event commands", () =>
    Effect.gen(function* () {
      const statements: Array<{ readonly sql: string; readonly args: readonly unknown[] }> = [];
      const tx = {
        location: "server",
        dbTransaction: {
          query: (sql: string, args: readonly unknown[]) => {
            statements.push({ sql, args });
            return Promise.resolve([{ run_exists: true, command_inserted: true }]);
          },
        },
      } as unknown as Transaction<SheetZeroSchema>;
      const eventId = Schema.decodeUnknownSync(WorkflowEventId)(
        "workflow:example/execution:execution-1/deferred:effect-zero%2Fworkflow%2Fevent",
      );

      yield* Effect.promise(() =>
        enqueueWorkflowEventInZeroTransaction(tx, context, {
          commandId: "event:invocation-1",
          runId: "invocation-1",
          eventId,
          value: { approved: true },
        }),
      );

      expect(statements).toHaveLength(1);
      expect(statements[0]?.args).toContain("event");
      expect(statements[0]?.args).toContainEqual({
        eventId,
        value: { approved: true },
      });
    }),
  );

  it.effect("keeps duplicate authoritative commands idempotent", () =>
    Effect.gen(function* () {
      const tx = {
        location: "server",
        dbTransaction: {
          query: () => Promise.resolve([{ run_exists: true, command_inserted: false }]),
        },
      } as unknown as Transaction<SheetZeroSchema>;

      yield* Effect.promise(() =>
        enqueueWorkflowCommandInZeroTransaction(tx, context, {
          commandId: "cancel:invocation-1",
          runId: "invocation-1",
          kind: "cancel",
          payload: null,
        }),
      );
    }),
  );

  it.effect("rejects commands when caller visibility does not match the run", () =>
    Effect.gen(function* () {
      const unauthorizedContext: WorkflowZeroContext = {
        ...context,
        visibilityKey: "account:account-2",
      };
      const tx = {
        location: "server",
        dbTransaction: {
          query: () => Promise.resolve([{ run_exists: false, command_inserted: false }]),
        },
      } as unknown as Transaction<SheetZeroSchema>;

      const exit = yield* Effect.exit(
        Effect.promise(() =>
          enqueueWorkflowCommandInZeroTransaction(tx, unauthorizedContext, {
            commandId: "cancel:invocation-1",
            runId: "invocation-1",
            kind: "cancel",
            payload: null,
          }),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      expect(failure).toBeInstanceOf(WorkflowRunNotAccessibleError);
      expect(failure).toMatchObject({
        _tag: "WorkflowRunNotAccessibleError",
        runId: "invocation-1",
        visibilityKey: "account:account-2",
      });
    }),
  );
});
