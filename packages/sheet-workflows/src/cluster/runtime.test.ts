import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Option } from "effect";
import { RunnerAddress, ShardingConfig } from "effect/unstable/cluster";
import { clientOnlyWorkflowShardingConfig, shardingConfigLayer } from "./runtime";

it.effect("uses expiry-aware database shard locks", () =>
  Effect.gen(function* () {
    const shardingConfig = yield* ShardingConfig.ShardingConfig;

    expect(shardingConfig.shardLockDisableAdvisory).toBe(true);
    expect(shardingConfig.shardsPerGroup).toBe(300);
    expect(shardingConfig.availableShardGroups).toEqual(["dispatch", "autoCheckin"]);
  }).pipe(
    Effect.provide(shardingConfigLayer),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          WORKFLOWS_RUNNER_HOST: "sheet-workflows-runner",
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
