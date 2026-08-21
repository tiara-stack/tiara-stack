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
import {
  InvocationConflict,
  InvocationId,
  WorkflowContractIdentity,
  WorkflowContractWireVersion,
} from "../contract";
import {
  CanonicalInputHash,
  effectWorkflowExecutionId,
  type AcceptedWorkflowInvocation,
} from "../contract-server";
import { WorkflowInvocationUnauthorized } from "../contract-transport";
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
    contractIdentity: string().from("contract_identity").optional(),
    contractWireVersion: string().from("contract_wire_version").optional(),
    canonicalInputHash: string().from("canonical_input_hash").optional(),
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

const contractInvocation: AcceptedWorkflowInvocation<
  { readonly kind: string; readonly userId: string },
  { readonly actorServiceId: string }
> = {
  fingerprint: {
    invocationId: Schema.decodeUnknownSync(InvocationId)("123e4567-e89b-42d3-a456-426614174000"),
    contractIdentity: Schema.decodeUnknownSync(WorkflowContractIdentity)("example.echo"),
    wireVersion: Schema.decodeUnknownSync(WorkflowContractWireVersion)("1"),
    canonicalInputHash: Schema.decodeUnknownSync(CanonicalInputHash)("sha256:abc"),
  },
  workflowName: '["example.echo","1"]',
  definitionVersion: "definition-v1",
  ownerKey: "user:user-1",
  principal: { kind: "user", userId: "user-1" },
  actorProvenance: { actorServiceId: "sheet-web" },
  input: { value: "hello" },
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

  it.effect("persists declared invocation identity and attribution atomically", () =>
    Effect.gen(function* () {
      const statements: Array<{ readonly sql: string; readonly args: readonly unknown[] }> = [];
      const tx = makeServerTx((sql, args) => {
        statements.push({ sql, args });
        return Promise.resolve(
          sql.includes("actor_provenance")
            ? [
                {
                  run_id: contractInvocation.fingerprint.invocationId,
                  contract_identity: contractInvocation.fingerprint.contractIdentity,
                  contract_wire_version: contractInvocation.fingerprint.wireVersion,
                  canonical_input_hash: contractInvocation.fingerprint.canonicalInputHash,
                  inserted: true,
                },
              ]
            : [],
        );
      });

      const fingerprint = yield* promiseEffect(() =>
        component.enqueueContractInvocationInZeroTransaction(tx, contractInvocation),
      );
      const executionId = yield* effectWorkflowExecutionId(
        contractInvocation.workflowName,
        contractInvocation.fingerprint.invocationId,
      );

      expect(fingerprint).toEqual(contractInvocation.fingerprint);
      expect(statements).toHaveLength(2);
      expect(statements[0]?.sql).toContain("contract_identity");
      expect(statements[0]?.sql).toContain("canonical_input_hash");
      expect(statements[0]?.args.slice(0, 6)).toEqual([
        contractInvocation.fingerprint.invocationId,
        contractInvocation.workflowName,
        contractInvocation.fingerprint.contractIdentity,
        contractInvocation.fingerprint.wireVersion,
        contractInvocation.fingerprint.canonicalInputHash,
        contractInvocation.definitionVersion,
      ]);
      expect(statements[0]?.args[6]).toBe(executionId);
      expect(statements[0]?.args[7]).toBe("user:user-1");
      expect(statements[0]?.args[8]).toBe('{"kind":"user","userId":"user-1"}');
      expect(statements[0]?.args[9]).toBe('{"actorServiceId":"sheet-web"}');
      expect(statements[0]?.args[10]).toBe('{"value":"hello"}');
      expect(statements[1]?.args[0]).toBe(`start:${contractInvocation.fingerprint.invocationId}`);
      expect(statements[1]?.args[2]).toBe(
        JSON.stringify({
          invocationId: contractInvocation.fingerprint.invocationId,
          input: { value: "hello" },
          principal: { kind: "user", userId: "user-1" },
          actorProvenance: { actorServiceId: "sheet-web" },
        }),
      );
    }),
  );

  it.effect("preserves explicit null actor provenance in the private command payload", () =>
    Effect.gen(function* () {
      const statements: Array<{ readonly sql: string; readonly args: readonly unknown[] }> = [];
      const tx = makeServerTx((sql, args) => {
        statements.push({ sql, args });
        return Promise.resolve(
          sql.includes("actor_provenance")
            ? [
                {
                  run_id: contractInvocation.fingerprint.invocationId,
                  contract_identity: contractInvocation.fingerprint.contractIdentity,
                  contract_wire_version: contractInvocation.fingerprint.wireVersion,
                  canonical_input_hash: contractInvocation.fingerprint.canonicalInputHash,
                  inserted: true,
                },
              ]
            : [],
        );
      });

      yield* promiseEffect(() =>
        component.enqueueContractInvocationInZeroTransaction(tx, {
          ...contractInvocation,
          actorProvenance: null,
        }),
      );

      expect(statements[0]?.args[9]).toBe("null");
      expect(statements[1]?.args[2]).toBe(
        JSON.stringify({
          invocationId: contractInvocation.fingerprint.invocationId,
          input: { value: "hello" },
          principal: { kind: "user", userId: "user-1" },
          actorProvenance: null,
        }),
      );
    }),
  );

  it.effect(
    "reuses an identical authoritative fingerprint without duplicating its start command",
    () =>
      Effect.gen(function* () {
        const statements: Array<string> = [];
        const tx = makeServerTx((sql) => {
          statements.push(sql);
          return Promise.resolve([
            {
              run_id: contractInvocation.fingerprint.invocationId,
              contract_identity: contractInvocation.fingerprint.contractIdentity,
              contract_wire_version: contractInvocation.fingerprint.wireVersion,
              canonical_input_hash: contractInvocation.fingerprint.canonicalInputHash,
              inserted: false,
            },
          ]);
        });

        const fingerprint = yield* promiseEffect(() =>
          component.enqueueContractInvocationInZeroTransaction(tx, contractInvocation),
        );

        expect(fingerprint).toEqual(contractInvocation.fingerprint);
        expect(statements).toHaveLength(1);
      }),
  );

  it.effect("rejects invocation reuse with a different authoritative fingerprint", () =>
    Effect.gen(function* () {
      const statements: Array<string> = [];
      const tx = makeServerTx((sql) => {
        statements.push(sql);
        return Promise.resolve([
          {
            run_id: contractInvocation.fingerprint.invocationId,
            contract_identity: "example.other",
            contract_wire_version: "2",
            canonical_input_hash: "sha256:other",
            inserted: false,
          },
        ]);
      });

      const exit = yield* Effect.exit(
        promiseEffect(() =>
          component.enqueueContractInvocationInZeroTransaction(tx, contractInvocation),
        ),
      );

      expectFailureMessage(exit, "conflicts with an existing invocation");
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toBeInstanceOf(
          InvocationConflict,
        );
      }
      expect(statements).toHaveLength(1);
    }),
  );

  it.effect("does not disclose contract metadata outside the invocation owner scope", () =>
    Effect.gen(function* () {
      const statements: Array<string> = [];
      const tx = makeServerTx((sql) => {
        statements.push(sql);
        return Promise.resolve([]);
      });

      const exit = yield* Effect.exit(
        promiseEffect(() =>
          component.enqueueContractInvocationInZeroTransaction(tx, contractInvocation),
        ),
      );

      expectFailureMessage(exit, "not accessible to this principal");
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toBeInstanceOf(
          WorkflowInvocationUnauthorized,
        );
      }
      expect(statements[0]).toContain(
        "WHERE sheet_db_workflow_run.visibility_key = EXCLUDED.visibility_key",
      );
      expect(statements).toHaveLength(1);
    }),
  );

  it.effect("maps invocation identity collisions to a non-disclosing error", () =>
    Effect.gen(function* () {
      const tx = makeServerTx(() =>
        Promise.reject(Object.assign(new Error("duplicate key"), { code: "23505" })),
      );

      const exit = yield* Effect.exit(
        promiseEffect(() =>
          component.enqueueContractInvocationInZeroTransaction(tx, contractInvocation),
        ),
      );

      expectFailureMessage(exit, "not accessible to this principal");
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toBeInstanceOf(
          WorkflowInvocationUnauthorized,
        );
      }
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
