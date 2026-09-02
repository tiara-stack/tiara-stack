import { NodeFileSystem, NodeHttpServer } from "@effect/platform-node";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { Effect, Layer } from "effect";
import { createServer } from "http";
import {
  isCurrentClusterRunnerReady,
  isWorkflowApiReady,
  postgresSqlLayer,
  rolloutGateControlLayer,
  sheetBotCacheClientLayer,
  trustedSheetPersistenceLayer,
} from "./services";
import { config } from "./config";
import { workflowHttpRoutesLayer } from "./handlers/workflowHttp";
import { rolloutGateRoutesLayer } from "./handlers/rolloutGate";
import { readOnlyWorkflowAuthorizationLayer } from "./workflows/readOnly";

const apiRoutesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const sheetWebBaseUrl = yield* config.sheetWebBaseUrl;
    return workflowHttpRoutesLayer.pipe(
      Layer.merge(rolloutGateRoutesLayer),
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
      Layer.provide(
        HttpRouter.cors({
          allowedOrigins: [sheetWebBaseUrl.origin],
        }),
      ),
    );
  }),
);

const workflowHttpAuthorizationLayer = readOnlyWorkflowAuthorizationLayer.pipe(
  Layer.provide(sheetBotCacheClientLayer),
  Layer.provide(trustedSheetPersistenceLayer),
);

const httpServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* config.port;
    return NodeHttpServer.layer(createServer, { port });
  }),
);

export const httpLayer = HttpRouter.serve(apiRoutesLayer).pipe(
  Layer.provide(workflowHttpAuthorizationLayer),
  Layer.provide(rolloutGateControlLayer),
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
