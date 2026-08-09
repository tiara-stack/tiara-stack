import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";
import { Cache, Clock, Context, Duration, Effect, Exit, Layer, Redacted } from "effect";
import { createOAuthClientCredentialsToken } from "sheet-auth/client";
import { makeSheetBotHttpClient, type SheetBotHttpClient } from "sheet-bot-api";
import { config } from "@/config";
import { SheetAuthClient } from "./sheetAuthClient";

interface SheetBotCacheClientShape {
  readonly get: () => SheetBotHttpClient;
}

export class SheetBotCacheClient extends Context.Service<
  SheetBotCacheClient,
  SheetBotCacheClientShape
>()("sheet-workflows/SheetBotCacheClient") {}

export const sheetBotCacheClientLayer = Layer.effect(
  SheetBotCacheClient,
  Effect.gen(function* () {
    const baseUrl = yield* config.sheetBotBaseUrl;
    const clientId = yield* config.sheetAuthOAuthClientId;
    const clientSecret = yield* config.sheetAuthOAuthClientSecret;
    const sheetAuthClient = yield* SheetAuthClient;
    const baseHttpClient = yield* HttpClient.HttpClient;
    const tokenCache = yield* Cache.makeWith(
      () =>
        createOAuthClientCredentialsToken(sheetAuthClient, {
          clientId,
          clientSecret,
          scope: ["bot.cache.read"],
          resource: "sheet-bot",
        }).pipe(
          Effect.flatMap((token) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((nowMillis) => ({
                token: token.accessToken,
                timeToLive: Duration.max(
                  Duration.seconds(token.expiresAt - Math.floor(nowMillis / 1000) - 60),
                  Duration.seconds(15),
                ),
              })),
            ),
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
    const httpClient = HttpClient.mapRequestEffect(baseHttpClient, (request) =>
      Cache.get(tokenCache, "sheet-bot").pipe(
        Effect.map(({ token }) => HttpClientRequest.bearerToken(request, Redacted.value(token))),
        Effect.mapError(
          (cause) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause,
                description: "Failed to resolve OAuth bearer token",
              }),
            }),
        ),
      ),
    );
    const client = yield* makeSheetBotHttpClient(baseUrl).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return { get: () => client };
  }),
).pipe(Layer.provide(SheetAuthClient.layer));
