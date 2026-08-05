import { HttpApiBuilder, HttpApiSwagger } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { createServer } from "http";
import { makeSheetZeroAuthorizationLayer, makeSheetZeroHttpLayer } from "sheet-zero-server";
import { Api } from "./api";
import { config } from "./config";
import { DBService } from "./services/db";

const SheetZeroAuthorizationLive = Layer.unwrap(
  Effect.gen(function* () {
    const issuer = yield* config.sheetAuthIssuer;
    const audience = yield* config.sheetAuthOAuthAudience;
    return makeSheetZeroAuthorizationLayer({ issuer, audience });
  }),
);

const ZeroHttpLive = makeSheetZeroHttpLayer(Api, {
  zql: Effect.gen(function* () {
    const dbService = yield* DBService;
    return dbService.zql;
  }),
}).pipe(Layer.provide(DBService.layer), Layer.provide(SheetZeroAuthorizationLive));

const ApiLayer = Layer.provide(HttpApiBuilder.layer(Api), [ZeroHttpLive]).pipe(
  Layer.merge(HttpApiSwagger.layer(Api)),
  Layer.merge(HttpRouter.add("GET", "/live", HttpServerResponse.empty({ status: 200 }))),
  Layer.merge(HttpRouter.add("GET", "/ready", HttpServerResponse.empty({ status: 200 }))),
  Layer.provide(HttpRouter.cors()),
);

export const HttpLive = HttpRouter.serve(ApiLayer).pipe(
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
);
