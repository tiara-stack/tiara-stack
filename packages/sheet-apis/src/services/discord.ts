// fallow-ignore-file code-duplication
import { NodeHttpClient } from "@effect/platform-node";
import { apiCacheViewsLayer, Unstorage } from "dfx-discord-utils/discord/cache";
import { DiscordApiClient } from "dfx-discord-utils/discord";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Cache, Duration, Effect, Exit, Layer, Redacted } from "effect";
import { createOAuthClientCredentialsToken } from "sheet-auth/client";
import { DISCORD_SERVICE_USER_ID_SENTINEL } from "sheet-auth/oauth";
import { config } from "@/config";
import { SheetAuthClient } from "./sheetAuthClient";
import * as Data from "effect/Data";

class SheetApisServicesDiscordError extends Data.TaggedError("SheetApisServicesDiscordError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type TokenCacheEntry = {
  readonly token: Redacted.Redacted<string> | undefined;
  readonly timeToLive: Duration.Duration;
  readonly failed: boolean;
};

const serviceUserAuthHttpClientLayer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const sheetAuthClient = yield* SheetAuthClient;
    const httpClient = yield* HttpClient.HttpClient;
    const oauthClientId = yield* config.sheetAuthOAuthClientId;
    const oauthClientSecret = yield* config.sheetAuthOAuthClientSecret;

    const tokenCache = yield* Cache.makeWith<string, TokenCacheEntry>(
      Effect.fn("DiscordApiClient.lookupServiceToken")(() =>
        createOAuthClientCredentialsToken(sheetAuthClient, {
          clientId: oauthClientId,
          clientSecret: oauthClientSecret,
          scope: ["service"],
          resource: "sheet-ingress",
        }).pipe(
          Effect.tap(() => Effect.logDebug("Using OAuth service token for Discord API client")),
          Effect.map((oauthToken) => ({
            token: oauthToken.accessToken,
            timeToLive: Duration.max(
              Duration.seconds(oauthToken.expiresAt - Math.floor(Date.now() / 1000) - 60),
              Duration.seconds(15),
            ),
            failed: false,
          })),
          Effect.matchEffect({
            onSuccess: (entry) => Effect.succeed(entry),
            onFailure: (error) =>
              Effect.logError(
                "Failed to create OAuth service token for Discord API client",
                error,
              ).pipe(
                Effect.as({
                  token: undefined,
                  timeToLive: Duration.minutes(1),
                  failed: true,
                }),
              ),
          }),
        ),
      ),
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
        const { failed, token } = yield* Cache.get(tokenCache, DISCORD_SERVICE_USER_ID_SENTINEL);

        if (failed || !token) {
          return yield* new SheetApisServicesDiscordError({
            message: "Failed to create OAuth service token",
          });
        }

        return HttpClientRequest.bearerToken(request, Redacted.value(token));
      }),
    ) as unknown as HttpClient.HttpClient;
  }),
).pipe(Layer.provide(SheetAuthClient.layer));

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
