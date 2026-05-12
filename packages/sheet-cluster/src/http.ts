import { NodeFileSystem, NodeHttpServer } from "@effect/platform-node";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { Effect, Layer } from "effect";
import { createServer } from "http";
import { SheetClusterRpcs } from "sheet-ingress-api/sheet-cluster-rpc";
import { clusterHttpLayer, clusterWorkflowEngineClientLayer } from "./cluster";
import { dispatchLayer } from "./handlers/dispatch";
import { healthLayer } from "./handlers/health";
import { SheetAuthTokenAuthorizationLive } from "./middlewares/sheetAuthTokenAuthorization/live";
import { postgresSqlLayer, SheetApisClient } from "./services";
import { config } from "./config";

const rpcHandlersLayer = Layer.mergeAll(dispatchLayer, healthLayer);

const rpcRoutesLayer = RpcServer.layerHttp({
  group: SheetClusterRpcs,
  path: "/rpc",
  protocol: "http",
}).pipe(
  Layer.provide(rpcHandlersLayer),
  Layer.provide(clusterWorkflowEngineClientLayer),
  Layer.provide(SheetAuthTokenAuthorizationLive),
  Layer.provide(RpcSerialization.layerJson),
  Layer.merge(HttpRouter.add("GET", "/live", HttpServerResponse.empty({ status: 200 }))),
  Layer.merge(HttpRouter.add("GET", "/ready", HttpServerResponse.empty({ status: 200 }))),
  Layer.provideMerge(HttpRouter.layer),
);

const httpServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* config.port;
    return NodeHttpServer.layer(createServer, { port });
  }),
);

export const httpLayer = HttpRouter.serve(rpcRoutesLayer).pipe(
  Layer.provideMerge(clusterHttpLayer),
  Layer.provide(SheetApisClient.layer),
  Layer.provide(postgresSqlLayer),
  Layer.provide(NodeFileSystem.layer),
  HttpServer.withLogAddress,
  Layer.provide(httpServerLayer),
);
