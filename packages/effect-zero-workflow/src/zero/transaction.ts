import type {
  ReadonlyJSONValue as ZeroReadonlyJSONValue,
  Schema as ZeroSchema,
  TableSchema,
  Transaction,
} from "@rocicorp/zero";
import { Effect, Match, Predicate, Result, Schema } from "effect";
import { ReadonlyJSONValue } from "typhoon-zero/schema";
import {
  defaultWorkflowMaxAttempts,
  workflowTableNames,
  workflowTablePrefixSchema,
} from "../store";
import {
  WorkflowInvocationFingerprint,
  effectWorkflowExecutionId,
  type AcceptedWorkflowInvocation,
  validateInvocationReuse,
  workflowContractExecutionPayload,
} from "../contract-server";
import { WorkflowInvocationUnauthorized } from "../contract-transport";
import {
  WorkflowRunNotAccessibleError,
  type WorkflowCommandRequest,
  type WorkflowEnqueueRequest,
  type WorkflowEventRequest,
  type WorkflowZeroContext,
} from "./schemas";

type RequiredColumn<Type extends "json" | "number" | "string", Value> = {
  readonly type: Type;
  readonly optional: false;
  readonly customType: Value;
};

type OptionalColumn<Type extends "json" | "number", Value> = {
  readonly type: Type;
  readonly optional: true;
  readonly customType: Value;
};

export type WorkflowZeroSchema = {
  readonly tables: {
    readonly [table: string]: TableSchema;
    readonly workflowRun: {
      readonly name: "workflowRun";
      readonly columns: {
        readonly runId: RequiredColumn<"string", string>;
        readonly workflowName: RequiredColumn<"string", string>;
        readonly definitionVersion: RequiredColumn<"string", string>;
        readonly visibilityKey: RequiredColumn<"string", string>;
        readonly status: RequiredColumn<"string", string>;
        readonly result: OptionalColumn<"json", ZeroReadonlyJSONValue>;
        readonly error: OptionalColumn<"json", ZeroReadonlyJSONValue>;
        readonly runAfter: RequiredColumn<"number", number>;
        readonly startedAt: OptionalColumn<"number", number>;
        readonly completedAt: OptionalColumn<"number", number>;
        readonly createdAt: RequiredColumn<"number", number>;
        readonly updatedAt: RequiredColumn<"number", number>;
      };
      readonly primaryKey: readonly ["runId"];
      readonly serverName?: string | undefined;
    };
  };
  readonly relationships: ZeroSchema["relationships"];
  readonly enableLegacyQueries?: boolean | undefined;
  readonly enableLegacyMutators?: boolean | undefined;
};

const WorkflowPrincipal = Schema.Struct({ id: Schema.String });

const AuthoritativeRunResult = Schema.Struct({
  run_id: Schema.String,
  visibility_key: Schema.String,
  definition_matches: Schema.Boolean,
  payload_matches: Schema.Boolean,
  max_attempts_matches: Schema.Boolean,
});

const CommandInsertResult = Schema.Struct({
  run_exists: Schema.Boolean,
  inserted: Schema.Boolean,
});

const ExistingCommandResult = Schema.Struct({
  run_id: Schema.String,
  kind: Schema.String,
  payload_matches: Schema.Boolean,
});

const ContractInvocationResult = Schema.Struct({
  run_id: Schema.String,
  contract_identity: Schema.String,
  contract_wire_version: Schema.String,
  canonical_input_hash: Schema.String,
  inserted: Schema.Boolean,
});

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(ReadonlyJSONValue));
const decodeReadonlyJson = Schema.decodeUnknownEffect(ReadonlyJSONValue);
const encodePrincipal = Schema.encodeEffect(Schema.fromJsonString(WorkflowPrincipal));
const encodeTimestamp = Schema.encodeEffect(Schema.toCodecJson(Schema.DateValid));
const decodeAuthoritativeRunResult = Schema.decodeUnknownEffect(AuthoritativeRunResult);
const decodeCommandInsertResult = Schema.decodeUnknownEffect(CommandInsertResult);
const decodeExistingCommandResult = Schema.decodeUnknownEffect(ExistingCommandResult);
const decodeContractInvocationResult = Schema.decodeUnknownEffect(ContractInvocationResult);

const isPostgresUniqueViolation = (error: unknown): boolean =>
  Predicate.hasProperty("code")(error) && error.code === "23505";

const runAsPromise = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.result(effect)).then(
    Result.match({
      onFailure: (error) => {
        throw error;
      },
      onSuccess: (value) => value,
    }),
  );

const validateExistingRun = (
  existingRun: typeof AuthoritativeRunResult.Type,
  context: WorkflowZeroContext,
  input: WorkflowEnqueueRequest,
): Effect.Effect<string, WorkflowRunNotAccessibleError> => {
  const conflict = `${input.workflowName}:${input.executionId}`;
  if (existingRun.visibility_key !== context.visibilityKey) {
    return Effect.fail(
      new WorkflowRunNotAccessibleError({
        runId: existingRun.run_id,
        visibilityKey: context.visibilityKey,
        message: `Workflow run "${conflict}" belongs to another visibility scope`,
      }),
    );
  }
  if (
    !existingRun.definition_matches ||
    !existingRun.payload_matches ||
    !existingRun.max_attempts_matches
  ) {
    return Effect.fail(
      new WorkflowRunNotAccessibleError({
        runId: existingRun.run_id,
        visibilityKey: context.visibilityKey,
        message: `Workflow run "${conflict}" was already enqueued with different parameters`,
      }),
    );
  }
  return Effect.succeed(existingRun.run_id);
};

type WorkflowCommandInput = {
  readonly commandId: string;
  readonly runId: string;
  readonly kind: "cancel" | "event" | "resume";
  readonly payload: typeof ReadonlyJSONValue.Type;
  readonly availableAt?: number | undefined;
};

const validateExistingCommand = (
  existingCommand: typeof ExistingCommandResult.Type,
  context: WorkflowZeroContext,
  input: WorkflowCommandInput,
): Effect.Effect<void, WorkflowRunNotAccessibleError> => {
  if (existingCommand.run_id !== input.runId) {
    return Effect.fail(
      new WorkflowRunNotAccessibleError({
        runId: input.runId,
        visibilityKey: context.visibilityKey,
        message: `Workflow command "${input.commandId}" already belongs to another workflow run`,
      }),
    );
  }
  if (existingCommand.kind !== input.kind) {
    return Effect.fail(
      new WorkflowRunNotAccessibleError({
        runId: input.runId,
        visibilityKey: context.visibilityKey,
        message: `Workflow command "${input.commandId}" already exists with a different kind`,
      }),
    );
  }
  if (!existingCommand.payload_matches) {
    return Effect.fail(
      new WorkflowRunNotAccessibleError({
        runId: input.runId,
        visibilityKey: context.visibilityKey,
        message: `Workflow command "${input.commandId}" already exists with a different payload`,
      }),
    );
  }
  return Effect.void;
};

export const makeWorkflowZeroTransaction = (options: { readonly tablePrefix: string }) => {
  const tablePrefix = Schema.decodeUnknownSync(workflowTablePrefixSchema)(options.tablePrefix);
  const tables = workflowTableNames(tablePrefix);
  const runTable = tables.run;
  const commandTable = tables.command;

  const enqueueAuthoritative = (
    tx: Extract<Transaction<WorkflowZeroSchema>, { readonly location: "server" }>,
    context: WorkflowZeroContext,
    input: WorkflowEnqueueRequest,
  ) =>
    runAsPromise(
      Effect.gen(function* () {
        const now = new Date();
        const runAfter = new Date(input.runAfter ?? now.getTime());
        const encoded = yield* Effect.all({
          input: encodeJson(input.payload),
          now: encodeTimestamp(now),
          principal: encodePrincipal({ id: context.principalId }),
          runAfter: encodeTimestamp(runAfter),
        });
        const rows = Array.from(
          yield* Effect.tryPromise({
            try: () =>
              tx.dbTransaction.query(
                `INSERT INTO ${runTable} (
          run_id, workflow_name, definition_version, execution_id, idempotency_key,
          visibility_key, principal, input, status, result, error, max_attempts,
          run_after, started_at, completed_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $4, $5, $6::jsonb, $7::jsonb, 'pending', NULL, NULL, $8,
          $9, NULL, NULL, $10, $10
        )
        ON CONFLICT (workflow_name, idempotency_key)
        DO UPDATE SET updated_at = ${runTable}.updated_at
        WHERE ${runTable}.visibility_key = EXCLUDED.visibility_key
        RETURNING run_id,
          visibility_key,
          definition_version = $3 AS definition_matches,
          input = $7::jsonb AS payload_matches,
          max_attempts = $8 AS max_attempts_matches`,
                [
                  input.runId,
                  input.workflowName,
                  input.definitionVersion,
                  input.executionId,
                  context.visibilityKey,
                  encoded.principal,
                  encoded.input,
                  input.maxAttempts ?? defaultWorkflowMaxAttempts,
                  encoded.runAfter,
                  encoded.now,
                ],
              ),
            catch: (error) =>
              isPostgresUniqueViolation(error)
                ? new WorkflowRunNotAccessibleError({
                    runId: input.runId,
                    visibilityKey: context.visibilityKey,
                    message: `Workflow run "${input.runId}" is not accessible to this caller`,
                  })
                : error,
          }),
        );
        const row = rows[0];
        if (Predicate.isUndefined(row)) {
          return yield* Effect.fail(
            new WorkflowRunNotAccessibleError({
              runId: input.runId,
              visibilityKey: context.visibilityKey,
              message: `Workflow run "${input.runId}" is not accessible to this caller`,
            }),
          );
        }
        const authoritativeRun = yield* decodeAuthoritativeRunResult(row);
        const authoritativeRunId = yield* validateExistingRun(authoritativeRun, context, input);
        yield* Effect.tryPromise({
          try: () =>
            tx.dbTransaction.query(
              `INSERT INTO ${commandTable} (
        command_id, run_id, kind, payload, status, attempts, available_at,
        lease_owner, lease_token, lease_until, delivered_at, last_error,
        created_at, updated_at
      ) VALUES (
        $1, $2, 'start', $3::jsonb, 'pending', 0, $4,
        NULL, 0, NULL, NULL, NULL, $5, $5
      )
      ON CONFLICT (command_id) DO NOTHING`,
              [
                `start:${authoritativeRunId}`,
                authoritativeRunId,
                encoded.input,
                encoded.runAfter,
                encoded.now,
              ],
            ),
          catch: (error) => error,
        });
      }),
    );

  const enqueueWorkflowInZeroTransaction = (
    tx: Transaction<WorkflowZeroSchema>,
    context: WorkflowZeroContext,
    input: WorkflowEnqueueRequest,
  ) =>
    Match.value(tx).pipe(
      Match.discriminatorsExhaustive("location")({
        client: async (clientTx) => {
          const now = Date.now();
          await clientTx.mutate.workflowRun.insert({
            runId: input.runId,
            workflowName: input.workflowName,
            definitionVersion: input.definitionVersion,
            visibilityKey: context.visibilityKey,
            status: "pending",
            result: null,
            error: null,
            runAfter: input.runAfter ?? now,
            startedAt: null,
            completedAt: null,
            createdAt: now,
            updatedAt: now,
          });
        },
        server: (serverTx) => enqueueAuthoritative(serverTx, context, input),
      }),
    );

  const enqueueContractInvocationInZeroTransaction = <Principal, Provenance>(
    tx: Transaction<WorkflowZeroSchema>,
    invocation: AcceptedWorkflowInvocation<Principal, Provenance>,
  ): Promise<WorkflowInvocationFingerprint> =>
    Match.value(tx).pipe(
      Match.discriminatorsExhaustive("location")({
        client: async (clientTx) => {
          const now = Date.now();
          await clientTx.mutate.workflowRun.insert({
            runId: invocation.fingerprint.invocationId,
            workflowName: invocation.workflowName,
            definitionVersion: invocation.definitionVersion,
            visibilityKey: invocation.ownerKey,
            status: "pending",
            result: null,
            error: null,
            runAfter: now,
            startedAt: null,
            completedAt: null,
            createdAt: now,
            updatedAt: now,
          });
          return invocation.fingerprint;
        },
        server: (serverTx) =>
          runAsPromise(
            Effect.gen(function* () {
              const now = new Date();
              const actorProvenance = Predicate.isUndefined(invocation.actorProvenance)
                ? undefined
                : yield* decodeReadonlyJson(invocation.actorProvenance);
              const principal = yield* decodeReadonlyJson(invocation.principal);
              const encoded = yield* Effect.all({
                actorProvenance: Predicate.isUndefined(actorProvenance)
                  ? Effect.succeed<null>(null)
                  : encodeJson(actorProvenance),
                input: encodeJson(invocation.input),
                now: encodeTimestamp(now),
                principal: encodeJson(principal),
              });
              const executionPayload = yield* decodeReadonlyJson(
                workflowContractExecutionPayload({
                  ...invocation,
                  principal,
                  ...(Predicate.isUndefined(actorProvenance) ? {} : { actorProvenance }),
                }),
              );
              const commandPayload = yield* encodeJson(executionPayload);
              const executionId = yield* effectWorkflowExecutionId(
                invocation.workflowName,
                invocation.fingerprint.invocationId,
              );
              const rows = Array.from(
                yield* Effect.tryPromise({
                  try: () =>
                    serverTx.dbTransaction.query(
                      `INSERT INTO ${runTable} (
          run_id, workflow_name, contract_identity, contract_wire_version,
          canonical_input_hash, definition_version, execution_id, idempotency_key,
          visibility_key, principal, actor_provenance, input, status, result, error,
          max_attempts, run_after, started_at, completed_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $1,
          $8, $9::jsonb, $10::jsonb, $11::jsonb, 'pending', NULL, NULL,
          $12, $13, NULL, NULL, $13, $13
        )
        ON CONFLICT (run_id)
        DO UPDATE SET updated_at = ${runTable}.updated_at
        WHERE ${runTable}.visibility_key = EXCLUDED.visibility_key
        RETURNING run_id,
          COALESCE(contract_identity, workflow_name) AS contract_identity,
          COALESCE(contract_wire_version, 'legacy') AS contract_wire_version,
          COALESCE(canonical_input_hash, 'legacy') AS canonical_input_hash,
          (xmax = 0) AS inserted`,
                      [
                        invocation.fingerprint.invocationId,
                        invocation.workflowName,
                        invocation.fingerprint.contractIdentity,
                        invocation.fingerprint.wireVersion,
                        invocation.fingerprint.canonicalInputHash,
                        invocation.definitionVersion,
                        executionId,
                        invocation.ownerKey,
                        encoded.principal,
                        encoded.actorProvenance,
                        encoded.input,
                        defaultWorkflowMaxAttempts,
                        encoded.now,
                      ],
                    ),
                  catch: (error) =>
                    isPostgresUniqueViolation(error)
                      ? new WorkflowInvocationUnauthorized({
                          message: "Workflow invocation is not accessible to this principal",
                        })
                      : error,
                }),
              );
              const row = rows[0];
              if (Predicate.isUndefined(row)) {
                return yield* Effect.fail(
                  new WorkflowInvocationUnauthorized({
                    message: "Workflow invocation is not accessible to this principal",
                  }),
                );
              }
              const authoritative = yield* decodeContractInvocationResult(row);
              const authoritativeFingerprint = yield* Schema.decodeUnknownEffect(
                WorkflowInvocationFingerprint,
              )({
                invocationId: authoritative.run_id,
                contractIdentity: authoritative.contract_identity,
                wireVersion: authoritative.contract_wire_version,
                canonicalInputHash: authoritative.canonical_input_hash,
              });
              yield* validateInvocationReuse(authoritativeFingerprint, invocation.fingerprint);
              if (authoritative.inserted) {
                yield* Effect.tryPromise({
                  try: () =>
                    serverTx.dbTransaction.query(
                      `INSERT INTO ${commandTable} (
          command_id, run_id, kind, payload, status, attempts, available_at,
          lease_owner, lease_token, lease_until, delivered_at, last_error,
          created_at, updated_at
        ) VALUES (
          $1, $2, 'start', $3::jsonb, 'pending', 0, $4,
          NULL, 0, NULL, NULL, NULL, $4, $4
        )
        ON CONFLICT (command_id) DO NOTHING`,
                      [
                        `start:${authoritative.run_id}`,
                        authoritative.run_id,
                        commandPayload,
                        encoded.now,
                      ],
                    ),
                  catch: (error) => error,
                });
              }
              return authoritativeFingerprint;
            }),
          ),
      }),
    );

  const mutateWithWorkflow = async (
    tx: Transaction<WorkflowZeroSchema>,
    context: WorkflowZeroContext,
    input: WorkflowEnqueueRequest,
    mutateDomain: (tx: Transaction<WorkflowZeroSchema>) => Promise<void>,
  ) => {
    await mutateDomain(tx);
    await enqueueWorkflowInZeroTransaction(tx, context, input);
  };

  const enqueueCommandAuthoritative = (
    tx: Extract<Transaction<WorkflowZeroSchema>, { readonly location: "server" }>,
    context: WorkflowZeroContext,
    input: WorkflowCommandInput,
  ) =>
    runAsPromise(
      Effect.gen(function* () {
        const now = new Date();
        const encoded = yield* Effect.all({
          availableAt: encodeTimestamp(new Date(input.availableAt ?? now.getTime())),
          now: encodeTimestamp(now),
          payload: encodeJson(input.payload),
        });
        const rows = Array.from(
          yield* Effect.tryPromise({
            try: () =>
              tx.dbTransaction.query(
                `WITH target_run AS (
          SELECT run_id
          FROM ${runTable}
          WHERE run_id = $6 AND visibility_key = $7
            AND status NOT IN ('succeeded', 'failed', 'cancelled')
        ), inserted AS (
          INSERT INTO ${commandTable} (
            command_id, run_id, kind, payload, status, attempts, available_at,
            lease_owner, lease_token, lease_until, delivered_at, last_error,
            created_at, updated_at
          )
          SELECT $1, run_id, $2, $3::jsonb, 'pending', 0, $4,
            NULL, 0, NULL, NULL, NULL, $5, $5
          FROM target_run
          ON CONFLICT (command_id) DO NOTHING
          RETURNING command_id
        )
        SELECT
          EXISTS (SELECT 1 FROM target_run) AS run_exists,
          EXISTS (SELECT 1 FROM inserted) AS inserted`,
                [
                  input.commandId,
                  input.kind,
                  encoded.payload,
                  encoded.availableAt,
                  encoded.now,
                  input.runId,
                  context.visibilityKey,
                ],
              ),
            catch: (error) => error,
          }),
        );
        const rawRow = rows[0];
        if (Predicate.isUndefined(rawRow)) {
          return yield* Effect.fail(
            new WorkflowRunNotAccessibleError({
              runId: input.runId,
              visibilityKey: context.visibilityKey,
              message: `Active workflow run "${input.runId}" was not found for this caller`,
            }),
          );
        }
        const row = yield* decodeCommandInsertResult(rawRow);
        if (!row.run_exists) {
          return yield* Effect.fail(
            new WorkflowRunNotAccessibleError({
              runId: input.runId,
              visibilityKey: context.visibilityKey,
              message: `Active workflow run "${input.runId}" was not found for this caller`,
            }),
          );
        }
        if (row.inserted) {
          return;
        }
        const existingRows = Array.from(
          yield* Effect.tryPromise({
            try: () =>
              tx.dbTransaction.query(
                `SELECT command.run_id, command.kind,
          command.payload = $2::jsonb AS payload_matches
        FROM ${commandTable} AS command
        INNER JOIN ${runTable} AS run ON run.run_id = command.run_id
        WHERE command.command_id = $1 AND run.visibility_key = $3`,
                [input.commandId, encoded.payload, context.visibilityKey],
              ),
            catch: (error) => error,
          }),
        );
        const existingRow = existingRows[0];
        if (Predicate.isUndefined(existingRow)) {
          return yield* Effect.fail(
            new WorkflowRunNotAccessibleError({
              runId: input.runId,
              visibilityKey: context.visibilityKey,
              message: `Workflow command "${input.commandId}" is no longer accessible to this caller`,
            }),
          );
        }
        const existingCommand = yield* decodeExistingCommandResult(existingRow);
        yield* validateExistingCommand(existingCommand, context, input);
      }),
    );

  const enqueueCommandInZeroTransaction = (
    tx: Transaction<WorkflowZeroSchema>,
    context: WorkflowZeroContext,
    input: WorkflowCommandInput,
  ) =>
    Match.value(tx).pipe(
      Match.discriminatorsExhaustive("location")({
        client: async (clientTx) => {
          await clientTx.mutate.workflowRun.update({
            runId: input.runId,
            updatedAt: Date.now(),
          });
        },
        server: (serverTx) => enqueueCommandAuthoritative(serverTx, context, input),
      }),
    );

  const enqueueWorkflowCommandInZeroTransaction = (
    tx: Transaction<WorkflowZeroSchema>,
    context: WorkflowZeroContext,
    input: WorkflowCommandRequest,
  ) => enqueueCommandInZeroTransaction(tx, context, input);

  const enqueueWorkflowEventInZeroTransaction = (
    tx: Transaction<WorkflowZeroSchema>,
    context: WorkflowZeroContext,
    input: WorkflowEventRequest,
  ) =>
    enqueueCommandInZeroTransaction(tx, context, {
      commandId: input.commandId,
      runId: input.runId,
      kind: "event",
      payload: {
        eventId: input.eventId,
        value: input.value,
      },
      availableAt: input.availableAt,
    });

  return {
    enqueueContractInvocationInZeroTransaction,
    enqueueWorkflowCommandInZeroTransaction,
    enqueueWorkflowEventInZeroTransaction,
    enqueueWorkflowInZeroTransaction,
    mutateWithWorkflow,
  };
};
