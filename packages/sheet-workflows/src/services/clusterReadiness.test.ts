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
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(SqlClient.SqlClient, fakeSql(rows, options.queries)),
      Effect.provide(configLayer(options.env)),
    ) as Effect.Effect<boolean>,
  );

describe("cluster readiness", () => {
  it("marks the current runner ready when its healthy heartbeat is recent", async () => {
    const queries: string[] = [];
    const ready = await runReadiness(isCurrentClusterRunnerReady, [{ ready: true }], { queries });

    expect(ready).toBe(true);
    const query = queries.join("\n");
    expect(query).toContain('"sheet_workflows_runners".address = ?');
    expect(query).not.toContain("sheet_workflows_locks");
  });

  it("marks the current runner unready when it has no recent healthy heartbeat", async () => {
    await expect(runReadiness(isCurrentClusterRunnerReady, [{ ready: false }])).resolves.toBe(
      false,
    );
  });

  it("marks the current runner unready when its heartbeat is stale", async () => {
    await expect(runReadiness(isCurrentClusterRunnerReady, [{ ready: false }])).resolves.toBe(
      false,
    );
  });

  it("marks the runner fleet ready when any healthy runner has a recent heartbeat", async () => {
    const queries: string[] = [];
    const ready = await runReadiness(isClusterRunnerFleetReady, [{ ready: true }], { queries });

    expect(ready).toBe(true);
    const query = queries.join("\n");
    expect(query).toContain('"sheet_workflows_runners"');
    expect(query).not.toContain("sheet_workflows_locks");
  });

  it("marks the runner fleet unready when no healthy runner has a recent heartbeat", async () => {
    await expect(runReadiness(isClusterRunnerFleetReady, [{ ready: false }])).resolves.toBe(false);
  });

  it("uses fleet readiness for api role", async () => {
    const queries: string[] = [];
    const ready = await runReadiness(isWorkflowApiReady, [{ ready: true }], {
      env: { SHEET_WORKFLOWS_ROLE: "api" },
      queries,
    });

    expect(ready).toBe(true);
    expect(queries.join("\n")).not.toContain('"sheet_workflows_runners".address = ?');
  });

  it("uses current runner readiness for combined role", async () => {
    const queries: string[] = [];
    const ready = await runReadiness(isWorkflowApiReady, [{ ready: true }], {
      env: { SHEET_WORKFLOWS_ROLE: "combined" },
      queries,
    });

    expect(ready).toBe(true);
    expect(queries.join("\n")).toContain('"sheet_workflows_runners".address = ?');
  });

  it("uses current runner readiness for runner role", async () => {
    const queries: string[] = [];
    const ready = await runReadiness(isWorkflowApiReady, [{ ready: true }], {
      env: { SHEET_WORKFLOWS_ROLE: "runner" },
      queries,
    });

    expect(ready).toBe(true);
    expect(queries.join("\n")).toContain('"sheet_workflows_runners".address = ?');
  });
});
