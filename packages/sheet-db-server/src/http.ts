import { HttpApiBuilder, HttpApiSwagger } from "effect/unstable/httpapi";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { createServer } from "http";
import { makeZeroHttpLive } from "typhoon-zero/server";
import { mutators, queries, schema } from "sheet-db-schema/zero";
import { Api } from "./api";
import { DBService } from "./services/db";
import { WorkflowZeroAuthorization } from "./services/workflowZeroAuthorization";

const ZeroHttpLive = makeZeroHttpLive(Api, {
  schema,
  queries,
  mutators,
  context: (procedureNames) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const authorization = yield* WorkflowZeroAuthorization;
      return yield* authorization.authorize(procedureNames, request.headers);
    }),
  zql: Effect.gen(function* () {
    const dbService = yield* DBService;
    return dbService.zql;
  }),
}).pipe(Layer.provide(DBService.layer), Layer.provide(WorkflowZeroAuthorization.layer));

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
