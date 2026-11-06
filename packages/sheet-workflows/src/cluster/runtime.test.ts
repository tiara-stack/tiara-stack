import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Option } from "effect";
import { RunnerAddress, ShardingConfig } from "effect/unstable/cluster";
import { sheetWorkflowsRuntimePolicy } from "@/config/runtimePolicy";
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
    expect(shardingConfig.availableShardGroups.at(-1)).toMatch(/^brcap-v1-[a-f0-9]{32}$/);
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

it.effect("loads one pinned browser capability identity for every workflow role", () =>
  Effect.gen(function* () {
    const roles = ["api", "producer", "runner", "browser-runner"] as const;
    const sharedConfig = {
      POSTGRES_URL: "postgres://workflows:test@127.0.0.1:5432/workflows",
      WORKFLOWS_RUNNER_HOST: "sheet-workflows-runner",
    };
    const loadedPolicy = yield* sheetWorkflowsRuntimePolicy.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ ...sharedConfig, SHEET_WORKFLOWS_ROLE: "api" }),
        ),
      ),
    );
    const roleConfigs = yield* Effect.forEach(roles, (role) =>
      ShardingConfig.ShardingConfig.pipe(
        Effect.provide(shardingConfigLayer),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              ...sharedConfig,
              SHEET_WORKFLOWS_ROLE: role,
              ...(role === "producer"
                ? {
                    WORKFLOWS_STATE_PLANE_POLICY: "shared-admission",
                    WORKFLOWS_PREVIEW_CATALOG_DIGEST: loadedPolicy.workflowContractCatalogDigest,
                    WORKFLOWS_PREVIEW_SCHEMA_ARTIFACT_DIGEST: loadedPolicy.schemaArtifactDigest,
                  }
                : {}),
            }),
          ),
        ),
        Effect.map((shardingConfig) => {
          const capabilityGroup = shardingConfig.availableShardGroups.find((group) =>
            group.startsWith("brcap-v1-"),
          );
          if (capabilityGroup === undefined) throw new Error("Browser capability group is absent");
          expect(shardingConfig.shardsPerGroup).toBe(300);
          return { role, shardingConfig, capabilityGroup };
        }),
      ),
    );
    const capabilityGroups = new Set(roleConfigs.map(({ capabilityGroup }) => capabilityGroup));

    expect(capabilityGroups.size).toBe(1);
    for (const { role, shardingConfig, capabilityGroup } of roleConfigs) {
      expect(shardingConfig.assignedShardGroups.includes(capabilityGroup)).toBe(
        role === "browser-runner",
      );
    }
  }),
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
      group.startsWith("brcap-v1-"),
    );

    expect(browserCapabilityGroup).toMatch(/^brcap-v1-[a-f0-9]{32}$/);
    expect(shardingConfig.assignedShardGroups).toEqual(["browser", browserCapabilityGroup]);
    expect(shardingConfig.assignedShardGroups.length * shardingConfig.shardsPerGroup).toBe(600);
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
