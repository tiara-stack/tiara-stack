import { NodeHttpServer } from "@effect/platform-node";
import { Duration, Effect, Layer, Option } from "effect";
import {
  ClusterWorkflowEngine,
  HttpRunner,
  K8sHttpClient,
  RunnerAddress,
  RunnerHealth,
  ShardingConfig,
  SqlMessageStorage,
  SqlRunnerStorage,
} from "effect/unstable/cluster";
import { HttpRouter } from "effect/unstable/http";
import { RpcSerialization } from "effect/unstable/rpc";
import { createServer } from "node:http";
import { config } from "@/config";
import { AutoCheckinService } from "@/services";
import { autoCheckinWorkflowLayer } from "@/workflows/autoCheckin";
import { postgresSqlLayer } from "@/services";
import { dispatchWorkflowLayer } from "@/workflows/dispatch";

export const shardingConfigLayer = Layer.unwrap(
  Effect.gen(function* () {
    const runnerHost = yield* config.clusterRunnerHost;
    const runnerPort = yield* config.clusterRunnerPort;
    const runnerListenHost = yield* config.clusterRunnerListenHost;
    const runnerListenPort = yield* config.clusterRunnerListenPort;

    return ShardingConfig.layer({
      runnerAddress: Option.some(RunnerAddress.make(runnerHost, runnerPort)),
      runnerListenAddress: Option.some(RunnerAddress.make(runnerListenHost, runnerListenPort)),
      shardGroups: ["dispatch", "autoCheckin"],
      shardsPerGroup: 300,
      entityMailboxCapacity: 4096,
      entityMaxIdleTime: Duration.minutes(5),
      simulateRemoteSerialization: false,
    });
  }),
);

export const clusterStorageLayer = Layer.mergeAll(
  SqlMessageStorage.layerWith({ prefix: "sheet_apis_cluster" }),
  SqlRunnerStorage.layerWith({ prefix: "sheet_apis_cluster" }),
).pipe(Layer.provide(postgresSqlLayer));

const runnerHealthLayer = Layer.unwrap(
  Effect.gen(function* () {
    const namespace = yield* config.podNamespace;
    return RunnerHealth.layerK8s({ namespace, labelSelector: "app=sheet-cluster" });
  }),
);

export const clusterClientLayer = HttpRunner.layerHttpClientOnly.pipe(
  Layer.provide(clusterStorageLayer),
  Layer.provide(HttpRunner.layerClientProtocolHttp({ path: "/cluster/rpc" })),
  Layer.provide(shardingConfigLayer),
  Layer.provide(RpcSerialization.layerJson),
);

export const clusterWorkflowEngineClientLayer = ClusterWorkflowEngine.layer.pipe(
  Layer.provide(clusterStorageLayer),
  Layer.provide(clusterClientLayer),
);

const clusterBaseLayer = HttpRunner.layerHttpOptions({ path: "/cluster/rpc" }).pipe(
  Layer.provide(clusterStorageLayer),
  Layer.provide(runnerHealthLayer),
  Layer.provide(K8sHttpClient.layer),
  Layer.provide(HttpRunner.layerClientProtocolHttp({ path: "/cluster/rpc" })),
  Layer.provide(shardingConfigLayer),
  Layer.provide(RpcSerialization.layerJson),
);

export const clusterLayer = Layer.mergeAll(dispatchWorkflowLayer, autoCheckinWorkflowLayer).pipe(
  Layer.provide(AutoCheckinService.layer),
  Layer.provide(ClusterWorkflowEngine.layer),
  Layer.provideMerge(clusterBaseLayer),
);

const clusterHttpServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* config.clusterRunnerListenHost;
    const port = yield* config.clusterRunnerListenPort;
    return NodeHttpServer.layer(createServer, { host, port });
  }),
);

export const clusterHttpLayer = HttpRouter.serve(
  clusterLayer.pipe(Layer.provideMerge(HttpRouter.layer)),
).pipe(Layer.provide(clusterHttpServerLayer));
