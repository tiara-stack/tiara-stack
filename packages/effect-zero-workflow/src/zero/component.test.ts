import {
  createBuilder,
  createSchema,
  json,
  number,
  string,
  table,
  type Query,
  type Transaction,
} from "@rocicorp/zero";
import { Cause, Effect, Exit, Predicate, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { ZeroApiEndpoint } from "typhoon-zero/zeroApi";
import { WorkflowEventId } from "../event";
import { makeZeroWorkflowComponent } from "./component";
import {
  PublicWorkflowRun,
  WorkflowRunNotAccessibleError,
  type WorkflowEnqueueRequest,
  type WorkflowZeroContext,
} from "./schemas";

const workflowRun = table("workflowRun")
  .from("sheet_db_workflow_run")
  .columns({
    runId: string().from("run_id"),
    workflowName: string().from("workflow_name"),
    definitionVersion: string().from("definition_version"),
    visibilityKey: string().from("visibility_key"),
    status: string(),
    result: json().optional(),
    error: json().optional(),
    runAfter: number().from("run_after"),
    startedAt: number().from("started_at").optional(),
    completedAt: number().from("completed_at").optional(),
    createdAt: number().from("created_at"),
    updatedAt: number().from("updated_at"),
  })
  .primaryKey("runId");

const zeroSchema = createSchema({
  tables: [workflowRun],
  enableLegacyMutators: false,
  enableLegacyQueries: false,
});

type TestZeroSchema = typeof zeroSchema;

const component = makeZeroWorkflowComponent({
  schema: zeroSchema,
  workflowRun: createBuilder(zeroSchema).workflowRun,
  tablePrefix: "sheet_db",
  delegatedContext: (principalId) => ({
    principalId,
    visibilityKey: `account:${principalId}`,
  }),
});

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
  runAfter: Date.UTC(2026, 0, 2, 3, 4, 5),
};

const runAfterIso = "2026-01-02T03:04:05.000Z";
const availableAt = Date.UTC(2026, 1, 3, 4, 5, 6);
const availableAtIso = "2026-02-03T04:05:06.000Z";

const makeServerTx = (
  query: (sql: string, args: readonly unknown[]) => Promise<readonly unknown[]>,
) =>
  ({
    location: "server",
    dbTransaction: { query },
  }) as unknown as Transaction<TestZeroSchema>;

const makeClientTx = (workflowRunMutator: object) =>
  ({
    location: "client",
    mutate: { workflowRun: workflowRunMutator },
  }) as unknown as Transaction<TestZeroSchema>;

const makeQueryRecorder = () => {
  const calls: Array<readonly unknown[]> = [];
  const query = {
    limit: (limit: number) => {
      calls.push(["limit", limit]);
      return query;
    },
    one: () => {
      calls.push(["one"]);
      return query;
    },
    orderBy: (field: string, direction: string) => {
      calls.push(["orderBy", field, direction]);
      return query;
    },
    start: (row: object, options: object) => {
      calls.push(["start", row, options]);
      return query;
    },
    where: (field: string, operator: string, value: unknown) => {
      calls.push(["where", field, operator, value]);
      return query;
    },
  };
  return {
    calls,
    query: query as unknown as Query<"workflowRun", TestZeroSchema>,
  };
};

const makeRecordedComponent = () => {
  const recorder = makeQueryRecorder();
  const recordedComponent = makeZeroWorkflowComponent({
    schema: zeroSchema,
    workflowRun: recorder.query,
    tablePrefix: "sheet_db",
    delegatedContext: (principalId) => ({
      principalId,
      visibilityKey: `account:${principalId}`,
    }),
  });
  return { component: recordedComponent, recorder };
};

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
    const failureReason = exit.cause.reasons.find(Cause.isFailReason);
    expect(failureReason).toBeDefined();
    if (Predicate.isUndefined(failureReason)) {
      return;
    }
    const failure: unknown = failureReason.error;
    const message = Schema.isSchemaError(failure)
      ? failure.message
      : Predicate.isError(failure)
        ? failure.message
        : failure;
    expect(message).toContain(expected);
  }
};

describe("Zero workflow component", () => {
  it("rejects invalid public workflow statuses at the component boundary", () => {
    expect(() =>
      Schema.decodeUnknownSync(PublicWorkflowRun)({
        runId: "run-1",
        workflowName: "example",
        definitionVersion: "v1",
        visibilityKey: context.visibilityKey,
        status: "unknown",
        result: null,
        error: null,
        runAfter: 0,
        startedAt: null,
        completedAt: null,
        createdAt: 0,
        updatedAt: 0,
      }),
    ).toThrow();
  });

  it("defines the stable runs endpoint surface", () => {
    const endpoints = component.runsGroup.endpoints;
    expect(component.runsGroup.identifier).toBe("runs");
    expect(Object.keys(endpoints)).toEqual([
      "get",
      "list",
      "enqueue",
      "enqueueAsCaller",
      "command",
      "sendEvent",
    ]);
    expect(endpoints.get?.visibility).toBe("public");
    expect(endpoints.list?.visibility).toBe("public");
    expect(endpoints.enqueue?.visibility).toBe("internal");
    expect(endpoints.enqueueAsCaller?.visibility).toBe("service");
    expect(endpoints.command?.visibility).toBe("internal");
    expect(endpoints.sendEvent?.visibility).toBe("internal");
  });

  it("filters run lookups by caller visibility", () => {
    const recorded = makeRecordedComponent();
    const endpoint = recorded.component.runsGroup.endpoints.get;
    if (!endpoint || !ZeroApiEndpoint.isKind("query")(endpoint)) {
      throw new Error("Missing workflow run query");
    }

    endpoint.query({ args: { runId: "run-1" }, ctx: context });

    expect(recorded.recorder.calls).toEqual([
      ["where", "runId", "=", "run-1"],
      ["where", "visibilityKey", "=", context.visibilityKey],
      ["one"],
    ]);
  });

  it("orders and cursors visible run lists deterministically", () => {
    const recorded = makeRecordedComponent();
    const endpoint = recorded.component.runsGroup.endpoints.list;
    if (!endpoint || !ZeroApiEndpoint.isKind("query")(endpoint)) {
      throw new Error("Missing workflow run list query");
    }
    const cursor = { updatedAt: 123, runId: "run-1" };

    endpoint.query({ args: { cursor }, ctx: context });

    expect(recorded.recorder.calls).toEqual([
      ["where", "visibilityKey", "=", context.visibilityKey],
      ["orderBy", "updatedAt", "desc"],
      ["orderBy", "runId", "desc"],
      ["limit", 100],
      ["start", cursor, { inclusive: false }],
    ]);
  });

  it("omits cursor positioning from the first page of visible runs", () => {
    const recorded = makeRecordedComponent();
    const endpoint = recorded.component.runsGroup.endpoints.list;
    if (!endpoint || !ZeroApiEndpoint.isKind("query")(endpoint)) {
      throw new Error("Missing workflow run list query");
    }

    endpoint.query({ args: {}, ctx: context });

    expect(recorded.recorder.calls).toEqual([
      ["where", "visibilityKey", "=", context.visibilityKey],
      ["orderBy", "updatedAt", "desc"],
      ["orderBy", "runId", "desc"],
      ["limit", 100],
    ]);
  });

  it("rejects unsafe SQL table prefixes", () => {
    expect(() =>
      makeZeroWorkflowComponent({
        schema: zeroSchema,
        workflowRun: createBuilder(zeroSchema).workflowRun,
        tablePrefix: "sheet_db; DROP TABLE users",
        delegatedContext: (principalId) => ({ principalId, visibilityKey: principalId }),
      }),
    ).toThrow();
  });

  it.effect("applies the optimistic domain write before the public invocation", () =>
    Effect.gen(function* () {
      const writes: Array<string> = [];
      const rows: Array<Record<string, unknown>> = [];
      const tx = makeClientTx({
        insert: (row: { readonly runId: string } & Record<string, unknown>) => {
          writes.push(`run:${row.runId}`);
          rows.push(row);
          return Promise.resolve();
        },
      });

      yield* Effect.promise(() =>
        component.mutateWithWorkflow(tx, context, input, () => {
          writes.push("domain");
          return Promise.resolve();
        }),
      );

      expect(writes).toEqual(["domain", "run:invocation-1"]);
      expect(rows[0]).toMatchObject({
        completedAt: null,
        error: null,
        result: null,
        runAfter: input.runAfter,
        runId: input.runId,
        startedAt: null,
        status: "pending",
        visibilityKey: context.visibilityKey,
      });
    }),
  );

  it.effect("uses one authoritative transaction and schema encodes its values", () =>
    Effect.gen(function* () {
      const statements: Array<{ readonly sql: string; readonly args: readonly unknown[] }> = [];
      const tx = makeServerTx((sql, args) => {
        statements.push({ sql, args });
        return Promise.resolve(sql.includes("RETURNING run_id") ? [authoritativeRunRow()] : []);
      });

      yield* Effect.promise(() =>
        component.mutateWithWorkflow(tx, context, input, () => {
          statements.push({ sql: "domain", args: [] });
          return Promise.resolve();
        }),
      );

      expect(statements.map(({ sql }) => sql.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
        "domain",
        "INSERT INTO sheet_db_workflow_run",
        "INSERT INTO sheet_db_workflow_command",
      ]);
      expect(statements[1]?.args[5]).toBe('{"id":"account-1"}');
      expect(statements[1]?.args[6]).toBe('{"value":1}');
      expect(statements[1]?.args[8]).toBe(runAfterIso);
      expect(statements[1]?.sql).toContain("$6::jsonb");
      expect(statements[1]?.sql).toContain("$7::jsonb");
      expect(statements[2]?.args[2]).toBe('{"value":1}');
      expect(statements[2]?.args[3]).toBe(runAfterIso);
      expect(statements[2]?.sql).toContain("$3::jsonb");
    }),
  );

  it.effect("uses the host mapper for delegated workflow visibility", () =>
    Effect.gen(function* () {
      const statements: Array<{ readonly sql: string; readonly args: readonly unknown[] }> = [];
      const tx = makeServerTx((sql, args) => {
        statements.push({ sql, args });
        return Promise.resolve(
          sql.includes("RETURNING run_id")
            ? [{ ...authoritativeRunRow(), visibility_key: "account:account-2" }]
            : [],
        );
      });
      const endpoint = component.runsGroup.endpoints.enqueueAsCaller;
      if (!endpoint || !ZeroApiEndpoint.isKind("mutator")(endpoint)) {
        return yield* Effect.die("Missing delegated workflow mutator");
      }

      yield* Effect.promise(() =>
        endpoint.mutator({
          args: {
            caller: { principalId: "account-2" },
            workflow: input,
          },
          ctx: context,
          tx,
        }),
      );

      expect(statements[0]?.args[4]).toBe("account:account-2");
      expect(statements[0]?.args[5]).toBe('{"id":"account-2"}');
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
        component.mutateWithWorkflow(tx, context, { ...input, runId: "retry-run" }, () =>
          Promise.resolve(),
        ),
      );

      expect(statements[1]?.args.slice(0, 4)).toEqual([
        "start:persisted-run",
        "persisted-run",
        '{"value":1}',
        runAfterIso,
      ]);
    }),
  );

  it.effect("preserves typed idempotency and visibility conflicts", () =>
    Effect.gen(function* () {
      const conflictTx = makeServerTx((sql) =>
        Promise.resolve(
          sql.includes("RETURNING run_id")
            ? [{ ...authoritativeRunRow(), payload_matches: false }]
            : [],
        ),
      );
      const inaccessibleTx = makeServerTx(() => Promise.resolve([]));

      const conflictExit = yield* Effect.exit(
        promiseEffect(() =>
          component.mutateWithWorkflow(conflictTx, context, input, () => Promise.resolve()),
        ),
      );
      const inaccessibleExit = yield* Effect.exit(
        promiseEffect(() =>
          component.mutateWithWorkflow(inaccessibleTx, context, input, () => Promise.resolve()),
        ),
      );

      expectFailureMessage(conflictExit, "was already enqueued with different parameters");
      expectFailureMessage(inaccessibleExit, "is not accessible to this caller");
      if (Exit.isFailure(inaccessibleExit)) {
        expect(inaccessibleExit.cause.reasons.find(Cause.isFailReason)?.error).toBeInstanceOf(
          WorkflowRunNotAccessibleError,
        );
      }
    }),
  );

  it.effect("rejects malformed SQL rows and invalid timestamps at the schema boundary", () =>
    Effect.gen(function* () {
      const malformedTx = makeServerTx((sql) =>
        Promise.resolve(
          sql.includes("RETURNING run_id")
            ? [{ ...authoritativeRunRow(), definition_matches: "yes" }]
            : [],
        ),
      );
      const invalidDateTx = makeServerTx(() => Promise.resolve([authoritativeRunRow()]));

      const malformedExit = yield* Effect.exit(
        promiseEffect(() =>
          component.mutateWithWorkflow(malformedTx, context, input, () => Promise.resolve()),
        ),
      );
      const invalidDateExit = yield* Effect.exit(
        promiseEffect(() =>
          component.mutateWithWorkflow(
            invalidDateTx,
            context,
            { ...input, runAfter: Number.NaN },
            () => Promise.resolve(),
          ),
        ),
      );

      expectFailureMessage(malformedExit, "definition_matches");
      expectFailureMessage(invalidDateExit, "Invalid Date");
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
        component.enqueueWorkflowCommandInZeroTransaction(tx, context, {
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

  it.effect("serializes command and typed event payloads with exact timestamps", () =>
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
        component.enqueueWorkflowCommandInZeroTransaction(tx, context, {
          commandId: "cancel:invocation-1",
          runId: "invocation-1",
          kind: "cancel",
          payload: { reason: "operator request" },
          availableAt,
        }),
      );
      yield* Effect.promise(() =>
        component.enqueueWorkflowEventInZeroTransaction(tx, context, {
          commandId: "event:invocation-1",
          runId: "invocation-1",
          eventId,
          value: { approved: true },
          availableAt,
        }),
      );

      expect(statements[0]?.args[2]).toBe('{"reason":"operator request"}');
      expect(statements[0]?.args[3]).toBe(availableAtIso);
      expect(statements[0]?.sql).toContain("status NOT IN ('succeeded', 'failed', 'cancelled')");
      expect(statements[1]?.args[2]).toBe(`{"eventId":"${eventId}","value":{"approved":true}}`);
      expect(statements[1]?.args[3]).toBe(availableAtIso);
    }),
  );

  it.effect("validates duplicate and missing command conflicts", () =>
    Effect.gen(function* () {
      const command = {
        commandId: "cancel:invocation-1",
        runId: "invocation-1",
        kind: "cancel" as const,
        payload: null,
      };
      const cases = [
        {
          row: { run_id: "other-run", kind: "cancel", payload_matches: true },
          expected: "already belongs to another workflow run",
        },
        {
          row: { run_id: "invocation-1", kind: "resume", payload_matches: true },
          expected: "already exists with a different kind",
        },
        {
          row: { run_id: "invocation-1", kind: "cancel", payload_matches: false },
          expected: "already exists with a different payload",
        },
      ] as const;

      for (const testCase of cases) {
        const tx = makeServerTx((sql) =>
          Promise.resolve(
            sql.includes("command.payload =")
              ? [testCase.row]
              : [{ run_exists: true, inserted: false }],
          ),
        );
        const exit = yield* Effect.exit(
          promiseEffect(() =>
            component.enqueueWorkflowCommandInZeroTransaction(tx, context, command),
          ),
        );
        expectFailureMessage(exit, testCase.expected);
      }

      const inactiveRunTx = makeServerTx(() =>
        Promise.resolve([{ run_exists: false, inserted: false }]),
      );
      const inactiveRunExit = yield* Effect.exit(
        promiseEffect(() =>
          component.enqueueWorkflowCommandInZeroTransaction(inactiveRunTx, context, command),
        ),
      );
      expectFailureMessage(
        inactiveRunExit,
        'Active workflow run "invocation-1" was not found for this caller',
      );

      const missingTx = makeServerTx((sql) =>
        Promise.resolve(
          sql.includes("command.payload =") ? [] : [{ run_exists: true, inserted: false }],
        ),
      );
      const missingExit = yield* Effect.exit(
        promiseEffect(() =>
          component.enqueueWorkflowCommandInZeroTransaction(missingTx, context, command),
        ),
      );
      expectFailureMessage(missingExit, "is no longer accessible to this caller");
    }),
  );

  it.effect("preserves SQL driver rejections", () =>
    Effect.gen(function* () {
      const driverError = new Error("database unavailable");
      const tx = makeServerTx(() => Promise.reject(driverError));

      const exit = yield* Effect.exit(
        promiseEffect(() =>
          component.mutateWithWorkflow(tx, context, input, () => Promise.resolve()),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toBe(driverError);
      }
    }),
  );

  it.effect("maps a conflicting caller-supplied run id to an inaccessible run", () =>
    Effect.gen(function* () {
      const uniqueViolation = Object.assign(new Error("duplicate key"), { code: "23505" });
      const tx = makeServerTx(() => Promise.reject(uniqueViolation));

      const exit = yield* Effect.exit(
        promiseEffect(() =>
          component.mutateWithWorkflow(tx, context, input, () => Promise.resolve()),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toBeInstanceOf(
          WorkflowRunNotAccessibleError,
        );
      }
    }),
  );
});
