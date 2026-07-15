import { NodeFileSystem, NodeHttpClient, NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { createServer } from "http";
import { Effect, Layer, Logger } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { dotEnvConfigProviderLayer } from "typhoon-core/config";
import { makeApiLayer } from "./api/layer";
import { config } from "./config";
import { TelemetryLive } from "./telemetry";

const configProviderLayer = dotEnvConfigProviderLayer().pipe(Layer.provide(NodeFileSystem.layer));

const HttpLive = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* config.port;
    const ApiLayer = makeApiLayer();

    return HttpRouter.serve(ApiLayer).pipe(
      HttpServer.withLogAddress,
      Layer.provide(NodeHttpServer.layer(createServer, { port })),
    );
  }),
);

const MainLive = HttpLive.pipe(
  Layer.provide(TelemetryLive),
  Layer.provide(Logger.layer([Logger.consoleLogFmt])),
  Layer.provide(NodeHttpClient.layerFetch),
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(configProviderLayer),
);

export const runServer = () => NodeRuntime.runMain(Effect.orDie(Layer.launch(MainLive)));
