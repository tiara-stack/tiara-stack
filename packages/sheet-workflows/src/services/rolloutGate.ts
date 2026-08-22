import { Context, Duration, Effect, Layer, Metric, Predicate, Schedule, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { ActorProvenance, EffectivePrincipal } from "sheet-auth/identity";
import { ownerKeyForEffectivePrincipal } from "@/workflows/readOnly/authorization";
import {
  RolloutGateAllPrincipalsKey,
  RolloutGateChangeResponse,
  RolloutGateDecision,
  RolloutGateExecutionPath,
  type RolloutGateChangeRequest as RolloutGateChangeRequestType,
  type RolloutGateEvaluationRequest,
  type RolloutGateExecutionPath as RolloutGateExecutionPathType,
  type RolloutGateScope,
} from "sheet-workflow-contracts";
import { selectRolloutGateDecision, type RolloutGateDecisionValue } from "./rolloutGateDecision";

const rolloutGateTable = "sheet_db_rollout_gate";
const rolloutGateEvaluationTable = "sheet_db_rollout_gate_evaluation";
const rolloutGateDecisionTable = "sheet_db_rollout_gate_decision";
const rolloutGateEvaluationRetentionDays = 7;
const rolloutGateEvaluationCleanupBatchSize = 1_000;
const rolloutGateEvaluationCleanupMaxBatchesPerRun = 10;
const rolloutGateEvaluationCleanupInterval = Duration.hours(1);
const rolloutGateFallbacks = Metric.counter("sheet_workflows_rollout_gate_fallbacks_total", {
  description: "Rollout Gate evaluations that selected the legacy path as a fallback",
  incremental: true,
});

export interface RolloutGateEvaluationInput extends RolloutGateEvaluationRequest {
  readonly effectivePrincipal: EffectivePrincipal;
  readonly actorProvenance?: ActorProvenance | undefined;
}

interface RolloutGateChangeInput extends RolloutGateChangeRequestType {
  readonly changedBy: EffectivePrincipal;
  readonly actorProvenance?: ActorProvenance | undefined;
}

type NormalizedRolloutGateChangeInput = Omit<RolloutGateChangeInput, "effectivePrincipalKey"> & {
  readonly effectivePrincipalKey: string;
};

export class RolloutGateRevisionConflict extends Schema.TaggedErrorClass<RolloutGateRevisionConflict>()(
  "RolloutGateRevisionConflict",
  {
    gateKey: Schema.String,
    expectedRevision: Schema.Number,
    currentRevision: Schema.Number,
    message: Schema.String,
  },
) {}

export class RolloutGateStorageFailure extends Schema.TaggedErrorClass<RolloutGateStorageFailure>()(
  "RolloutGateStorageFailure",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

interface RolloutGateControlShape {
  /** Rollout Gate evaluation always returns a decision; control failures select the legacy path. */
  readonly evaluate: (
    input: RolloutGateEvaluationInput,
  ) => Effect.Effect<Schema.Schema.Type<typeof RolloutGateDecision>>;
  readonly change: (
    input: RolloutGateChangeInput,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof RolloutGateChangeResponse>,
    RolloutGateRevisionConflict | RolloutGateStorageFailure
  >;
}

type RolloutGateControlRow = {
  readonly gateKey: string;
  readonly revision: number;
  readonly executionPath: RolloutGateExecutionPathType;
  readonly reason: string;
};

type RolloutGateControlStorageRow = Omit<RolloutGateControlRow, "executionPath"> & {
  readonly executionPath: string;
};

type RolloutGateChangeRow = {
  readonly gateKey: string;
  readonly revision: number;
  readonly executionPath: string;
};

type RolloutGateEvaluationMatch = {
  readonly gateKey: string;
  readonly row: RolloutGateControlRow;
};

type RolloutGateEvaluationStorageRow = {
  readonly gateKey: string;
  readonly revision: number;
  readonly executionPath: string;
  readonly matched: boolean;
  readonly reason: string;
};

type RolloutGateEvaluationResult = {
  readonly decision: RolloutGateDecisionValue;
  readonly recorded: boolean;
};

const jsonb = (value: unknown) => JSON.stringify(value);

// Persisted contract: this string is stored as `sheet_db_rollout_gate.gate_key`.
// Any field addition, removal, or reorder requires a backfill migration for existing rows.
export const scopeKey = (scope: RolloutGateScope, effectivePrincipalKey: string) =>
  JSON.stringify([
    scope.contractIdentity,
    scope.contractWireVersion,
    scope.client.platform,
    scope.client.clientId,
    scope.workspaceId ?? null,
    effectivePrincipalKey,
  ]);

export const evaluationControlKeys = (input: RolloutGateEvaluationInput) => {
  const effectivePrincipalKey = ownerKeyForEffectivePrincipal(input.effectivePrincipal);
  const scopes = Predicate.isUndefined(input.workspaceId)
    ? [input]
    : [input, { ...input, workspaceId: undefined }];

  return [
    ...new Set(
      scopes.flatMap((scope) => [
        scopeKey(scope, effectivePrincipalKey),
        scopeKey(scope, RolloutGateAllPrincipalsKey),
      ]),
    ),
  ];
};

const readControl = (sql: SqlClient.SqlClient, gateKey: string) =>
  Effect.gen(function* () {
    const [row] = yield* sql<RolloutGateControlStorageRow>`
      SELECT
        "gate_key" AS "gateKey",
        "revision",
        "execution_path" AS "executionPath",
        "reason"
      FROM ${sql(rolloutGateTable)}
      WHERE "gate_key" = ${gateKey}
    `;
    if (Predicate.isUndefined(row)) {
      return undefined;
    }

    const executionPath = yield* Schema.decodeUnknownEffect(RolloutGateExecutionPath)(
      row.executionPath,
    );
    return { ...row, executionPath } satisfies RolloutGateControlRow;
  });

const readMatchingControl = (sql: SqlClient.SqlClient, input: RolloutGateEvaluationInput) =>
  Effect.gen(function* () {
    const candidateKeys = evaluationControlKeys(input);
    const rows = yield* sql<RolloutGateControlStorageRow>`
      SELECT
        "gate_key" AS "gateKey",
        "revision",
        "execution_path" AS "executionPath",
        "reason"
      FROM ${sql(rolloutGateTable)}
      WHERE "gate_key" IN ${sql.in(candidateKeys)}
    `;

    for (const gateKey of candidateKeys) {
      const row = rows.find((candidate) => candidate.gateKey === gateKey);
      if (Predicate.isNotUndefined(row)) {
        const executionPath = yield* Schema.decodeUnknownEffect(RolloutGateExecutionPath)(
          row.executionPath,
        );
        return { gateKey, row: { ...row, executionPath } } satisfies RolloutGateEvaluationMatch;
      }
    }
    return undefined;
  });

const decodeEvaluationStorageRow = (row: RolloutGateEvaluationStorageRow) =>
  Schema.decodeUnknownEffect(RolloutGateDecision)({
    gateKey: row.gateKey,
    revision: row.revision,
    executionPath: row.executionPath,
    matched: row.matched,
    reason: row.reason,
  });

const readEvaluation = (sql: SqlClient.SqlClient, invocationId: string) =>
  Effect.gen(function* () {
    const [row] = yield* sql<RolloutGateEvaluationStorageRow>`
      SELECT
        "gate_key" AS "gateKey",
        "gate_revision" AS "revision",
        "execution_path" AS "executionPath",
        "matched",
        "reason"
      FROM ${sql(rolloutGateEvaluationTable)}
      WHERE "invocation_id" = ${invocationId}
    `;
    return Predicate.isUndefined(row) ? undefined : yield* decodeEvaluationStorageRow(row);
  });

const insertEvaluation = (
  sql: SqlClient.SqlClient,
  input: RolloutGateEvaluationInput,
  decision: RolloutGateDecisionValue,
) => {
  const actorProvenance = input.actorProvenance;
  return Effect.gen(function* () {
    const [row] = yield* sql<RolloutGateEvaluationStorageRow>`
    INSERT INTO ${sql(rolloutGateEvaluationTable)} (
      "evaluation_id",
      "invocation_id",
      "gate_key",
      "gate_revision",
      "contract_identity",
      "contract_wire_version",
      "client_platform",
      "client_id",
      "workspace_id",
      "effective_principal_key",
      "execution_path",
      "matched",
      "reason",
      "effective_principal",
      "actor_provenance",
      "evaluated_at"
    ) VALUES (
      ${globalThis.crypto.randomUUID()},
      ${input.invocationId},
      ${decision.gateKey},
      ${decision.revision},
      ${input.contractIdentity},
      ${input.contractWireVersion},
      ${input.client.platform},
      ${input.client.clientId},
      ${input.workspaceId ?? null},
      ${ownerKeyForEffectivePrincipal(input.effectivePrincipal)},
      ${decision.executionPath},
      ${decision.matched},
      ${decision.reason},
      ${jsonb(input.effectivePrincipal)}::jsonb,
      ${Predicate.isUndefined(actorProvenance) ? null : jsonb(actorProvenance)}::jsonb,
      NOW()
    )
    ON CONFLICT ("invocation_id") DO NOTHING
    RETURNING
      "gate_key" AS "gateKey",
      "gate_revision" AS "revision",
      "execution_path" AS "executionPath",
      "matched",
      "reason"
  `;
    return Predicate.isUndefined(row) ? undefined : yield* decodeEvaluationStorageRow(row);
  });
};

const upsertControl = (
  sql: SqlClient.SqlClient,
  input: NormalizedRolloutGateChangeInput,
  gateKey: string,
) => sql<RolloutGateChangeRow>`
  INSERT INTO ${sql(rolloutGateTable)} (
    "gate_key",
    "contract_identity",
    "contract_wire_version",
    "client_platform",
    "client_id",
    "workspace_id",
    "effective_principal_key",
    "execution_path",
    "revision",
    "reason",
    "evidence_url",
    "changed_by",
    "updated_at"
  ) VALUES (
    ${gateKey},
    ${input.contractIdentity},
    ${input.contractWireVersion},
    ${input.client.platform},
    ${input.client.clientId},
    ${input.workspaceId ?? null},
    ${input.effectivePrincipalKey},
    ${input.executionPath},
    1,
    ${input.reason},
    ${input.evidenceUrl},
    ${jsonb(input.changedBy)}::jsonb,
    NOW()
  )
  ON CONFLICT ("gate_key") DO UPDATE SET
    "execution_path" = EXCLUDED."execution_path",
    "revision" = ${sql(rolloutGateTable)}."revision" + 1,
    "reason" = EXCLUDED."reason",
    "evidence_url" = EXCLUDED."evidence_url",
    "changed_by" = EXCLUDED."changed_by",
    "updated_at" = NOW()
  WHERE ${sql(rolloutGateTable)}."revision" = ${input.expectedRevision}
  RETURNING
    "gate_key" AS "gateKey",
    "revision",
    "execution_path" AS "executionPath"
`;

const insertDecision = (
  sql: SqlClient.SqlClient,
  input: NormalizedRolloutGateChangeInput,
  row: RolloutGateChangeRow,
) => {
  const actorProvenance = input.actorProvenance;
  return sql`
    INSERT INTO ${sql(rolloutGateDecisionTable)} (
      "decision_id",
      "gate_key",
      "gate_revision",
      "contract_identity",
      "contract_wire_version",
      "client_platform",
      "client_id",
      "workspace_id",
      "effective_principal_key",
      "execution_path",
      "reason",
      "evidence_url",
      "changed_by",
      "actor_provenance",
      "decided_at"
    ) VALUES (
      ${globalThis.crypto.randomUUID()},
      ${row.gateKey},
      ${row.revision},
      ${input.contractIdentity},
      ${input.contractWireVersion},
      ${input.client.platform},
      ${input.client.clientId},
      ${input.workspaceId ?? null},
      ${input.effectivePrincipalKey},
      ${row.executionPath},
      ${input.reason},
      ${input.evidenceUrl},
      ${jsonb(input.changedBy)}::jsonb,
      ${Predicate.isUndefined(actorProvenance) ? null : jsonb(actorProvenance)}::jsonb,
      NOW()
    )
  `;
};

const revisionConflict = (gateKey: string, expectedRevision: number, currentRevision: number) =>
  new RolloutGateRevisionConflict({
    gateKey,
    expectedRevision,
    currentRevision,
    message: "Rollout Gate Control revision does not match",
  });

const validateExpectedRevision = (
  gateKey: string,
  input: RolloutGateChangeInput,
  current: RolloutGateControlRow | undefined,
) =>
  (Predicate.isUndefined(current) && input.expectedRevision !== 0) ||
  (Predicate.isNotUndefined(current) && current.revision !== input.expectedRevision)
    ? Effect.fail(revisionConflict(gateKey, input.expectedRevision, current?.revision ?? 0))
    : Effect.void;

const requireChangeRow = (
  sql: SqlClient.SqlClient,
  gateKey: string,
  input: RolloutGateChangeInput,
  row: RolloutGateChangeRow | undefined,
) =>
  Effect.gen(function* () {
    if (Predicate.isUndefined(row)) {
      const latest = yield* readControl(sql, gateKey);
      return yield* Effect.fail(
        revisionConflict(gateKey, input.expectedRevision, latest?.revision ?? 0),
      );
    }
    return row;
  });

export class RolloutGateControl extends Context.Service<
  RolloutGateControl,
  RolloutGateControlShape
>()("RolloutGateControl", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const cleanupExpiredEvaluationsBatch = sql`
      WITH expired AS (
        SELECT "evaluation_id"
        FROM ${sql(rolloutGateEvaluationTable)}
        WHERE "evaluated_at" < NOW() - (${rolloutGateEvaluationRetentionDays} * INTERVAL '1 day')
        ORDER BY "evaluated_at"
        LIMIT ${rolloutGateEvaluationCleanupBatchSize}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM ${sql(rolloutGateEvaluationTable)} AS evaluation
      USING expired
      WHERE evaluation."evaluation_id" = expired."evaluation_id"
      RETURNING evaluation."evaluation_id"
    `.pipe(Effect.map((rows) => rows.length));

    const cleanupExpiredEvaluations = cleanupExpiredEvaluationsBatch.pipe(
      Effect.repeat({
        times: rolloutGateEvaluationCleanupMaxBatchesPerRun - 1,
        until: (deleted) => deleted < rolloutGateEvaluationCleanupBatchSize,
      }),
      Effect.asVoid,
    );

    yield* cleanupExpiredEvaluations.pipe(
      Effect.catch((error) =>
        Effect.logWarning("Rollout Gate Evaluation retention cleanup failed", {
          error,
        }),
      ),
      Effect.repeat(Schedule.spaced(rolloutGateEvaluationCleanupInterval)),
      Effect.forkScoped,
    );

    const fallbackDecision = (
      input: RolloutGateEvaluationInput,
      reason: "control-unavailable" | "unconfigured",
    ) =>
      selectRolloutGateDecision({
        gateKey: scopeKey(input, ownerKeyForEffectivePrincipal(input.effectivePrincipal)),
        fallbackReason: reason,
      });

    const recordUnconfiguredFallback = (decision: RolloutGateDecisionValue) =>
      decision.matched
        ? Effect.void
        : Metric.update(
            Metric.withAttributes(rolloutGateFallbacks, {
              reason: "unconfigured",
            }),
            1,
          );

    const evaluate = (input: RolloutGateEvaluationInput) => {
      return sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* readEvaluation(sql, input.invocationId);
            if (Predicate.isNotUndefined(existing)) {
              return { decision: existing, recorded: false } satisfies RolloutGateEvaluationResult;
            }

            const match = yield* readMatchingControl(sql, input);
            const decision = Predicate.isUndefined(match)
              ? fallbackDecision(input, "unconfigured")
              : selectRolloutGateDecision({ gateKey: match.gateKey, row: match.row });
            const inserted = yield* insertEvaluation(sql, input, decision);
            if (Predicate.isNotUndefined(inserted)) {
              return { decision: inserted, recorded: true } satisfies RolloutGateEvaluationResult;
            }

            const persisted = yield* readEvaluation(sql, input.invocationId);
            if (Predicate.isUndefined(persisted)) {
              return yield* Effect.fail(
                new Error("Rollout Gate Evaluation conflict did not return a persisted record"),
              );
            }
            return { decision: persisted, recorded: false } satisfies RolloutGateEvaluationResult;
          }),
        )
        .pipe(
          Effect.tap(({ decision, recorded }) =>
            recorded ? recordUnconfiguredFallback(decision) : Effect.void,
          ),
          Effect.map(({ decision }) => decision),
          Effect.catch((error) =>
            Effect.logError("Rollout Gate Control is unavailable; selecting legacy", {
              failure: Schema.isSchemaError(error)
                ? "rollout-gate-persisted-decision-invalid"
                : "rollout-gate-control-unavailable",
              error,
              contractIdentity: input.contractIdentity,
              invocationId: input.invocationId,
              wireVersion: input.contractWireVersion,
            }).pipe(
              Effect.andThen(
                Metric.update(
                  Metric.withAttributes(rolloutGateFallbacks, {
                    reason: "control-unavailable",
                  }),
                  1,
                ),
              ),
              Effect.as(fallbackDecision(input, "control-unavailable")),
            ),
          ),
          Effect.withSpan("sheet-workflows.rolloutGate.evaluate"),
        );
    };

    const change = (input: RolloutGateChangeInput) => {
      const normalizedInput: NormalizedRolloutGateChangeInput = {
        ...input,
        effectivePrincipalKey: input.effectivePrincipalKey ?? RolloutGateAllPrincipalsKey,
      };
      const gateKey = scopeKey(normalizedInput, normalizedInput.effectivePrincipalKey);

      return sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* readControl(sql, gateKey);
            yield* validateExpectedRevision(gateKey, normalizedInput, current);

            const row = yield* requireChangeRow(
              sql,
              gateKey,
              normalizedInput,
              (yield* upsertControl(sql, normalizedInput, gateKey))[0],
            );

            yield* insertDecision(sql, normalizedInput, row);

            return yield* Schema.decodeUnknownEffect(RolloutGateChangeResponse)({
              gateKey: row.gateKey,
              revision: row.revision,
              executionPath: row.executionPath,
            });
          }),
        )
        .pipe(
          Effect.tapCause(() =>
            Effect.logError("Rollout Gate Control change failed", {
              failure: "rollout-gate-control-change-failed",
              contractIdentity: normalizedInput.contractIdentity,
              contractWireVersion: normalizedInput.contractWireVersion,
              clientPlatform: normalizedInput.client.platform,
              clientId: normalizedInput.client.clientId,
              expectedRevision: normalizedInput.expectedRevision,
            }),
          ),
          Effect.mapError((error) =>
            Predicate.isTagged("RolloutGateRevisionConflict")(error)
              ? error
              : new RolloutGateStorageFailure({
                  message: "Rollout Gate Control change failed",
                  cause: error,
                }),
          ),
          Effect.withSpan("sheet-workflows.rolloutGate.change"),
        );
    };

    return { evaluate, change } satisfies RolloutGateControlShape;
  }),
}) {
  static layer = Layer.effect(RolloutGateControl, this.make);
}

export const rolloutGateControlLayer = RolloutGateControl.layer;
