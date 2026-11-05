import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Option } from "effect";
import { RunnerAddress, ShardingConfig } from "effect/unstable/cluster";
import {
  assignedSheetWorkflowShardGroups,
  clientOnlyWorkflowShardingConfig,
  shardingConfigLayer,
} from "./runtime";

it.effect("uses expiry-aware database shard locks", () =>
  Effect.gen(function* () {
    const shardingConfig = yield* ShardingConfig.ShardingConfig;

    expect(shardingConfig.shardLockDisableAdvisory).toBe(true);
    expect(shardingConfig.shardsPerGroup).toBe(300);
    expect(shardingConfig.assignedShardGroups).toEqual(["dispatch", "autoCheckin"]);
    expect(shardingConfig.availableShardGroups).toContain("dispatch");
    expect(shardingConfig.availableShardGroups).toContain("autoCheckin");
    expect(shardingConfig.availableShardGroups).toContain("browser");
    expect(shardingConfig.availableShardGroups).toContain(
      shardingConfig.assignedShardGroups.at(-1),
    );
    expect(shardingConfig.availableShardGroups.at(-1)).toMatch(
      /^browser-capability-v1-[a-f0-9]{64}$/,
    );
  }).pipe(
    Effect.provide(shardingConfigLayer),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          POSTGRES_URL: "postgres://workflows:test@127.0.0.1:5432/workflows",
          WORKFLOWS_RUNNER_HOST: "sheet-workflows-runner",
        }),
      ),
    ),
  ),
);

it("isolates browser capability on the browser-runner shard group", () => {
  expect(assignedSheetWorkflowShardGroups("runner")).toEqual(["dispatch", "autoCheckin"]);
  expect(assignedSheetWorkflowShardGroups("api")).toEqual(["dispatch", "autoCheckin"]);
  expect(assignedSheetWorkflowShardGroups("producer")).toEqual([]);
  expect(assignedSheetWorkflowShardGroups("combined")).toEqual(["dispatch", "autoCheckin"]);
  expect(assignedSheetWorkflowShardGroups("browser-runner")).toEqual(["browser"]);
});

it.effect("assigns the scoped capability group only to the browser runner", () =>
  Effect.gen(function* () {
    const shardingConfig = yield* ShardingConfig.ShardingConfig;
    const browserCapabilityGroup = shardingConfig.availableShardGroups.find((group) =>
      group.startsWith("browser-capability-v1-"),
    );

    expect(browserCapabilityGroup).toMatch(/^browser-capability-v1-[a-f0-9]{64}$/);
    expect(shardingConfig.assignedShardGroups).toEqual(["browser", browserCapabilityGroup]);
  }).pipe(
    Effect.provide(shardingConfigLayer),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          POSTGRES_URL: "postgres://workflows:test@127.0.0.1:5432/workflows",
          SHEET_WORKFLOWS_ROLE: "browser-runner",
          WORKFLOWS_RUNNER_HOST: "sheet-workflows-browser-runner",
        }),
      ),
    ),
  ),
);

describe("clientOnlyWorkflowShardingConfig", () => {
  it("prevents workflow API clients from registering as runners", () => {
    const runnerAddress = RunnerAddress.make("sheet-workflows-runner", 34431);
    const runnerListenAddress = RunnerAddress.make("0.0.0.0", 34431);
    const current = {
      ...ShardingConfig.defaults,
      runnerAddress: Option.some(runnerAddress),
      runnerListenAddress: Option.some(runnerListenAddress),
    };

    const next = clientOnlyWorkflowShardingConfig(current);

    expect(Option.isNone(next.runnerAddress)).toBe(true);
    expect(next.runnerListenAddress).toBe(current.runnerListenAddress);
    expect(current.runnerAddress).toEqual(Option.some(runnerAddress));
  });
});
