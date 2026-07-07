import { NodeFileSystem, NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { dotEnvConfigProviderLayer } from "typhoon-core/config";
import {
  clusterHttpLayer,
  clusterStorageLayer,
  clusterWorkflowEngineClientLayer,
  shardingConfigLayer,
} from "./cluster";
import { config } from "./config";
import { httpLayer, runnerHealthLayer } from "./http";
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

const runnerLayer = runnerHealthLayer.pipe(Layer.provideMerge(clusterServerLayer));

const appLayersByRole = {
  api: clientWorkflowLayers,
  runner: runnerLayer,
  combined: clientWorkflowLayers.pipe(Layer.provideMerge(clusterServerLayer)),
};

const appLayer = Layer.unwrap(
  Effect.gen(function* () {
    const role = yield* config.sheetWorkflowsRole;
    return appLayersByRole[role];
  }),
);

const mainLayer = appLayer.pipe(
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

NodeRuntime.runMain(Effect.orDie(Layer.launch(mainLayer)));
