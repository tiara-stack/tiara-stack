import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  isClusterRunnerFleetReady,
  isCurrentClusterRunnerReady,
  isWorkflowApiReady,
} from "./clusterReadiness";

const configLayer = (env: Record<string, unknown> = {}) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      WORKFLOWS_RUNNER_HOST: "10.0.0.12",
      WORKFLOWS_RUNNER_PORT: "34431",
      ...env,
    }),
  );

const fakeSql = (rows: readonly unknown[], queries: string[] = []): SqlClient.SqlClient =>
  ((strings: TemplateStringsArray) => {
    queries.push(strings.join("?"));
    return Effect.succeed(rows);
  }) as unknown as SqlClient.SqlClient;

const runReadiness = (
  effect: Effect.Effect<boolean, unknown, SqlClient.SqlClient>,
  rows: readonly unknown[],
  options: {
    readonly env?: Record<string, unknown>;
    readonly queries?: string[];
  } = {},
) =>
  effect.pipe(
    Effect.provideService(SqlClient.SqlClient, fakeSql(rows, options.queries)),
    Effect.provide(configLayer(options.env)),
  ) as Effect.Effect<boolean>;

describe("cluster readiness", () => {
  it.effect("marks the current runner ready when its healthy heartbeat is recent", () =>
    Effect.gen(function* () {
      const queries: string[] = [];
      const ready = yield* runReadiness(isCurrentClusterRunnerReady, [{ ready: true }], {
        queries,
      });

      expect(ready).toBe(true);
      const query = queries.join("\n");
      expect(query).toContain('"sheet_workflows_runners".address = ?');
      expect(query).toContain('"sheet_workflows_locks".address = ?');
      expect(query).toContain(") = ?");
      const lockCountSubquery = query.split("SELECT COUNT(*)")[1]?.split(") = ?")[0];
      expect(lockCountSubquery).toContain('"sheet_workflows_locks".address = ?');
    }),
  );

  it.effect("marks the current runner unready when it has no recent healthy heartbeat", () =>
    Effect.gen(function* () {
      expect(yield* runReadiness(isCurrentClusterRunnerReady, [{ ready: false }])).toBe(false);
    }),
  );

  it.effect("marks the current runner unready when its heartbeat is stale", () =>
    Effect.gen(function* () {
      expect(yield* runReadiness(isCurrentClusterRunnerReady, [{ ready: false }])).toBe(false);
    }),
  );

  it.effect("marks the runner fleet ready when any healthy runner has a recent heartbeat", () =>
    Effect.gen(function* () {
      const queries: string[] = [];
      const ready = yield* runReadiness(isClusterRunnerFleetReady, [{ ready: true }], { queries });

      expect(ready).toBe(true);
      const query = queries.join("\n");
      expect(query).toContain('FROM "sheet_workflows_runners" AS runner');
      expect(query).toContain('"sheet_workflows_locks".address = runner.address');
      expect(query).toContain(") = ?");
    }),
  );

  it.effect("marks the runner fleet unready when no healthy runner has a recent heartbeat", () =>
    Effect.gen(function* () {
      expect(yield* runReadiness(isClusterRunnerFleetReady, [{ ready: false }])).toBe(false);
    }),
  );

  it.effect("uses fleet readiness for api role", () =>
    Effect.gen(function* () {
      const queries: string[] = [];
      const ready = yield* runReadiness(isWorkflowApiReady, [{ ready: true }], {
        env: { SHEET_WORKFLOWS_ROLE: "api" },
        queries,
      });

      expect(ready).toBe(true);
      expect(queries.join("\n")).not.toContain('"sheet_workflows_runners".address = ?');
    }),
  );

  it.effect("uses current runner readiness for combined role", () =>
    Effect.gen(function* () {
      const queries: string[] = [];
      const ready = yield* runReadiness(isWorkflowApiReady, [{ ready: true }], {
        env: { SHEET_WORKFLOWS_ROLE: "combined" },
        queries,
      });

      expect(ready).toBe(true);
      expect(queries.join("\n")).toContain('"sheet_workflows_runners".address = ?');
    }),
  );

  it.effect("uses current runner readiness for runner role", () =>
    Effect.gen(function* () {
      const queries: string[] = [];
      const ready = yield* runReadiness(isWorkflowApiReady, [{ ready: true }], {
        env: { SHEET_WORKFLOWS_ROLE: "runner" },
        queries,
      });

      expect(ready).toBe(true);
      expect(queries.join("\n")).toContain('"sheet_workflows_runners".address = ?');
    }),
  );
});
