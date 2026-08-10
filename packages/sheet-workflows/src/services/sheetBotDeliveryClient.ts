import { Cache, Clock, Context, Duration, Effect, Exit, Layer, Redacted } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";
import { createOAuthClientCredentialsToken } from "sheet-auth/client";
import { makeSheetBotHttpClient, type SheetBotHttpClient } from "sheet-bot-api";
import { config } from "@/config";
import { SheetAuthClient } from "./sheetAuthClient";

interface SheetBotDeliveryClientShape {
  readonly get: () => SheetBotHttpClient;
}

export class SheetBotDeliveryClient extends Context.Service<
  SheetBotDeliveryClient,
  SheetBotDeliveryClientShape
>()("sheet-workflows/SheetBotDeliveryClient") {}

export const sheetBotDeliveryClientLayer = Layer.effect(
  SheetBotDeliveryClient,
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
          scope: ["bot.delivery.write"],
          resource: "sheet-bot",
        }).pipe(
          Effect.flatMap((token) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((nowMillis) => {
                const remainingMillis = Math.max(token.expiresAt * 1_000 - nowMillis, 0);
                return {
                  token: token.accessToken,
                  timeToLive: Duration.millis(
                    remainingMillis > 60_000 ? remainingMillis - 60_000 : remainingMillis,
                  ),
                };
              }),
            ),
          ),
        ),
      {
        capacity: 1,
        timeToLive: Exit.match({
          onFailure: () => Duration.seconds(5),
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
