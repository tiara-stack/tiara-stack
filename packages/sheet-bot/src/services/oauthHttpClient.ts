import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";
import { Cache, Duration, Effect, Exit, Redacted } from "effect";
import type { TokenCacheEntry } from "sheet-ingress-api/internal";

const makeOAuthTokenCache = ({
  capacity,
  lookup,
  lookupName,
}: {
  readonly capacity: number;
  readonly lookupName: string;
  readonly lookup: (key: string) => Effect.Effect<TokenCacheEntry, never>;
}) =>
  Cache.makeWith<string, TokenCacheEntry>(Effect.fn(lookupName)(lookup), {
    capacity,
    timeToLive: Exit.match({
      onFailure: () => Duration.minutes(1),
      onSuccess: ({ timeToLive }) => timeToLive,
    }),
  });

type OAuthTokenCache = Effect.Success<ReturnType<typeof makeOAuthTokenCache>>;

export const makeCachedBearerTokenHttpClient = Effect.fn("makeCachedBearerTokenHttpClient")(
  function* ({
    allowMissingToken = false,
    cacheCapacity,
    httpClient,
    lookup,
    lookupName,
    missingToken,
    tokenEntry,
  }: {
    readonly allowMissingToken?: boolean;
    readonly cacheCapacity: number;
    readonly httpClient: HttpClient.HttpClient;
    readonly lookupName: string;
    readonly lookup: (key: string) => Effect.Effect<TokenCacheEntry, never>;
    readonly missingToken: Effect.Effect<never, unknown>;
    readonly tokenEntry: (tokenCache: OAuthTokenCache) => Effect.Effect<TokenCacheEntry, unknown>;
  }) {
    const tokenCache = yield* makeOAuthTokenCache({
      capacity: cacheCapacity,
      lookupName,
      lookup,
    });

    return makeBearerTokenHttpClient({
      allowMissingToken,
      httpClient,
      missingToken,
      tokenEntry: tokenEntry(tokenCache),
    });
  },
);

const makeBearerTokenHttpClient = ({
  allowMissingToken = false,
  httpClient,
  missingToken,
  tokenEntry,
}: {
  readonly allowMissingToken?: boolean;
  readonly httpClient: HttpClient.HttpClient;
  readonly missingToken: Effect.Effect<never, unknown>;
  readonly tokenEntry: Effect.Effect<TokenCacheEntry, unknown>;
}) =>
  HttpClient.mapRequestEffect(httpClient, (request) =>
    Effect.gen(function* () {
      const tokenEntryError = (cause: unknown) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            cause,
            description: "Failed to resolve OAuth bearer token",
          }),
        });
      const { failed, token } = yield* tokenEntry.pipe(Effect.mapError(tokenEntryError));
      if (failed || (!allowMissingToken && !token)) {
        return yield* missingToken.pipe(Effect.mapError(tokenEntryError));
      }

      return token ? HttpClientRequest.bearerToken(request, Redacted.value(token)) : request;
    }),
  );
