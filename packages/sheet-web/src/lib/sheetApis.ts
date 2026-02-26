import { AtomHttpApi, Registry } from "@effect-atom/atom-react";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform";
import { Api } from "sheet-apis/api";
import { sessionJwtAtom } from "#/lib/auth";
import { sheetApisBaseUrlAtom } from "#/lib/configAtoms";
import { Effect, Function, Layer, Option, pipe } from "effect";
import { atomRegistry } from "./atomRegistry";

const AuthClientLive = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  return HttpClient.mapRequestEffect(
    httpClient,
    Effect.fnUntraced(function* (request) {
      const { baseUrl, jwt } = yield* Effect.all({
        baseUrl: Registry.getResult(atomRegistry, sheetApisBaseUrlAtom),
        jwt: Registry.getResult(atomRegistry, sessionJwtAtom),
      }).pipe(
        Effect.match({
          onFailure: () => ({ baseUrl: Option.none(), jwt: Option.none() }),
          onSuccess: ({ baseUrl, jwt }) => ({ baseUrl: Option.some(baseUrl), jwt }),
        }),
      );

      return pipe(
        request,
        Option.match(baseUrl, {
          onSome: (baseUrl) => HttpClientRequest.prependUrl(baseUrl.href),
          onNone: () => Function.identity<HttpClientRequest.HttpClientRequest>,
        }),
        Option.match(jwt, {
          onSome: (token) => HttpClientRequest.bearerToken(token),
          onNone: () => Function.identity<HttpClientRequest.HttpClientRequest>,
        }),
      );
    }),
  );
}).pipe(
  Layer.effect(HttpClient.HttpClient),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" })),
);

export class SheetApisClient extends AtomHttpApi.Tag<SheetApisClient>()("SheetApisClient", {
  api: Api,
  httpClient: AuthClientLive,
}) {}
