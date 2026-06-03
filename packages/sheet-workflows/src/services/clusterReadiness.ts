import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { config } from "@/config";

type ClusterReadinessRow = {
  readonly ready: boolean;
};

const ClusterRunnerReadinessSnapshotRowSchema = Schema.Struct({
  address: Schema.String,
  hasRecentHealthyRunner: Schema.Boolean,
  heldLockCount: Schema.Number,
  totalRunnerCount: Schema.Number,
  totalLockCount: Schema.Number,
});

type ClusterRunnerReadinessSnapshotDbRow = {
  readonly address: string;
  readonly hasRecentHealthyRunner: boolean;
  readonly heldLockCount: number;
  readonly totalRunnerCount: number;
  readonly totalLockCount: number;
};

const configuredRunnerAddress = Effect.gen(function* () {
  const host = yield* config.workflowsRunnerHost;
  const port = yield* config.workflowsRunnerPort;
  return `${host}:${port}`;
});

export const isClusterRunnerReady = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const address = yield* configuredRunnerAddress;
  const [row] = yield* sql<ClusterReadinessRow>`
    SELECT EXISTS (
      SELECT 1
      FROM "sheet_workflows_runners"
      WHERE "sheet_workflows_runners".address = ${address}
        AND "sheet_workflows_runners".healthy = TRUE
        AND "sheet_workflows_runners".last_heartbeat > NOW() - INTERVAL '35 seconds'
    ) AS ready
  `;
  return row?.ready === true;
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("Failed to verify sheet-workflows runner readiness", cause).pipe(
      Effect.as(false),
    ),
  ),
  Effect.withSpan("sheet-workflows.runner.ready"),
);

export const getClusterRunnerReadinessSnapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const address = yield* configuredRunnerAddress;
  const [row] = yield* sql<ClusterRunnerReadinessSnapshotDbRow>`
    SELECT
      ${address} AS address,
      EXISTS (
        SELECT 1
        FROM "sheet_workflows_runners"
        WHERE "sheet_workflows_runners".address = ${address}
          AND "sheet_workflows_runners".healthy = TRUE
          AND "sheet_workflows_runners".last_heartbeat > NOW() - INTERVAL '35 seconds'
      ) AS "hasRecentHealthyRunner",
      (
        SELECT COUNT(*)::int
        FROM "sheet_workflows_locks"
        WHERE "sheet_workflows_locks".address = ${address}
      ) AS "heldLockCount",
      (
        SELECT COUNT(*)::int
        FROM "sheet_workflows_runners"
      ) AS "totalRunnerCount",
      (
        SELECT COUNT(*)::int
        FROM "sheet_workflows_locks"
      ) AS "totalLockCount"
  `;
  return yield* Schema.decodeUnknownEffect(ClusterRunnerReadinessSnapshotRowSchema)(row);
}).pipe(Effect.withSpan("sheet-workflows.runner.readinessSnapshot"));
