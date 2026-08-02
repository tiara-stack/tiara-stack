import { Context, Duration, Effect, Layer, Predicate, Schema } from "effect";
import { SqlClient, SqlError } from "effect/unstable/sql";
import {
  WorkflowCommandKind,
  WorkflowCommandStatus,
  WorkflowRunStatus,
  type WorkflowRunStatus as WorkflowRunStatusType,
} from "./models";

const terminalWorkflowRunStatuses = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies ReadonlyArray<WorkflowRunStatusType>;

const terminalWorkflowRunStatusSet = new Set<WorkflowRunStatusType>(terminalWorkflowRunStatuses);

export const defaultWorkflowMaxAttempts = 10;

export type WorkflowJson =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<WorkflowJson>
  | { readonly [key: string]: WorkflowJson };

export type WorkflowCommand = {
  readonly commandId: string;
  readonly runId: string;
  readonly workflowName: string;
  readonly definitionVersion: string;
  readonly executionId: string;
  readonly kind: typeof WorkflowCommandKind.Type;
  readonly payload: WorkflowJson;
  readonly status: typeof WorkflowCommandStatus.Type;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseOwner: string;
  readonly leaseToken: number;
};

export type WorkflowRun = {
  readonly runId: string;
  readonly workflowName: string;
  readonly definitionVersion: string;
  readonly executionId: string;
  readonly status: WorkflowRunStatusType;
  readonly result: WorkflowJson | null;
  readonly error: WorkflowJson | null;
  readonly updatedAt: Date;
};

export type WorkflowRunCursor = Pick<WorkflowRun, "runId" | "updatedAt">;

export type EnqueueWorkflow = {
  readonly runId: string;
  readonly workflowName: string;
  readonly definitionVersion: string;
  readonly executionId: string;
  readonly idempotencyKey: string;
  readonly visibilityKey: string;
  readonly principal?: WorkflowJson | undefined;
  readonly payload: WorkflowJson;
  readonly maxAttempts?: number | undefined;
  readonly runAfter?: Date | undefined;
};

export type EnqueueWorkflowCommand = {
  readonly commandId: string;
  readonly runId: string;
  readonly kind: typeof WorkflowCommandKind.Type;
  readonly payload: WorkflowJson;
  readonly availableAt?: Date | undefined;
};

export type EnqueuedWorkflow = {
  readonly runId: string;
  readonly executionId: string;
};

export type WorkflowStoreOptions = {
  readonly tablePrefix?: string | undefined;
  readonly claimLease?: Duration.Input | undefined;
};

export interface WorkflowEnqueueTransaction<Error = never, Requirements = never> {
  readonly insertRun: (
    input: EnqueueWorkflow,
  ) => Effect.Effect<EnqueuedWorkflow, Error, Requirements>;
  readonly insertCommand: (
    input: EnqueueWorkflowCommand,
  ) => Effect.Effect<void, Error, Requirements>;
}

/**
 * Writes the public invocation and its private start command through one
 * transaction adapter. Zero mutators can implement this interface over their
 * transaction so domain writes and workflow intent commit atomically.
 */
export const enqueueWorkflowInTransaction = <Error, Requirements>(
  transaction: WorkflowEnqueueTransaction<Error, Requirements>,
  input: EnqueueWorkflow,
): Effect.Effect<EnqueuedWorkflow, Error, Requirements> =>
  Effect.gen(function* () {
    const run = yield* transaction.insertRun(input);
    yield* transaction.insertCommand({
      commandId: `start:${run.runId}`,
      runId: run.runId,
      kind: "start",
      payload: input.payload,
      availableAt: input.runAfter,
    });
    return run;
  });

export interface WorkflowStoreService {
  readonly enqueue: (input: EnqueueWorkflow) => Effect.Effect<EnqueuedWorkflow, SqlError.SqlError>;
  readonly enqueueCommand: (
    input: EnqueueWorkflowCommand,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly claim: (
    limit: number,
    workerId: string,
  ) => Effect.Effect<ReadonlyArray<WorkflowCommand>, SqlError.SqlError>;
  readonly getRun: (runId: string) => Effect.Effect<WorkflowRun | undefined, SqlError.SqlError>;
  readonly listRuns: (
    status: WorkflowRunStatusType,
    limit: number,
    cursor?: WorkflowRunCursor,
  ) => Effect.Effect<ReadonlyArray<WorkflowRun>, SqlError.SqlError>;
  readonly markCommandDelivered: (
    command: WorkflowCommand,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly retryCommand: (
    command: WorkflowCommand,
    delay: Duration.Input,
    error: WorkflowJson,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  /** Atomically fails the leased command and its run when the lease is current. */
  readonly failCommand: (
    command: WorkflowCommand,
    error: WorkflowJson,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  /** Updates a non-terminal run; an already-terminal run is left unchanged. */
  readonly markRun: (
    runId: string,
    status: WorkflowRunStatusType,
    details?: {
      readonly result?: WorkflowJson | undefined;
      readonly error?: WorkflowJson | undefined;
    },
  ) => Effect.Effect<void, SqlError.SqlError>;
}

export class WorkflowStore extends Context.Service<WorkflowStore, WorkflowStoreService>()(
  "effect-zero-workflow/WorkflowStore",
) {}

export const workflowTablePrefixSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
).check(Schema.isMaxLength(46));

const normalizePrefix = (prefix: string | undefined) =>
  prefix
    ? `${Schema.decodeUnknownSync(workflowTablePrefixSchema)(prefix).replace(/_+$/, "")}_`
    : "";

export const workflowTableNames = (prefix?: string) => {
  const normalized = normalizePrefix(prefix);
  return {
    command: `${normalized}workflow_command`,
    run: `${normalized}workflow_run`,
  } as const;
};

const ClaimedWorkflowCommand = Schema.Struct({
  commandId: Schema.String,
  runId: Schema.String,
  workflowName: Schema.String,
  definitionVersion: Schema.String,
  executionId: Schema.String,
  kind: WorkflowCommandKind,
  payload: Schema.Json,
  status: WorkflowCommandStatus,
  attempts: Schema.Number,
  maxAttempts: Schema.Number,
  leaseOwner: Schema.String,
  leaseToken: Schema.Number,
});

const EnqueuedWorkflowRow = Schema.Struct({
  runId: Schema.String,
  executionId: Schema.String,
  definitionMatches: Schema.Boolean,
  payloadMatches: Schema.Boolean,
  maxAttemptsMatches: Schema.Boolean,
});

const ExistingWorkflowCommandRow = Schema.Struct({
  runId: Schema.String,
  kind: WorkflowCommandKind,
  payloadMatches: Schema.Boolean,
});

const WorkflowRunRow = Schema.Struct({
  runId: Schema.String,
  workflowName: Schema.String,
  definitionVersion: Schema.String,
  executionId: Schema.String,
  status: WorkflowRunStatus,
  result: Schema.NullOr(Schema.Json),
  error: Schema.NullOr(Schema.Json),
  updatedAt: Schema.DateValid,
});

const decodeClaimedCommand = Schema.decodeUnknownEffect(ClaimedWorkflowCommand);
const decodeEnqueuedWorkflow = Schema.decodeUnknownEffect(EnqueuedWorkflowRow);
const decodeExistingWorkflowCommand = Schema.decodeUnknownEffect(ExistingWorkflowCommandRow);
const decodeWorkflowRun = Schema.decodeUnknownEffect(WorkflowRunRow);
const encodeWorkflowJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

const workflowStoreError = (message: string, operation: string) =>
  new SqlError.SqlError({
    reason: new SqlError.UnknownError({
      cause: new Error(message),
      message,
      operation,
    }),
  });

const normalizeSqlLimit = (limit: number): number =>
  Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 1;

export const makeWorkflowStore = (
  options: WorkflowStoreOptions = {},
): Effect.Effect<WorkflowStoreService, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = workflowTableNames(options.tablePrefix);
    const runTable = sql(tables.run);
    const commandTable = sql(tables.command);
    const claimLeaseMillis = Duration.toMillis(options.claimLease ?? Duration.minutes(5));
    const jsonb = (value: WorkflowJson) => sql`${encodeWorkflowJson(value)}::jsonb`;

    const insertRun = (input: EnqueueWorkflow) => {
      const now = new Date();
      const maxAttempts = input.maxAttempts ?? defaultWorkflowMaxAttempts;
      const payload = jsonb(input.payload);
      const principal = Predicate.isUndefined(input.principal) ? null : jsonb(input.principal);
      return Effect.gen(function* () {
        const rows = yield* sql`
          INSERT INTO ${runTable} (
            run_id,
            workflow_name,
            definition_version,
            execution_id,
            idempotency_key,
            visibility_key,
            principal,
            input,
            status,
            result,
            error,
            max_attempts,
            run_after,
            started_at,
            completed_at,
            created_at,
            updated_at
          )
          VALUES (
            ${input.runId},
            ${input.workflowName},
            ${input.definitionVersion},
            ${input.executionId},
            ${input.idempotencyKey},
            ${input.visibilityKey},
            ${principal},
            ${payload},
            'pending',
            NULL,
            NULL,
            ${maxAttempts},
            ${input.runAfter ?? now},
            NULL,
            NULL,
            ${now},
            ${now}
          )
          ON CONFLICT (workflow_name, idempotency_key)
          DO UPDATE SET updated_at = ${runTable}.updated_at
          WHERE ${runTable}.visibility_key = EXCLUDED.visibility_key
          RETURNING
            run_id AS "runId",
            execution_id AS "executionId",
            definition_version = ${input.definitionVersion} AS "definitionMatches",
            input = ${payload} AS "payloadMatches",
            max_attempts = ${maxAttempts} AS "maxAttemptsMatches"
        `;
        const row = rows[0];
        if (Predicate.isUndefined(row)) {
          return yield* Effect.fail(
            workflowStoreError(
              `Workflow idempotency conflict is not accessible: ${input.workflowName}`,
              "insert workflow run",
            ),
          );
        }
        const enqueued = yield* decodeEnqueuedWorkflow(row).pipe(Effect.orDie);
        if (
          !enqueued.definitionMatches ||
          !enqueued.payloadMatches ||
          !enqueued.maxAttemptsMatches
        ) {
          return yield* Effect.fail(
            workflowStoreError(
              `Workflow was already enqueued with different parameters: ${input.workflowName}`,
              "insert workflow run",
            ),
          );
        }
        return {
          executionId: enqueued.executionId,
          runId: enqueued.runId,
        };
      });
    };

    const insertCommand = (input: EnqueueWorkflowCommand) => {
      const now = new Date();
      return sql`
        INSERT INTO ${commandTable} (
          command_id,
          run_id,
          kind,
          payload,
          status,
          attempts,
          available_at,
          lease_owner,
          lease_token,
          lease_until,
          delivered_at,
          last_error,
          created_at,
          updated_at
        )
        SELECT
          ${input.commandId},
          run_id,
          ${input.kind},
          ${jsonb(input.payload)},
          'pending',
          0,
          ${input.availableAt ?? now},
          NULL,
          0,
          NULL,
          NULL,
          NULL,
          ${now},
          ${now}
        FROM ${runTable}
        WHERE run_id = ${input.runId}
          AND status NOT IN ${sql.in(terminalWorkflowRunStatuses)}
        ON CONFLICT (command_id) DO NOTHING
        RETURNING command_id
      `.pipe(
        Effect.flatMap((rows) => {
          if (rows.length > 0) {
            return Effect.void;
          }
          return sql`
            SELECT
              run_id AS "runId",
              kind,
              payload = ${jsonb(input.payload)} AS "payloadMatches"
            FROM ${commandTable}
            WHERE command_id = ${input.commandId}
            LIMIT 1
          `.pipe(
            Effect.flatMap((existing) => {
              const row = existing[0];
              if (Predicate.isUndefined(row)) {
                return Effect.fail(
                  workflowStoreError(
                    `Active workflow run not found for command: ${input.runId}`,
                    "insert workflow command",
                  ),
                );
              }
              return decodeExistingWorkflowCommand(row).pipe(
                Effect.orDie,
                Effect.flatMap((command) =>
                  command.runId === input.runId &&
                  command.kind === input.kind &&
                  command.payloadMatches
                    ? Effect.void
                    : Effect.fail(
                        workflowStoreError(
                          `Workflow command was already enqueued with different parameters: ${input.commandId}`,
                          "insert workflow command",
                        ),
                      ),
                ),
              );
            }),
          );
        }),
      );
    };

    const enqueue = (input: EnqueueWorkflow) =>
      sql.withTransaction(enqueueWorkflowInTransaction({ insertRun, insertCommand }, input));

    const enqueueCommand = (input: EnqueueWorkflowCommand) =>
      sql.withTransaction(insertCommand(input));

    const claim = (limit: number, workerId: string) =>
      Effect.gen(function* () {
        const safeLimit = normalizeSqlLimit(limit);
        const rows = yield* sql`
          WITH claimable AS (
            SELECT command.command_id
            FROM ${commandTable} AS command
            INNER JOIN ${runTable} AS claimable_run
              ON claimable_run.run_id = command.run_id
            WHERE claimable_run.status NOT IN ${sql.in(terminalWorkflowRunStatuses)}
              AND (
                (
                  command.status = 'pending'
                  AND command.available_at <= NOW()
                ) OR (
                  command.status = 'delivering'
                  AND command.lease_until <= NOW()
                )
            )
            ORDER BY command.created_at
            LIMIT ${safeLimit}
            FOR UPDATE OF command SKIP LOCKED
          )
          UPDATE ${commandTable} AS command
          SET
            status = 'delivering',
            attempts = command.attempts + 1,
            lease_owner = ${workerId},
            lease_token = command.lease_token + 1,
            lease_until = NOW() + (${claimLeaseMillis} * INTERVAL '1 millisecond'),
            updated_at = NOW()
          FROM claimable, ${runTable} AS run
          WHERE command.command_id = claimable.command_id
            AND command.run_id = run.run_id
          RETURNING
            command.command_id AS "commandId",
            command.run_id AS "runId",
            run.workflow_name AS "workflowName",
            run.definition_version AS "definitionVersion",
            run.execution_id AS "executionId",
            command.kind,
            command.payload,
            command.status,
            command.attempts,
            run.max_attempts AS "maxAttempts",
            command.lease_owner AS "leaseOwner",
            command.lease_token AS "leaseToken"
        `;
        return yield* Effect.forEach(rows, (row) => decodeClaimedCommand(row).pipe(Effect.orDie));
      });

    const settleCommand = (
      command: WorkflowCommand,
      fields: {
        readonly status: "pending" | "delivered" | "failed";
        readonly delay?: Duration.Input | undefined;
        readonly error?: WorkflowJson | undefined;
      },
    ) => {
      const availableAt = Predicate.isUndefined(fields.delay)
        ? new Date()
        : new Date(Date.now() + Duration.toMillis(fields.delay));
      const delivered = fields.status === "delivered";
      return Effect.gen(function* () {
        const rows = yield* sql`
          UPDATE ${commandTable}
          SET
            status = ${fields.status},
            available_at = ${availableAt},
            lease_owner = NULL,
            lease_until = NULL,
            delivered_at = CASE WHEN ${delivered} THEN NOW() ELSE delivered_at END,
            last_error = ${Predicate.isUndefined(fields.error) ? null : jsonb(fields.error)},
            updated_at = NOW()
          WHERE command_id = ${command.commandId}
            AND status = 'delivering'
            AND lease_owner = ${command.leaseOwner}
            AND lease_token = ${command.leaseToken}
          RETURNING command_id
        `;
        return rows.length > 0;
      });
    };

    const decodeRun = (row: unknown) => decodeWorkflowRun(row).pipe(Effect.orDie);

    const selectRunFields = sql`
      run_id AS "runId",
      workflow_name AS "workflowName",
      definition_version AS "definitionVersion",
      execution_id AS "executionId",
      status,
      result,
      error,
      updated_at AS "updatedAt"
    `;

    const getRun = (runId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql`
          SELECT ${selectRunFields}
          FROM ${runTable}
          WHERE run_id = ${runId}
          LIMIT 1
        `;
        return Predicate.isUndefined(rows[0]) ? undefined : yield* decodeRun(rows[0]);
      });

    const listRuns = (status: WorkflowRunStatusType, limit: number, cursor?: WorkflowRunCursor) =>
      Effect.gen(function* () {
        const cursorCondition = Predicate.isUndefined(cursor)
          ? sql``
          : sql`AND (updated_at, run_id) > (${cursor.updatedAt}, ${cursor.runId})`;
        const rows = yield* sql`
          SELECT ${selectRunFields}
          FROM ${runTable}
          WHERE status = ${status}
          ${cursorCondition}
          ORDER BY updated_at, run_id
          LIMIT ${normalizeSqlLimit(limit)}
        `;
        return yield* Effect.forEach(rows, decodeRun);
      });

    const markRun: WorkflowStoreService["markRun"] = (runId, status, details) => {
      const result = details?.result;
      const error = details?.error;
      const hasResult = Predicate.isNotUndefined(result);
      const hasError = Predicate.isNotUndefined(error);
      const resultValue = Predicate.isNotUndefined(result) ? jsonb(result) : null;
      const errorValue = Predicate.isNotUndefined(error) ? jsonb(error) : null;
      const startedAt = status === "running" ? new Date() : null;
      const terminal = isTerminalWorkflowRunStatus(status);
      const completedAt = terminal ? new Date() : null;
      return sql`
        UPDATE ${runTable}
        SET
          status = ${status},
          result = CASE WHEN ${hasResult} THEN ${resultValue} ELSE result END,
          error = CASE WHEN ${hasError} THEN ${errorValue} ELSE error END,
          started_at = COALESCE(started_at, ${startedAt}),
          completed_at = CASE
            WHEN ${terminal} THEN COALESCE(completed_at, ${completedAt})
            ELSE completed_at
          END,
          updated_at = NOW()
        WHERE run_id = ${runId}
          AND status NOT IN ${sql.in(terminalWorkflowRunStatuses)}
      `.pipe(Effect.asVoid);
    };

    return {
      enqueue,
      enqueueCommand,
      claim,
      getRun,
      listRuns,
      markCommandDelivered: (command) =>
        settleCommand(command, {
          status: "delivered",
        }),
      retryCommand: (command, delay, error) =>
        settleCommand(command, {
          status: "pending",
          delay,
          error,
        }),
      failCommand: (command, error) =>
        sql.withTransaction(
          settleCommand(command, {
            status: "failed",
            error,
          }).pipe(
            Effect.tap((settled) =>
              settled ? markRun(command.runId, "failed", { error }) : Effect.void,
            ),
          ),
        ),
      markRun,
    };
  });

export const workflowStoreLayer = (
  options: WorkflowStoreOptions = {},
): Layer.Layer<WorkflowStore, never, SqlClient.SqlClient> =>
  Layer.effect(WorkflowStore, makeWorkflowStore(options));

export const isTerminalWorkflowRunStatus = (status: WorkflowRunStatusType): boolean =>
  terminalWorkflowRunStatusSet.has(status);

/**
 * Checks the lease data carried by a claimed command. Authoritative fencing is
 * performed by the store's conditional settlement statements.
 */
export const isWorkflowCommandLeaseCurrent = (
  command: WorkflowCommand,
  workerId: string,
): boolean => command.leaseOwner === workerId && command.leaseToken > 0;

export const allWorkflowRunStatuses = WorkflowRunStatus.literals;
