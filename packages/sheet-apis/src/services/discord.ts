import { NodeFileSystem, NodeHttpClient } from "@effect/platform-node";
import { apiCacheViewsLayer, Unstorage } from "dfx-discord-utils/discord/cache";
import { DiscordApiClient } from "dfx-discord-utils/discord";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Cache, Duration, Effect, Exit, Layer, Redacted, Option } from "effect";
import { createOAuthClientCredentialsToken } from "sheet-auth/client";
import { config } from "@/config";

type TokenCacheEntry = {
  readonly token: Redacted.Redacted<string> | undefined;
  readonly timeToLive: Duration.Duration;
};

const serviceAuthCacheKey = "sheet-apis-discord-service";

const toTokenCacheTTL = (expiresIn: number | undefined) =>
  expiresIn !== undefined && !Number.isNaN(expiresIn) && expiresIn > 0
    ? Duration.max(Duration.seconds(Math.max(Math.floor(expiresIn) - 60, 15)), Duration.seconds(15))
    : Duration.minutes(1);

const serviceUserAuthHttpClientLayer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const sheetAuthIssuer = yield* config.sheetAuthIssuer;
    const serviceClientId = yield* config.sheetServiceOAuthClientId;
    const serviceClientSecret = yield* config.sheetServiceOAuthClientSecret;
    if (Option.isNone(serviceClientId) || Option.isNone(serviceClientSecret)) {
      return yield* Effect.fail(
        new Error("OAuth service client credentials are not configured for sheet-apis"),
      );
    }

    const tokenCache = yield* Cache.makeWith<string, TokenCacheEntry>(
      Effect.fn("DiscordApiClient.lookupServiceToken")(function* () {
        const issued = yield* createOAuthClientCredentialsToken(
          sheetAuthIssuer,
          serviceClientId.value,
          serviceClientSecret.value,
          "service",
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to create sheet-apis service auth token", error).pipe(
              Effect.as(undefined),
            ),
          ),
        );
        const timeToLive = toTokenCacheTTL(issued?.expiresIn);

        return {
          token: issued?.token,
          timeToLive,
        };
      }),
      {
        capacity: 1,
        timeToLive: Exit.match({
          onFailure: () => Duration.minutes(1),
          onSuccess: ({ timeToLive }) => timeToLive,
        }),
      },
    );

    return HttpClient.mapRequestEffect(
      httpClient,
      Effect.fnUntraced(function* (request) {
        const { token } = yield* Cache.get(tokenCache, serviceAuthCacheKey);

        return token ? HttpClientRequest.bearerToken(request, Redacted.value(token)) : request;
      }),
    ) as unknown as HttpClient.HttpClient;
  }),
).pipe(Layer.provide(NodeFileSystem.layer));

const discordApiClientLayer = Layer.unwrap(
  Effect.gen(function* () {
    const sheetIngressBaseUrl = yield* config.sheetIngressBaseUrl;
    return DiscordApiClient.layer(sheetIngressBaseUrl).pipe(
      Layer.provide(serviceUserAuthHttpClientLayer),
    );
  }),
);

const redisLayer = Layer.unwrap(
  Effect.gen(function* () {
    const redisUrl = yield* config.redisUrl;
    return Unstorage.redisLayer({ url: Redacted.value(redisUrl) });
  }),
);

const prefixedUnstorageLayer = Unstorage.prefixedLayer("discord:").pipe(Layer.provide(redisLayer));

export const discordLayer = apiCacheViewsLayer.pipe(
  Layer.provideMerge(discordApiClientLayer),
  Layer.provide([prefixedUnstorageLayer, NodeHttpClient.layerFetch]),
);
