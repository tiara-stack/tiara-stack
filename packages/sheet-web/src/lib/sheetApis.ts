import { AtomHttpApi, Registry, Result } from "@effect-atom/atom-react";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform";
import { Api } from "sheet-apis/api";
import { sessionJwtAtom } from "#/lib/auth";
import { sheetApisBaseUrlAtom } from "#/lib/configAtoms";
import { Effect, Layer, Option } from "effect";
import { runtimeAtom } from "./runtime";

const AuthClientLive = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const registry = yield* Registry.AtomRegistry;

  return HttpClient.mapRequest(httpClient, (request) => {
    const { baseUrl, jwt } = Result.all({
      baseUrl: registry.get(sheetApisBaseUrlAtom),
      jwt: registry.get(sessionJwtAtom),
    }).pipe(
      Result.match({
        onInitial: () => ({ baseUrl: Option.none(), jwt: Option.none() }),
        onFailure: () => ({ baseUrl: Option.none(), jwt: Option.none() }),
        onSuccess: ({ value: { baseUrl, jwt } }) => ({ baseUrl: Option.some(baseUrl), jwt }),
      }),
    );

    return Option.match(baseUrl, {
      onSome: (baseUrl) => HttpClientRequest.prependUrl(request, baseUrl.href),
      onNone: () => request,
    }).pipe((request) =>
      Option.match(jwt, {
        onSome: (token) => HttpClientRequest.bearerToken(request, token),
        onNone: () => request,
      }),
    );
  });
}).pipe(Layer.effect(HttpClient.HttpClient), Layer.provide(FetchHttpClient.layer));

export class SheetApisClient extends AtomHttpApi.Tag<SheetApisClient>()("SheetApisClient", {
  api: Api,
  httpClient: AuthClientLive as Layer.Layer<HttpClient.HttpClient, never, never>,
  runtime: runtimeAtom.factory,
}) {}
