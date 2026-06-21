import { NodeHttpServer } from "@effect/platform-node";
import { Duration, Effect, Layer, Option } from "effect";
import {
  ClusterWorkflowEngine,
  HttpRunner,
  K8sHttpClient,
  RunnerAddress,
  RunnerHealth,
  Sharding,
  ShardingConfig,
  SqlMessageStorage,
  SqlRunnerStorage,
} from "effect/unstable/cluster";
import { HttpRouter } from "effect/unstable/http";
import { RpcSerialization } from "effect/unstable/rpc";
import { createServer } from "node:http";
import { config } from "@/config";
import {
  AutoCheckinService,
  DispatchService,
  ClientDeliveryClient,
  SheetApisClient,
} from "@/services";
import { autoCheckinWorkflowLayer } from "@/workflows/autoCheckin";
import { getClusterRunnerReadinessSnapshot, postgresSqlLayer } from "@/services";
import { dispatchButtonEntityLayer, dispatchWorkflowLayer } from "@/workflows/dispatch";
import { smokeWorkflowLayer } from "@/workflows/smoke";

const shardGroups = ["dispatch", "autoCheckin"] as const;

const configuredRunnerAddress = Effect.gen(function* () {
  const runnerHost = yield* config.workflowsRunnerHost;
  const runnerPort = yield* config.workflowsRunnerPort;
  return RunnerAddress.make(runnerHost, runnerPort);
});

export const shardingConfigLayer = Layer.unwrap(
  Effect.gen(function* () {
    const runnerAddress = yield* configuredRunnerAddress;
    const runnerListenHost = yield* config.workflowsRunnerListenHost;
    const runnerListenPort = yield* config.workflowsRunnerListenPort;

    return ShardingConfig.layer({
      runnerAddress: Option.some(runnerAddress),
      runnerListenAddress: Option.some(RunnerAddress.make(runnerListenHost, runnerListenPort)),
      assignedShardGroups: shardGroups,
      availableShardGroups: shardGroups,
      shardsPerGroup: 300,
      entityMailboxCapacity: 4096,
      entityMaxIdleTime: Duration.minutes(5),
      simulateRemoteSerialization: false,
    });
  }),
).pipe(Layer.withSpan("sheet-workflows.shardingConfig"));

export const clusterStorageLayer = Layer.mergeAll(
  SqlMessageStorage.layerWith({ prefix: "sheet_workflows" }),
  SqlRunnerStorage.layerWith({ prefix: "sheet_workflows" }),
).pipe(Layer.withSpan("sheet-workflows.clusterStorage"));

const runnerHealthLayer = Layer.unwrap(
  Effect.gen(function* () {
    const namespace = yield* config.podNamespace;
    const labelSelector = yield* config.workflowsRunnerHealthLabelSelector;
    return RunnerHealth.layerK8s({ namespace, labelSelector });
  }),
).pipe(Layer.withSpan("sheet-workflows.runnerHealth"));

export const clientOnlyWorkflowShardingConfig = (
  current: ShardingConfig.ShardingConfig["Service"],
): ShardingConfig.ShardingConfig["Service"] => ({
  ...current,
  runnerAddress: Option.none(),
});

const clusterClientLayer = HttpRunner.layerClient.pipe(
  Layer.provide(clusterStorageLayer),
  Layer.provide(RunnerHealth.layerNoop),
  Layer.provide(HttpRunner.layerClientProtocolHttp({ path: "/cluster/rpc" })),
  Layer.updateService(ShardingConfig.ShardingConfig, clientOnlyWorkflowShardingConfig),
  Layer.provide(shardingConfigLayer),
  Layer.provide(RpcSerialization.layerJson),
  Layer.withSpan("sheet-workflows.clusterClient"),
);

export const clusterWorkflowEngineClientLayer = ClusterWorkflowEngine.layer.pipe(
  Layer.provide(clusterStorageLayer),
  Layer.provide(clusterClientLayer),
  Layer.withSpan("sheet-workflows.workflowEngineClient"),
);

const workflowsRunnerLayer = HttpRunner.layerHttpOptions({ path: "/cluster/rpc" }).pipe(
  Layer.provide(clusterStorageLayer),
  Layer.provide(runnerHealthLayer),
  Layer.provide(K8sHttpClient.layer),
  Layer.provide(HttpRunner.layerClientProtocolHttp({ path: "/cluster/rpc" })),
  Layer.provide(shardingConfigLayer),
  Layer.provide(RpcSerialization.layerJson),
);

const runnerReadinessProbeTimeout = Duration.seconds(15);

const clusterStartupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Sharding.Sharding;
    yield* Effect.logInfo("Started sheet-workflows sharding runtime");
    yield* getClusterRunnerReadinessSnapshot.pipe(
      Effect.delay(Duration.seconds(5)),
      Effect.flatMap((snapshot) => {
        const log = snapshot.hasRecentHealthyRunner ? Effect.logInfo : Effect.logWarning;
        return log("Checked sheet-workflows runner registration", snapshot);
      }),
      Effect.timeoutOrElse({
        duration: runnerReadinessProbeTimeout,
        orElse: () =>
          Effect.logWarning("sheet-workflows runner readiness probe timed out", {
            timeoutMillis: Duration.toMillis(runnerReadinessProbeTimeout),
          }),
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to inspect sheet-workflows runner registration", cause),
      ),
      Effect.forkScoped,
    );
    yield* Effect.never.pipe(Effect.forkScoped);
  }),
);

const dispatchClientsLayer = Layer.mergeAll(ClientDeliveryClient.layer, SheetApisClient.layer);

const dispatchServicesLayer = Layer.effect(DispatchService, DispatchService.make).pipe(
  Layer.provideMerge(dispatchClientsLayer),
);

const clusterLayer = Layer.mergeAll(
  dispatchButtonEntityLayer,
  dispatchWorkflowLayer,
  autoCheckinWorkflowLayer,
  smokeWorkflowLayer,
  clusterStartupLayer,
).pipe(
  Layer.provide(AutoCheckinService.layer),
  Layer.provide(dispatchServicesLayer),
  Layer.provide(ClusterWorkflowEngine.layer),
  Layer.provideMerge(workflowsRunnerLayer),
  Layer.provide(postgresSqlLayer),
);

const clusterHttpServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* config.workflowsRunnerListenHost;
    const port = yield* config.workflowsRunnerListenPort;
    return NodeHttpServer.layer(createServer, { host, port });
  }),
);

export const clusterHttpLayer = HttpRouter.serve(
  clusterLayer.pipe(Layer.provideMerge(HttpRouter.layer)),
).pipe(Layer.provide(clusterHttpServerLayer), Layer.withSpan("sheet-workflows.clusterHttp"));
