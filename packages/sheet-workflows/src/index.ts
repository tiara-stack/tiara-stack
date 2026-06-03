import { NodeFileSystem, NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { dotEnvConfigProviderLayer } from "typhoon-core/config";
import {
  clusterHttpLayer,
  clusterStorageLayer,
  clusterWorkflowEngineClientLayer,
  shardingConfigLayer,
} from "./cluster";
import { httpLayer } from "./http";
import { MetricsLive } from "./metrics";
import { postgresSqlLayer } from "./services";
import { autoCheckinTaskLayer } from "./tasks";
import { smokeWorkflowTaskLayer } from "./tasks/smokeWorkflow";
import { TracesLive } from "./traces";

const configProviderLayer = dotEnvConfigProviderLayer().pipe(Layer.provide(NodeFileSystem.layer));

const clientWorkflowLayers = Layer.mergeAll(
  httpLayer,
  autoCheckinTaskLayer,
  smokeWorkflowTaskLayer,
).pipe(Layer.provide(clusterWorkflowEngineClientLayer), Layer.provide(shardingConfigLayer));

const clusterServerLayer = clusterHttpLayer.pipe(Layer.provide(shardingConfigLayer));

const mainLayer = Layer.mergeAll(clientWorkflowLayers, clusterServerLayer).pipe(
  Layer.provide(MetricsLive),
  Layer.provide(TracesLive),
  Layer.provide(Logger.layer([Logger.consoleLogFmt])),
  Layer.provide(NodeHttpClient.layerFetch),
  Layer.provide(clusterStorageLayer),
  Layer.provide(postgresSqlLayer),
  Layer.provide(shardingConfigLayer),
  Layer.provide(configProviderLayer),
  Layer.provide(NodeFileSystem.layer),
);

mainLayer.pipe(Layer.launch, Effect.orDie, NodeRuntime.runMain);
