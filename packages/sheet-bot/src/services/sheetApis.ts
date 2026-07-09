import { HttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Cache, Context, Data, Duration, Effect, Layer, Redacted } from "effect";
import { createOAuthClientCredentialsToken } from "sheet-auth/client";
import { DISCORD_SERVICE_USER_ID_SENTINEL } from "sheet-auth/oauth";
import { SheetApisApi } from "sheet-ingress-api/sheet-apis";
import { config } from "@/config";
import { makeCachedBearerTokenHttpClient } from "./oauthHttpClient";
import { SheetAuthClient } from "./sheetAuthClient";

class SheetBotServicesSheetApisClientError extends Data.TaggedError(
  "SheetBotServicesSheetApisClientError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface SheetApisClientShape {
  readonly get: () => HttpApiClient.ForApi<typeof SheetApisApi>;
  readonly isTeamSubmissionChannelConfigured: (
    workspaceId: string,
    conversationId: string,
  ) => Effect.Effect<boolean, unknown, never>;
}

const makeSheetApisTokenEntry = (
  sheetAuthClient: typeof SheetAuthClient.Service,
  oauthClientId: string,
  oauthClientSecret: Redacted.Redacted<string>,
) =>
  createOAuthClientCredentialsToken(sheetAuthClient, {
    clientId: oauthClientId,
    clientSecret: oauthClientSecret,
    scope: ["service"],
    resource: "sheet-ingress",
  }).pipe(
    Effect.map((oauthToken) => ({
      token: oauthToken.accessToken,
      timeToLive: Duration.max(
        Duration.seconds(oauthToken.expiresAt - Math.floor(Date.now() / 1000) - 60),
        Duration.seconds(15),
      ),
      failed: false,
    })),
    Effect.matchEffect({
      onSuccess: Effect.succeed,
      onFailure: (error) =>
        Effect.logError("Failed to create OAuth service token for SheetApisClient", {
          error,
        }).pipe(
          Effect.as({
            token: undefined,
            timeToLive: Duration.minutes(1),
            failed: true,
          }),
        ),
    }),
  );

const makeSheetApisHttpClient = Effect.fn("SheetApisClient.makeSheetApisHttpClient")(function* ({
  httpClient,
  oauthClientId,
  oauthClientSecret,
  sheetAuthClient,
}: {
  readonly httpClient: HttpClient.HttpClient;
  readonly oauthClientId: string;
  readonly oauthClientSecret: Redacted.Redacted<string>;
  readonly sheetAuthClient: typeof SheetAuthClient.Service;
}) {
  return yield* makeCachedBearerTokenHttpClient({
    httpClient,
    cacheCapacity: 1,
    lookupName: "SheetApisClient.lookup",
    lookup: () => makeSheetApisTokenEntry(sheetAuthClient, oauthClientId, oauthClientSecret),
    missingToken: Effect.fail(
      new SheetBotServicesSheetApisClientError({
        message: "Failed to create OAuth service token for SheetApisClient",
      }),
    ),
    tokenEntry: (tokenCache) => Cache.get(tokenCache, DISCORD_SERVICE_USER_ID_SENTINEL),
  });
});

const makeSheetApisClientService = Effect.gen(function* () {
  const sheetAuthClient = yield* SheetAuthClient;
  const httpClient = yield* HttpClient.HttpClient;
  const baseUrl = yield* config.sheetIngressBaseUrl;
  const oauthClientId = yield* config.sheetAuthOAuthClientId;
  const oauthClientSecret = yield* config.sheetAuthOAuthClientSecret;

  const httpClientWithToken = yield* makeSheetApisHttpClient({
    httpClient,
    oauthClientId,
    oauthClientSecret,
    sheetAuthClient,
  });

  const client = yield* HttpApiClient.makeWith(SheetApisApi, {
    httpClient: httpClientWithToken,
    baseUrl,
  });

  return {
    get: () => client,
    isTeamSubmissionChannelConfigured: Effect.fn(
      "SheetApisClient.isTeamSubmissionChannelConfigured",
    )(function* (workspaceId: string, conversationId: string) {
      return yield* client.workspaceConfig
        .getTeamSubmissionChannelByConversationId({
          query: { workspaceId, conversationId },
        })
        .pipe(
          Effect.as(true),
          Effect.catchTag("ArgumentError", () => Effect.succeed(false)),
          Effect.tapCause((cause) =>
            Effect.logWarning("Team submission channel config lookup failed").pipe(
              Effect.annotateLogs({ workspaceId, conversationId }),
              Effect.andThen(Effect.logDebug(cause)),
            ),
          ),
        );
    }),
  } satisfies SheetApisClientShape;
});

export class SheetApisClient extends Context.Service<SheetApisClient, SheetApisClientShape>()(
  "SheetApisClient",
  { make: makeSheetApisClientService },
) {
  static layer = Layer.effect(SheetApisClient, this.make).pipe(
    Layer.provide(SheetAuthClient.layer),
  );
}
