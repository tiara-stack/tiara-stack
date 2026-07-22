import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Layer, Logger } from "effect";
import { dotEnvConfigProviderLayer } from "typhoon-core/config";
import { HttpLive } from "./http";
import { MetricsLive } from "./metrics";
import { TracesLive } from "./traces";

const configProviderLayer = dotEnvConfigProviderLayer().pipe(Layer.provide(NodeFileSystem.layer));

HttpLive.pipe(
  Layer.provide(MetricsLive),
  Layer.provide(TracesLive),
  Layer.provide(Logger.layer([Logger.consoleLogFmt])),
  Layer.provide(configProviderLayer),
  Layer.launch,
  NodeRuntime.runMain(),
);
