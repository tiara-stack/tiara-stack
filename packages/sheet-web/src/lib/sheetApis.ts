import { AtomHttpApi, AtomRegistry } from "effect/unstable/reactivity";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { SheetApisApi as Api } from "sheet-ingress-api/sheet-apis";
import { Effect, Function, Layer, Option, pipe } from "effect";
import { getRequest, getRequestHeaders } from "@tanstack/react-start/server";
import { createIsomorphicFn } from "@tanstack/react-start";
import { sessionAtom } from "#/lib/auth";
import { sheetApisBaseUrlAtom } from "#/lib/configAtoms";
import { ensureResultAtomData } from "#/lib/atomRegistry";
import { ensureSheetWebOAuthAccessToken } from "#/lib/oauth";

const getRequestHeadersFn = createIsomorphicFn()
  .server(() => ({
    origin: getRequestHeaders().get("origin") ?? new URL(getRequest().url).origin,
    cookie: getRequestHeaders().get("cookie") ?? undefined,
  }))
  .client(() => ({}));

const redirectToOAuthStartFn = createIsomorphicFn()
  .server(() => undefined)
  .client(() => {
    window.location.assign("/auth/oauth/start");
  });

const AuthClientLive = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  return HttpClient.mapRequestEffect(
    httpClient,
    Effect.fnUntraced(function* (request) {
      const registry = yield* AtomRegistry.AtomRegistry;
      const { baseUrl, session } = yield* Effect.all({
        baseUrl: ensureResultAtomData(registry, sheetApisBaseUrlAtom, { revalidateIfStale: true }),
        session: ensureResultAtomData(registry, sessionAtom, { revalidateIfStale: true }),
      }).pipe(
        Effect.match({
          onFailure: () => ({ baseUrl: Option.none(), session: Option.none() }),
          onSuccess: ({ baseUrl, session }) => ({ baseUrl: Option.some(baseUrl), session }),
        }),
      );

      const headers = getRequestHeadersFn();
      const oauthAccessToken = yield* ensureSheetWebOAuthAccessToken().pipe(
        Effect.catch(() => Effect.succeedNone),
      );

      return pipe(
        request,
        Option.match(baseUrl, {
          onSome: (baseUrl) => HttpClientRequest.prependUrl(baseUrl.href),
          onNone: () => Function.identity<HttpClientRequest.HttpClientRequest>,
        }),
        Option.match(session, {
          onSome: () =>
            Option.match(oauthAccessToken, {
              onSome: (token) => HttpClientRequest.bearerToken(token),
              onNone: () => {
                redirectToOAuthStartFn();
                return Function.identity<HttpClientRequest.HttpClientRequest>;
              },
            }),
          onNone: () => Function.identity<HttpClientRequest.HttpClientRequest>,
        }),
        HttpClientRequest.setHeaders(headers),
      );
    }),
  ) as unknown as HttpClient.HttpClient;
}).pipe(
  Layer.effect(HttpClient.HttpClient),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" })),
);

export class SheetApisClient extends AtomHttpApi.Service<SheetApisClient>()("SheetApisClient", {
  api: Api,
  httpClient: AuthClientLive,
}) {}
