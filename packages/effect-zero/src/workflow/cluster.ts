import { Layer, Option } from "effect";
import {
  ClusterWorkflowEngine,
  HttpRunner,
  MessageStorage,
  RunnerHealth,
  RunnerStorage,
  ShardingConfig,
  SqlMessageStorage,
  SqlRunnerStorage,
} from "effect/unstable/cluster";
import type { HttpRouter } from "effect/unstable/http";
import { RpcSerialization } from "effect/unstable/rpc";

export type ClusterWorkflowStorageOptions = {
  readonly prefix: string;
};

export const clusterWorkflowStorageLayer = (options: ClusterWorkflowStorageOptions) =>
  Layer.mergeAll(
    SqlMessageStorage.layerWith({ prefix: options.prefix }),
    SqlRunnerStorage.layerWith({ prefix: options.prefix }),
  );

export const clientOnlyShardingConfig = (
  current: ShardingConfig.ShardingConfig["Service"],
): ShardingConfig.ShardingConfig["Service"] => ({
  ...current,
  runnerAddress: Option.none(),
});

export type ClusterWorkflowClientOptions<
  StorageError = never,
  StorageRequirements = never,
  ConfigError = never,
  ConfigRequirements = never,
> = {
  readonly path?: HttpRouter.PathInput | undefined;
  readonly storage: Layer.Layer<
    MessageStorage.MessageStorage | RunnerStorage.RunnerStorage,
    StorageError,
    StorageRequirements
  >;
  readonly shardingConfig: Layer.Layer<
    ShardingConfig.ShardingConfig,
    ConfigError,
    ConfigRequirements
  >;
};

export const clusterWorkflowEngineClientLayer = <
  StorageError,
  StorageRequirements,
  ConfigError,
  ConfigRequirements,
>(
  options: ClusterWorkflowClientOptions<
    StorageError,
    StorageRequirements,
    ConfigError,
    ConfigRequirements
  >,
) => {
  const clusterClient = HttpRunner.layerClient.pipe(
    Layer.provide(options.storage),
    Layer.provide(RunnerHealth.layerNoop),
    Layer.provide(HttpRunner.layerClientProtocolHttp({ path: options.path ?? "/cluster/rpc" })),
    Layer.updateService(ShardingConfig.ShardingConfig, clientOnlyShardingConfig),
    Layer.provide(options.shardingConfig),
    Layer.provide(RpcSerialization.layerJson),
  );

  return ClusterWorkflowEngine.layer.pipe(
    Layer.provide(options.storage),
    Layer.provide(clusterClient),
  );
};

export type ClusterWorkflowRunnerOptions<
  StorageError = never,
  StorageRequirements = never,
  ConfigError = never,
  ConfigRequirements = never,
  HealthError = never,
  HealthRequirements = never,
> = ClusterWorkflowClientOptions<
  StorageError,
  StorageRequirements,
  ConfigError,
  ConfigRequirements
> & {
  readonly runnerHealth: Layer.Layer<RunnerHealth.RunnerHealth, HealthError, HealthRequirements>;
};

export const clusterWorkflowRunnerLayer = <
  StorageError,
  StorageRequirements,
  ConfigError,
  ConfigRequirements,
  HealthError,
  HealthRequirements,
>(
  options: ClusterWorkflowRunnerOptions<
    StorageError,
    StorageRequirements,
    ConfigError,
    ConfigRequirements,
    HealthError,
    HealthRequirements
  >,
) =>
  HttpRunner.layerHttpOptions({ path: options.path ?? "/cluster/rpc" }).pipe(
    Layer.provide(options.storage),
    Layer.provide(options.runnerHealth),
    Layer.provide(HttpRunner.layerClientProtocolHttp({ path: options.path ?? "/cluster/rpc" })),
    Layer.provide(options.shardingConfig),
    Layer.provide(RpcSerialization.layerJson),
  );

export const clusterWorkflowEngineRunnerLayer = <
  StorageError,
  StorageRequirements,
  ConfigError,
  ConfigRequirements,
  HealthError,
  HealthRequirements,
>(
  options: ClusterWorkflowRunnerOptions<
    StorageError,
    StorageRequirements,
    ConfigError,
    ConfigRequirements,
    HealthError,
    HealthRequirements
  >,
) =>
  ClusterWorkflowEngine.layer.pipe(
    Layer.provide(options.storage),
    Layer.provideMerge(clusterWorkflowRunnerLayer(options)),
  );
