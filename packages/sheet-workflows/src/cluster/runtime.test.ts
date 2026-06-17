import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { RunnerAddress, ShardingConfig } from "effect/unstable/cluster";
import { clientOnlyWorkflowShardingConfig } from "./runtime";

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
