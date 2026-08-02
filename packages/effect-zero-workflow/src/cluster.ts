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

const defaultClusterRpcPath = "/cluster/rpc";

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

const provideShardingConfig = <StorageError, StorageRequirements, ConfigError, ConfigRequirements>(
  options: ClusterWorkflowClientOptions<
    StorageError,
    StorageRequirements,
    ConfigError,
    ConfigRequirements
  >,
) => options.storage.pipe(Layer.provide(options.shardingConfig));

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
  // Storage needs the runner address; only the remote client view clears it.
  const storage = provideShardingConfig(options);
  const path = options.path ?? defaultClusterRpcPath;
  const clusterClient = HttpRunner.layerClient.pipe(
    Layer.provide(storage),
    Layer.provide(RunnerHealth.layerNoop),
    Layer.provide(HttpRunner.layerClientProtocolHttp({ path })),
    Layer.updateService(ShardingConfig.ShardingConfig, clientOnlyShardingConfig),
    Layer.provide(options.shardingConfig),
    Layer.provide(RpcSerialization.layerJson),
  );

  return ClusterWorkflowEngine.layer.pipe(Layer.provide(storage), Layer.provide(clusterClient));
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

const makeRunnerLayer = <
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
  storage: Layer.Layer<
    MessageStorage.MessageStorage | RunnerStorage.RunnerStorage,
    StorageError | ConfigError,
    StorageRequirements | ConfigRequirements
  >,
) => {
  const path = options.path ?? defaultClusterRpcPath;
  return HttpRunner.layerHttpOptions({ path }).pipe(
    Layer.provide(storage),
    Layer.provide(options.runnerHealth),
    Layer.provide(HttpRunner.layerClientProtocolHttp({ path })),
    Layer.provide(options.shardingConfig),
    Layer.provide(RpcSerialization.layerJson),
  );
};

/**
 * Serves unauthenticated shard and message traffic at the configured RPC path.
 * Keep this route on an internal network or protect it with host-level authentication.
 */
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
) => {
  const storage = provideShardingConfig(options);
  return makeRunnerLayer(options, storage);
};

/**
 * Serves unauthenticated shard and message traffic at the configured RPC path.
 * Keep this route on an internal network or protect it with host-level authentication.
 */
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
) => {
  const storage = provideShardingConfig(options);
  const runner = makeRunnerLayer(options, storage);
  return ClusterWorkflowEngine.layer.pipe(Layer.provide(storage), Layer.provideMerge(runner));
};
