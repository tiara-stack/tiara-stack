import { NodeFileSystem, NodeHttpServer } from "@effect/platform-node";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect, Layer } from "effect";
import { createServer } from "http";
import { SheetWorkflowsInternalApi } from "sheet-ingress-api/sheet-workflows-internal";
import { clusterWorkflowEngineClientLayer } from "./cluster";
import { dispatchLayer } from "./handlers/dispatch";
import { SheetAuthTokenAuthorizationLive } from "./middlewares/sheetAuthTokenAuthorization/live";
import {
  isCurrentClusterRunnerReady,
  isWorkflowApiReady,
  postgresSqlLayer,
  SheetApisClient,
} from "./services";
import { config } from "./config";
import { SheetIngressServiceAuthorizationLive } from "./middlewares/sheetIngressServiceAuthorization/live";

const apiHandlersLayer = Layer.mergeAll(dispatchLayer);

const apiRoutesLayer = HttpApiBuilder.layer(SheetWorkflowsInternalApi).pipe(
  Layer.provide(apiHandlersLayer),
  Layer.provide(clusterWorkflowEngineClientLayer),
  Layer.provide(SheetIngressServiceAuthorizationLive),
  Layer.provide(SheetAuthTokenAuthorizationLive),
  Layer.merge(HttpRouter.add("GET", "/live", HttpServerResponse.empty({ status: 200 }))),
  Layer.merge(
    HttpRouter.add(
      "GET",
      "/ready",
      isWorkflowApiReady.pipe(
        Effect.map((ready) => HttpServerResponse.empty({ status: ready ? 200 : 503 })),
      ),
    ),
  ),
  Layer.provideMerge(HttpRouter.layer),
);

const httpServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* config.port;
    return NodeHttpServer.layer(createServer, { port });
  }),
);

export const httpLayer = HttpRouter.serve(apiRoutesLayer).pipe(
  Layer.provide(SheetApisClient.layer),
  Layer.provide(postgresSqlLayer),
  Layer.provide(NodeFileSystem.layer),
  HttpServer.withLogAddress,
  Layer.provide(httpServerLayer),
);

const runnerHealthRoutesLayer = HttpRouter.add(
  "GET",
  "/live",
  HttpServerResponse.empty({ status: 200 }),
).pipe(
  Layer.merge(
    HttpRouter.add(
      "GET",
      "/ready",
      isCurrentClusterRunnerReady.pipe(
        Effect.map((ready) => HttpServerResponse.empty({ status: ready ? 200 : 503 })),
      ),
    ),
  ),
  Layer.provideMerge(HttpRouter.layer),
);

export const runnerHealthLayer = HttpRouter.serve(runnerHealthRoutesLayer).pipe(
  Layer.provide(postgresSqlLayer),
  HttpServer.withLogAddress,
  Layer.provide(httpServerLayer),
);
