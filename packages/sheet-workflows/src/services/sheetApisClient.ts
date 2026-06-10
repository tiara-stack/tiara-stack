import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Cache, Context, Duration, Effect, Exit, Layer, Redacted, pipe, Option } from "effect";
import { createOAuthClientCredentialsToken } from "sheet-auth/client";
import { SheetApisApi } from "sheet-ingress-api/sheet-apis";
import { config } from "@/config";

type TokenCacheEntry = {
  token: Redacted.Redacted<string> | undefined;
  timeToLive: Duration.Duration;
};

export class SheetApisClient extends Context.Service<SheetApisClient>()("SheetApisClient", {
  make: Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const baseUrl = yield* config.sheetIngressBaseUrl;
    const sheetAuthIssuer = yield* config.sheetAuthIssuer;
    const serviceClientId = yield* config.sheetServiceOAuthClientId;
    const serviceClientSecret = yield* config.sheetServiceOAuthClientSecret;

    if (Option.isNone(serviceClientId) || Option.isNone(serviceClientSecret)) {
      return yield* Effect.fail(
        new Error("OAuth service client credentials are not configured for sheet-workflows"),
      );
    }

    const tokenCache = yield* Cache.makeWith<string, TokenCacheEntry>(
      Effect.fn("SheetApisClient.lookup")(function* () {
        const issued = yield* createOAuthClientCredentialsToken(
          sheetAuthIssuer,
          serviceClientId.value,
          serviceClientSecret.value,
          "service",
        ).pipe(Effect.catch(() => Effect.succeed(undefined)));
        const expiresIn = issued?.expiresIn;
        const timeToLive =
          expiresIn !== undefined && !Number.isNaN(expiresIn) && expiresIn > 0
            ? Duration.max(
                Duration.seconds(Math.max(Math.floor(expiresIn) - 60, 15)),
                Duration.seconds(15),
              )
            : Duration.minutes(1);

        const entry = {
          token: issued?.token,
          timeToLive,
        };
        yield* Effect.annotateCurrentSpan({
          tokenAvailable: entry.token !== undefined,
          timeToLiveMillis: Duration.toMillis(entry.timeToLive),
        });
        return entry;
      }),
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
        const { token } = yield* pipe(
          Cache.get(tokenCache, "sheet-workflows-sheet-apis-service"),
          Effect.catch((err) =>
            pipe(
              Effect.logWarning(
                `Failed to get auth token, proceeding unauthenticated: ${String(err)}`,
              ),
              Effect.as({ token: undefined }),
            ),
          ),
        );

        yield* Effect.annotateCurrentSpan({ tokenAvailable: token !== undefined });
        return token ? HttpClientRequest.bearerToken(request, Redacted.value(token)) : request;
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
}) {
  static layer = Layer.effect(SheetApisClient, this.make);
}
