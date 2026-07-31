import type { Transaction } from "@rocicorp/zero";
import { Cause, Effect, Exit, Predicate, Schema } from "effect";
import { WorkflowEventId } from "effect-zero/workflow";
import { describe, expect, it } from "@effect/vitest";
import { api } from "../api";
import { internal, service } from "../internal";
import { mutators } from "../mutators";
import type { Schema as SheetZeroSchema } from "../schema";
import {
  enqueueWorkflowCommandInZeroTransaction,
  enqueueWorkflowEventInZeroTransaction,
  mutateWithWorkflow,
  WorkflowRunNotAccessibleError,
  type WorkflowEnqueueRequest,
  type WorkflowZeroContext,
} from "./runs";

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

const makeServerTx = (
  query: (sql: string, args: readonly unknown[]) => Promise<readonly unknown[]>,
) =>
  ({
    location: "server",
    dbTransaction: { query },
  }) as unknown as Transaction<SheetZeroSchema>;

const makeClientTx = (workflowRun: object) =>
  ({
    location: "client",
    mutate: { workflowRun },
  }) as unknown as Transaction<SheetZeroSchema>;

const authoritativeRunRow = (runId = input.runId) => ({
  run_id: runId,
  visibility_key: context.visibilityKey,
  definition_matches: true,
  payload_matches: true,
  max_attempts_matches: true,
});

const promiseEffect = <A>(tryPromise: () => Promise<A>) =>
  Effect.tryPromise({
    try: tryPromise,
    catch: (error) => error,
  });

const expectFailureMessage = (exit: Exit.Exit<unknown, unknown>, expected: string) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure: unknown = exit.cause.reasons.find(Cause.isFailReason)?.error;
    expect(Predicate.isError(failure) ? failure.message : failure).toContain(expected);
  }
};

describe("runs Zero transaction adapter", () => {
  it("exposes run reads publicly and keeps lifecycle writes internal", () => {
    const publicReferences = Object.values(api).flatMap((group) => Object.values(group));

    expect(publicReferences.every((reference) => reference.visibility === "public")).toBe(true);
    expect(Object.keys(api.runs)).toEqual(["get", "list"]);
    expect("enqueue" in api.runs).toBe(false);
    expect(Object.keys(service.runs)).toEqual(["enqueueAsCaller"]);
    expect(Object.keys(internal.runs)).toEqual(["enqueue", "command", "sendEvent"]);
    expect(mutators.runs).toHaveProperty("enqueueAsCaller");
  });

  it.effect("applies the optimistic domain write before the public invocation", () =>
    Effect.gen(function* () {
      const writes: Array<string> = [];
      const tx = makeClientTx({
        insert: (row: { readonly runId: string }) => {
          writes.push(`run:${row.runId}`);
          return Promise.resolve();
        },
      });

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
      const tx = makeServerTx((sql, args) => {
        statements.push({ sql, args });
        return Promise.resolve(sql.includes("RETURNING run_id") ? [authoritativeRunRow()] : []);
      });

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

  it.effect("derives delegated workflow visibility from the trusted caller principal", () =>
    Effect.gen(function* () {
      const statements: Array<{ readonly sql: string; readonly args: readonly unknown[] }> = [];
      const tx = makeServerTx((sql, args) => {
        statements.push({ sql, args });
        return Promise.resolve(
          sql.includes("RETURNING run_id")
            ? [
                {
                  ...authoritativeRunRow(),
                  visibility_key: "account:account-2",
                },
              ]
            : [],
        );
      });

      yield* Effect.promise(() =>
        service.runs.enqueueAsCaller.endpoint.mutator({
          args: {
            caller: { principalId: "account-2" },
            workflow: input,
          },
          ctx: {
            principalId: "sheet-ingress",
            visibilityKey: "service:sheet-ingress",
          },
          tx,
        }),
      );

      expect(statements[0]?.args[4]).toBe("account:account-2");
      expect(statements[0]?.args[5]).toBe(JSON.stringify({ id: "account-2" }));
    }),
  );

  it.effect("uses the persisted run id for idempotent enqueue conflicts", () =>
    Effect.gen(function* () {
      const statements: Array<{ readonly sql: string; readonly args: readonly unknown[] }> = [];
      const tx = makeServerTx((sql, args) => {
        statements.push({ sql, args });
        return Promise.resolve(
          sql.includes("RETURNING run_id") ? [authoritativeRunRow("persisted-run")] : [],
        );
      });

      yield* Effect.promise(() =>
        mutateWithWorkflow(tx, context, { ...input, runId: "retry-run" }, () => Promise.resolve()),
      );

      expect(statements[1]?.args).toEqual([
        "start:persisted-run",
        "persisted-run",
        JSON.stringify(input.payload),
        expect.any(Date),
        expect.any(Date),
      ]);
    }),
  );

  it.effect("rejects idempotent run conflicts with different enqueue parameters", () =>
    Effect.gen(function* () {
      const tx = makeServerTx((sql) =>
        Promise.resolve(
          sql.includes("RETURNING run_id")
            ? [{ ...authoritativeRunRow(), payload_matches: false }]
            : [],
        ),
      );

      const exit = yield* Effect.exit(
        promiseEffect(() => mutateWithWorkflow(tx, context, input, () => Promise.resolve())),
      );

      expectFailureMessage(exit, "was already enqueued with different parameters");
    }),
  );

  it.effect("rejects idempotent run conflicts from another visibility scope", () =>
    Effect.gen(function* () {
      const tx = makeServerTx(() => Promise.resolve([]));

      const exit = yield* Effect.exit(
        promiseEffect(() => mutateWithWorkflow(tx, context, input, () => Promise.resolve())),
      );

      expectFailureMessage(exit, "is not accessible to this caller");
    }),
  );

  it.effect("keeps lifecycle commands private during optimistic execution", () =>
    Effect.gen(function* () {
      const updates: Array<unknown> = [];
      const tx = makeClientTx({
        update: (row: unknown) => {
          updates.push(row);
          return Promise.resolve();
        },
      });

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
      const tx = makeServerTx((sql, args) => {
        statements.push({ sql, args });
        return Promise.resolve([{ run_exists: true, inserted: true }]);
      });
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
      expect(statements[0]?.args).toContain(
        JSON.stringify({
          eventId,
          value: { approved: true },
        }),
      );
    }),
  );

  it.effect("rejects commands for runs outside the caller visibility", () =>
    Effect.gen(function* () {
      const tx = makeServerTx(() => Promise.resolve([{ run_exists: false, inserted: false }]));

      const exit = yield* Effect.exit(
        promiseEffect(() =>
          enqueueWorkflowCommandInZeroTransaction(tx, context, {
            commandId: "cancel:missing",
            runId: "missing",
            kind: "cancel",
            payload: null,
          }),
        ),
      );

      expectFailureMessage(exit, 'Workflow run "missing" was not found for this caller');
      if (Exit.isFailure(exit)) {
        const failure: unknown = exit.cause.reasons.find(Cause.isFailReason)?.error;
        expect(failure).toBeInstanceOf(WorkflowRunNotAccessibleError);
        expect(failure).toMatchObject({
          _tag: "WorkflowRunNotAccessibleError",
          runId: "missing",
          visibilityKey: context.visibilityKey,
        });
      }
    }),
  );

  it.effect("keeps duplicate command delivery idempotent for the same run", () =>
    Effect.gen(function* () {
      const tx = makeServerTx((sql) =>
        Promise.resolve(
          sql.trim().startsWith("SELECT run_id")
            ? [{ run_id: "invocation-1", kind: "cancel", payload_matches: true }]
            : [{ run_exists: true, inserted: false }],
        ),
      );

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

  it.effect("rejects duplicate command ids that belong to another run", () =>
    Effect.gen(function* () {
      const tx = makeServerTx((sql) =>
        Promise.resolve(
          sql.trim().startsWith("SELECT run_id")
            ? [{ run_id: "other-run" }]
            : [{ run_exists: true, inserted: false }],
        ),
      );

      const exit = yield* Effect.exit(
        promiseEffect(() =>
          enqueueWorkflowCommandInZeroTransaction(tx, context, {
            commandId: "cancel:other-run",
            runId: "invocation-1",
            kind: "cancel",
            payload: null,
          }),
        ),
      );

      expectFailureMessage(
        exit,
        'Workflow command "cancel:other-run" already belongs to another workflow run',
      );
    }),
  );

  it.effect("rejects duplicate command ids with another command kind", () =>
    Effect.gen(function* () {
      const tx = makeServerTx((sql) =>
        Promise.resolve(
          sql.trim().startsWith("SELECT run_id")
            ? [{ run_id: "invocation-1", kind: "resume" }]
            : [{ run_exists: true, inserted: false }],
        ),
      );

      const exit = yield* Effect.exit(
        promiseEffect(() =>
          enqueueWorkflowCommandInZeroTransaction(tx, context, {
            commandId: "cancel:invocation-1",
            runId: "invocation-1",
            kind: "cancel",
            payload: null,
          }),
        ),
      );

      expectFailureMessage(
        exit,
        'Workflow command "cancel:invocation-1" already exists with a different kind',
      );
    }),
  );

  it.effect("rejects duplicate command ids with another payload", () =>
    Effect.gen(function* () {
      const tx = makeServerTx((sql) =>
        Promise.resolve(
          sql.trim().startsWith("SELECT run_id")
            ? [{ run_id: "invocation-1", kind: "cancel", payload_matches: false }]
            : [{ run_exists: true, inserted: false }],
        ),
      );

      const exit = yield* Effect.exit(
        promiseEffect(() =>
          enqueueWorkflowCommandInZeroTransaction(tx, context, {
            commandId: "cancel:invocation-1",
            runId: "invocation-1",
            kind: "cancel",
            payload: { reason: "different" },
          }),
        ),
      );

      expectFailureMessage(
        exit,
        'Workflow command "cancel:invocation-1" already exists with a different payload',
      );
    }),
  );
});
