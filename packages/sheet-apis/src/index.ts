import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Layer, Logger } from "effect";
import { HttpLive, CacheLive } from "./http";
import { MetricsLive } from "./metrics";
import { TracesLive } from "./traces";
import { PlatformConfigProvider } from "@effect/platform";

HttpLive.pipe(
  Layer.provide(CacheLive),
  Layer.provide(MetricsLive),
  Layer.provide(TracesLive),
  Layer.provide(Logger.logFmt),
  Layer.provide(PlatformConfigProvider.layerDotEnvAdd(".env")),
  Layer.provide(NodeContext.layer),
  Layer.launch,
  NodeRuntime.runMain({
    disablePrettyLogger: true,
  }),
);
