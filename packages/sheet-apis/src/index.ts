import { NodeFileSystem, NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { dotEnvConfigProviderLayer } from "typhoon-core/config";
import { httpLayer } from "./http";
import { MetricsLive } from "./metrics";
import { TracesLive } from "./traces";

const configProviderLayer = dotEnvConfigProviderLayer().pipe(Layer.provide(NodeFileSystem.layer));

const main = httpLayer.pipe(
  Layer.provide(MetricsLive),
  Layer.provide(TracesLive),
  Layer.provide(Logger.layer([Logger.consoleLogFmt])),
  Layer.provide(NodeHttpClient.layerFetch),
  Layer.provide(configProviderLayer),
  Layer.launch,
  Effect.orDie,
);

NodeRuntime.runMain(main);
