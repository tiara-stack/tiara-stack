import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Cache, Context, Duration, Effect, Exit, Layer, Redacted } from "effect";
import { createOAuthClientCredentialsToken } from "sheet-auth/client";
import { DISCORD_SERVICE_USER_ID_SENTINEL } from "sheet-auth/oauth";
import { SheetApisApi } from "sheet-ingress-api/sheet-apis";
import type { TokenCacheEntry } from "sheet-ingress-api/tokenCache";
import { config } from "@/config";
import { SheetAuthClient } from "./sheetAuthClient";
import * as Data from "effect/Data";

class SheetWorkflowsServicesSheetApisClientError extends Data.TaggedError(
  "SheetWorkflowsServicesSheetApisClientError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface SheetApisClientShape {
  readonly get: () => HttpApiClient.ForApi<typeof SheetApisApi>;
}

export class SheetApisClient extends Context.Service<SheetApisClient, SheetApisClientShape>()(
  "SheetApisClient",
  {
    make: Effect.gen(function* () {
      const sheetAuthClient = yield* SheetAuthClient;
      const httpClient = yield* HttpClient.HttpClient;
      const baseUrl = yield* config.sheetIngressBaseUrl;
      const oauthClientId = yield* config.sheetAuthOAuthClientId;
      const oauthClientSecret = yield* config.sheetAuthOAuthClientSecret;

      const tokenCache = yield* Cache.makeWith<string, TokenCacheEntry>(
        Effect.fn("SheetApisClient.lookup")(() =>
          createOAuthClientCredentialsToken(sheetAuthClient, {
            clientId: oauthClientId,
            clientSecret: oauthClientSecret,
            scope: ["service"],
            resource: "sheet-ingress",
          }).pipe(
            Effect.tap(() => Effect.logDebug("Using OAuth service token for SheetApisClient")),
            Effect.map((oauthToken) => ({
              token: oauthToken.accessToken,
              timeToLive: Duration.max(
                Duration.seconds(oauthToken.expiresAt - Math.floor(Date.now() / 1000) - 60),
                Duration.seconds(15),
              ),
              failed: false,
            })),
            Effect.tap((entry) =>
              Effect.annotateCurrentSpan({
                tokenAvailable: true,
                timeToLiveMillis: Duration.toMillis(entry.timeToLive),
              }),
            ),
            Effect.matchEffect({
              onSuccess: (entry) => Effect.succeed(entry),
              onFailure: (error) =>
                Effect.logError(
                  "Failed to create OAuth service token for SheetApisClient",
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

      const httpClientWithToken = HttpClient.mapRequestEffect(httpClient, (request) =>
        Effect.gen(function* () {
          const { failed, token } = yield* Cache.get(tokenCache, DISCORD_SERVICE_USER_ID_SENTINEL);

          yield* Effect.annotateCurrentSpan({ tokenAvailable: !failed && token !== undefined });
          if (failed || !token) {
            return yield* new SheetWorkflowsServicesSheetApisClientError({
              message: "Failed to create OAuth service token",
            });
          }

          return HttpClientRequest.bearerToken(request, Redacted.value(token));
        }).pipe(Effect.withSpan("SheetApisClient.mapAuthRequest")),
      ) as unknown as HttpClient.HttpClient;

      const client = yield* HttpApiClient.makeWith(SheetApisApi, {
        httpClient: httpClientWithToken,
        baseUrl,
      }).pipe(Effect.withSpan("SheetApisClient.makeWith", { attributes: { baseUrl } }));

      return {
        get: () => client,
      };
    }),
  },
) {
  static layer = Layer.effect(SheetApisClient, this.make).pipe(
    Layer.provide(SheetAuthClient.layer),
  );
}
