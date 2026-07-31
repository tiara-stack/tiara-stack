import type { Transaction } from "@rocicorp/zero";
import { Data, Match, Predicate, Schema } from "effect";
import { ZeroApiEndpoint, ZeroApiGroup } from "typhoon-zero/zeroApi";
import { ReadonlyJSONValue } from "typhoon-zero/schema";
import { WorkflowEventId } from "effect-zero/workflow";
import { zql, type Schema as SheetZeroSchema } from "../schema";

/** Run data API plus transaction helpers used by durable workflow implementations. */
export type WorkflowZeroContext = {
  readonly principalId: string;
  readonly visibilityKey: string;
};

export class WorkflowRunNotAccessibleError extends Data.TaggedError(
  "WorkflowRunNotAccessibleError",
)<{
  readonly runId: string;
  readonly visibilityKey: string;
  readonly message: string;
}> {}

export const WorkflowEnqueueRequest = Schema.Struct({
  runId: Schema.String,
  workflowName: Schema.String,
  definitionVersion: Schema.String,
  executionId: Schema.String,
  payload: ReadonlyJSONValue,
  maxAttempts: Schema.optional(Schema.Int),
  runAfter: Schema.optional(Schema.Number),
});

export type WorkflowEnqueueRequest = typeof WorkflowEnqueueRequest.Type;

export const DelegatedWorkflowEnqueueRequest = Schema.Struct({
  caller: Schema.Struct({
    principalId: Schema.String,
  }),
  workflow: WorkflowEnqueueRequest,
});

export type DelegatedWorkflowEnqueueRequest = typeof DelegatedWorkflowEnqueueRequest.Type;

export const WorkflowCommandRequest = Schema.Struct({
  commandId: Schema.String,
  runId: Schema.String,
  kind: Schema.Literals(["cancel", "resume"]),
  payload: ReadonlyJSONValue,
  availableAt: Schema.optional(Schema.Number),
});

export type WorkflowCommandRequest = typeof WorkflowCommandRequest.Type;

export const WorkflowEventRequest = Schema.Struct({
  commandId: Schema.String,
  runId: Schema.String,
  eventId: WorkflowEventId,
  value: ReadonlyJSONValue,
  availableAt: Schema.optional(Schema.Number),
});

export type WorkflowEventRequest = typeof WorkflowEventRequest.Type;

const publicWorkflowRun = Schema.Struct({
  runId: Schema.String,
  workflowName: Schema.String,
  definitionVersion: Schema.String,
  visibilityKey: Schema.String,
  status: Schema.String,
  result: Schema.NullOr(ReadonlyJSONValue),
  error: Schema.NullOr(ReadonlyJSONValue),
  runAfter: Schema.Number,
  startedAt: Schema.NullOr(Schema.Number),
  completedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

const hasTrueProperty = (input: unknown, key: string) =>
  Predicate.hasProperty(key)(input) && input[key] === true;

const requireStringProperty = (input: unknown, key: string, message: string) => {
  if (!Predicate.hasProperty(key)(input) || !Predicate.isString(input[key])) {
    throw new Error(message);
  }
  return input[key];
};

const validateExistingRun = (
  existingRun: unknown,
  context: WorkflowZeroContext,
  input: WorkflowEnqueueRequest,
) => {
  const conflict = `${input.workflowName}:${input.executionId}`;
  const visibilityKey = requireStringProperty(
    existingRun,
    "visibility_key",
    `Workflow run conflict for "${conflict}" could not be resolved`,
  );
  if (visibilityKey !== context.visibilityKey) {
    throw new Error(`Workflow run "${conflict}" belongs to another visibility scope`);
  }
  const runId = requireStringProperty(
    existingRun,
    "run_id",
    `Workflow run conflict for "${conflict}" could not be resolved`,
  );
  if (
    !["definition_matches", "payload_matches", "max_attempts_matches"].every((key) =>
      hasTrueProperty(existingRun, key),
    )
  ) {
    throw new Error(`Workflow run "${conflict}" was already enqueued with different parameters`);
  }
  return runId;
};

const enqueueAuthoritative = async (
  tx: Extract<Transaction<SheetZeroSchema>, { readonly location: "server" }>,
  context: WorkflowZeroContext,
  input: WorkflowEnqueueRequest,
) => {
  const now = new Date();
  const runAfter = new Date(input.runAfter ?? now.getTime());
  const rows = Array.from(
    await tx.dbTransaction.query(
      `INSERT INTO sheet_db_workflow_run (
        run_id, workflow_name, definition_version, execution_id, idempotency_key,
        visibility_key, principal, input, status, result, error, max_attempts,
        run_after, started_at, completed_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $4, $5, $6, $7, 'pending', NULL, NULL, $8,
        $9, NULL, NULL, $10, $10
      )
      ON CONFLICT (workflow_name, idempotency_key)
      DO UPDATE SET updated_at = sheet_db_workflow_run.updated_at
      WHERE sheet_db_workflow_run.visibility_key = EXCLUDED.visibility_key
      RETURNING run_id,
        visibility_key,
        definition_version = $3 AS definition_matches,
        input = $7 AS payload_matches,
        max_attempts = $8 AS max_attempts_matches`,
      [
        input.runId,
        input.workflowName,
        input.definitionVersion,
        input.executionId,
        context.visibilityKey,
        { id: context.principalId },
        input.payload,
        input.maxAttempts ?? 10,
        runAfter,
        now,
      ],
    ),
  );
  const row = rows[0];
  if (!Predicate.hasProperty("run_id")(row)) {
    throw new WorkflowRunNotAccessibleError({
      runId: input.runId,
      visibilityKey: context.visibilityKey,
      message: `Workflow run "${input.runId}" is not accessible to this caller`,
    });
  }
  const authoritativeRunId = validateExistingRun(row, context, input);
  await tx.dbTransaction.query(
    `INSERT INTO sheet_db_workflow_command (
      command_id, run_id, kind, payload, status, attempts, available_at,
      lease_owner, lease_token, lease_until, delivered_at, last_error,
      created_at, updated_at
    ) VALUES (
      $1, $2, 'start', $3, 'pending', 0, $4,
      NULL, 0, NULL, NULL, NULL, $5, $5
    )
    ON CONFLICT (command_id) DO NOTHING`,
    [`start:${authoritativeRunId}`, authoritativeRunId, input.payload, runAfter, now],
  );
};

/**
 * Enqueues from the transaction already owned by a Zero mutator. A domain
 * mutator can perform its own writes first and call this helper before
 * returning; Zero commits both the domain state and workflow intent together.
 */
export const enqueueWorkflowInZeroTransaction = (
  tx: Transaction<SheetZeroSchema>,
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

export const mutateWithWorkflow = async (
  tx: Transaction<SheetZeroSchema>,
  context: WorkflowZeroContext,
  input: WorkflowEnqueueRequest,
  mutateDomain: (tx: Transaction<SheetZeroSchema>) => Promise<void>,
) => {
  await mutateDomain(tx);
  await enqueueWorkflowInZeroTransaction(tx, context, input);
};

type WorkflowCommandInput = {
  readonly commandId: string;
  readonly runId: string;
  readonly kind: "cancel" | "event" | "resume";
  readonly payload: typeof ReadonlyJSONValue.Type;
  readonly availableAt?: number | undefined;
};

const validateExistingCommand = (existingCommand: unknown, input: WorkflowCommandInput) => {
  const runId = requireStringProperty(
    existingCommand,
    "run_id",
    `Workflow command "${input.commandId}" already belongs to another workflow run`,
  );
  if (runId !== input.runId) {
    throw new Error(
      `Workflow command "${input.commandId}" already belongs to another workflow run`,
    );
  }
  const kind = requireStringProperty(
    existingCommand,
    "kind",
    `Workflow command "${input.commandId}" already exists with a different kind`,
  );
  if (kind !== input.kind) {
    throw new Error(`Workflow command "${input.commandId}" already exists with a different kind`);
  }
  if (!hasTrueProperty(existingCommand, "payload_matches")) {
    throw new Error(
      `Workflow command "${input.commandId}" already exists with a different payload`,
    );
  }
};

const enqueueCommandAuthoritative = async (
  tx: Extract<Transaction<SheetZeroSchema>, { readonly location: "server" }>,
  context: WorkflowZeroContext,
  input: WorkflowCommandInput,
) => {
  const now = new Date();
  const rows = Array.from(
    await tx.dbTransaction.query(
      `WITH target_run AS (
        SELECT run_id
        FROM sheet_db_workflow_run
        WHERE run_id = $6 AND visibility_key = $7
      ), inserted AS (
        INSERT INTO sheet_db_workflow_command (
          command_id, run_id, kind, payload, status, attempts, available_at,
          lease_owner, lease_token, lease_until, delivered_at, last_error,
          created_at, updated_at
        )
        SELECT $1, run_id, $2, $3, 'pending', 0, $4,
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
        input.payload,
        new Date(input.availableAt ?? now.getTime()),
        now,
        input.runId,
        context.visibilityKey,
      ],
    ),
  );
  const row = rows[0];
  if (!hasTrueProperty(row, "run_exists")) {
    throw new WorkflowRunNotAccessibleError({
      runId: input.runId,
      visibilityKey: context.visibilityKey,
      message: `Workflow run "${input.runId}" was not found for this caller`,
    });
  }
  if (hasTrueProperty(row, "inserted")) {
    return;
  }
  const existingRows = Array.from(
    await tx.dbTransaction.query(
      `SELECT run_id, kind, payload = $2 AS payload_matches
      FROM sheet_db_workflow_command
      WHERE command_id = $1`,
      [input.commandId, input.payload],
    ),
  );
  const existingCommand = existingRows[0];
  validateExistingCommand(existingCommand, input);
};

const enqueueCommandInZeroTransaction = (
  tx: Transaction<SheetZeroSchema>,
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

export const enqueueWorkflowCommandInZeroTransaction = (
  tx: Transaction<SheetZeroSchema>,
  context: WorkflowZeroContext,
  input: WorkflowCommandRequest,
) => enqueueCommandInZeroTransaction(tx, context, input);

export const enqueueWorkflowEventInZeroTransaction = (
  tx: Transaction<SheetZeroSchema>,
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

export const makeRunsGroup = () =>
  ZeroApiGroup.make("runs").add(
    ZeroApiEndpoint.query("get", {
      visibility: "public",
      request: Schema.Struct({ runId: Schema.String }),
      success: Schema.OptionFromNullishOr(publicWorkflowRun),
      query: ({
        args: { runId },
        ctx,
      }: {
        readonly args: { readonly runId: string };
        readonly ctx: WorkflowZeroContext;
      }) =>
        zql.workflowRun
          .where("runId", "=", runId)
          .where("visibilityKey", "=", ctx.visibilityKey)
          .one(),
    }),
    ZeroApiEndpoint.query("list", {
      visibility: "public",
      request: Schema.Struct({
        cursor: Schema.optional(
          Schema.Struct({
            updatedAt: Schema.Number,
            runId: Schema.String,
          }),
        ),
      }),
      success: Schema.Array(publicWorkflowRun),
      query: ({
        args,
        ctx,
      }: {
        readonly args: {
          readonly cursor?:
            | {
                readonly updatedAt: number;
                readonly runId: string;
              }
            | undefined;
        };
        readonly ctx: WorkflowZeroContext;
      }) => {
        const query = zql.workflowRun
          .where("visibilityKey", "=", ctx.visibilityKey)
          .orderBy("updatedAt", "desc")
          .orderBy("runId", "desc")
          .limit(100);
        return Predicate.isUndefined(args.cursor)
          ? query
          : query.start(args.cursor, { inclusive: false });
      },
    }),
    ZeroApiEndpoint.mutator("enqueue", {
      visibility: "internal",
      request: WorkflowEnqueueRequest,
      mutator: ({
        args,
        ctx,
        tx,
      }: {
        readonly args: WorkflowEnqueueRequest;
        readonly ctx: WorkflowZeroContext;
        readonly tx: Transaction<SheetZeroSchema>;
      }) => enqueueWorkflowInZeroTransaction(tx, ctx, args),
    }),
    ZeroApiEndpoint.mutator("enqueueAsCaller", {
      visibility: "service",
      request: DelegatedWorkflowEnqueueRequest,
      mutator: ({
        args,
        tx,
      }: {
        readonly args: DelegatedWorkflowEnqueueRequest;
        readonly ctx: WorkflowZeroContext;
        readonly tx: Transaction<SheetZeroSchema>;
      }) =>
        enqueueWorkflowInZeroTransaction(
          tx,
          {
            principalId: args.caller.principalId,
            visibilityKey: `account:${args.caller.principalId}`,
          },
          args.workflow,
        ),
    }),
    ZeroApiEndpoint.mutator("command", {
      visibility: "internal",
      request: WorkflowCommandRequest,
      mutator: ({
        args,
        ctx,
        tx,
      }: {
        readonly args: WorkflowCommandRequest;
        readonly ctx: WorkflowZeroContext;
        readonly tx: Transaction<SheetZeroSchema>;
      }) => enqueueWorkflowCommandInZeroTransaction(tx, ctx, args),
    }),
    ZeroApiEndpoint.mutator("sendEvent", {
      visibility: "internal",
      request: WorkflowEventRequest,
      mutator: ({
        args,
        ctx,
        tx,
      }: {
        readonly args: WorkflowEventRequest;
        readonly ctx: WorkflowZeroContext;
        readonly tx: Transaction<SheetZeroSchema>;
      }) => enqueueWorkflowEventInZeroTransaction(tx, ctx, args),
    }),
  );

export type RunsGroup = ReturnType<typeof makeRunsGroup>;

export const isWorkflowZeroContext = (value: unknown): value is WorkflowZeroContext =>
  Predicate.isObject(value) &&
  Predicate.hasProperty("principalId")(value) &&
  Predicate.isString(value.principalId) &&
  Predicate.hasProperty("visibilityKey")(value) &&
  Predicate.isString(value.visibilityKey);
