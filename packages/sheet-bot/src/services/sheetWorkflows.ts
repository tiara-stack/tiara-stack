import { readFile } from "node:fs/promises";
import { config } from "@/config";
import { Interaction } from "dfx-discord-utils";
import { DiscordInteraction } from "dfx/Interactions/context";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import {
  Cache,
  Data,
  Duration,
  Effect,
  Exit,
  Match,
  Schema,
  Layer,
  Option,
  Redacted,
  Context,
} from "effect";
import {
  createOAuthClientCredentialsToken,
  createOAuthSubjectToken,
  exchangeOAuthToken,
} from "sheet-auth/client";
import { DISCORD_SERVICE_USER_ID_SENTINEL } from "sheet-auth/oauth";
import { ServicesStatusResponse } from "sheet-ingress-api/sheet-apis-rpc";
import { SheetWorkflowsApi } from "sheet-ingress-api/sheet-workflows";
import { SheetAuthClient } from "./sheetAuthClient";

type SheetWorkflowsRequester = Data.TaggedEnum<{
  Service: {};
  DiscordUser: { readonly discordUserId: string };
}>;
const SheetWorkflowsRequester = Data.taggedEnum<SheetWorkflowsRequester>();

type SheetWorkflowsRequestContextType = {
  requester: SheetWorkflowsRequester;
};

type TokenCacheEntry = {
  token: Redacted.Redacted<string> | undefined;
  timeToLive: Duration.Duration;
  failed: boolean;
};

const accessTokenType = "urn:ietf:params:oauth:token-type:access_token";

export const workflowRequesterActorScopes = (discordUserId: string) =>
  discordUserId === DISCORD_SERVICE_USER_ID_SENTINEL
    ? ["service", "workflow.dispatch"]
    : ["service", "token.exchange", "workflow.dispatch"];

export const workflowSubjectTokenOptions = (
  discordUserId: string,
  kubernetesServiceAccountToken: Redacted.Redacted<string>,
) => ({
  subject: `discord:${discordUserId}`,
  expiresIn: 60,
  kubernetesServiceAccountToken,
});

const readKubernetesServiceAccountToken = (path: string) =>
  Effect.tryPromise({
    try: async () => Redacted.make((await readFile(path, "utf8")).trim()),
    catch: (error) =>
      new Error(
        `Failed to read Kubernetes service account token: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
  });

const sheetWorkflowsRequestContextTag = Context.Reference<SheetWorkflowsRequestContextType>(
  "SheetWorkflowsRequestContext",
  {
    defaultValue: () => ({
      requester: SheetWorkflowsRequester.Service(),
    }),
  },
) as Context.Reference<SheetWorkflowsRequestContextType> & {
  readonly Type: SheetWorkflowsRequestContextType;
};

type SheetWorkflowsRequestContextTag = typeof sheetWorkflowsRequestContextTag;

export const SheetWorkflowsRequestContext = Object.assign(sheetWorkflowsRequestContextTag, {
  asService: <Args extends any[], A, E, R>(fn: (...args: Args) => Effect.Effect<A, E, R>) =>
    Effect.fn("SheetWorkflowsRequestContext.asService")(function* (...args: Args) {
      const sheetWorkflowsRequestContext: SheetWorkflowsRequestContextType = {
        requester: SheetWorkflowsRequester.Service(),
      };

      return yield* fn(...args).pipe(
        Effect.provideService(sheetWorkflowsRequestContextTag, sheetWorkflowsRequestContext),
      );
    }),

  asInteractionUser: <Args extends any[], A, E, R>(fn: (...args: Args) => Effect.Effect<A, E, R>) =>
    Effect.fn("SheetWorkflowsRequestContext.asInteractionUser")(function* (...args: Args) {
      const interactionUser = yield* Interaction.user();
      const sheetWorkflowsRequestContext: SheetWorkflowsRequestContextType = {
        requester: SheetWorkflowsRequester.DiscordUser({
          discordUserId: (interactionUser as { id: string }).id,
        }),
      };

      return yield* fn(...args).pipe(
        Effect.provideService(sheetWorkflowsRequestContextTag, sheetWorkflowsRequestContext),
      );
    }),
}) as SheetWorkflowsRequestContextTag & {
  asService: <Args extends any[], A, E, R>(
    fn: (...args: Args) => Effect.Effect<A, E, R>,
  ) => (...args: Args) => Effect.Effect<A, E, Exclude<R, SheetWorkflowsRequestContextTag>>;
  asInteractionUser: <Args extends any[], A, E, R>(
    fn: (...args: Args) => Effect.Effect<A, E, R>,
  ) => (
    ...args: Args
  ) => Effect.Effect<A, E, DiscordInteraction | Exclude<R, SheetWorkflowsRequestContextTag>>;
};

export class SheetWorkflowsClient extends Context.Service<SheetWorkflowsClient>()(
  "SheetWorkflowsClient",
  {
    make: Effect.gen(function* () {
      const sheetAuthClient = yield* SheetAuthClient;
      const httpClient = yield* HttpClient.HttpClient;
      const baseUrl = yield* config.sheetIngressBaseUrl;
      const oauthClientId = yield* config.sheetAuthOAuthClientId;
      const oauthClientSecret = yield* config.sheetAuthOAuthClientSecret;
      const subjectTokenKubernetesTokenPath =
        yield* config.sheetAuthSubjectTokenKubernetesTokenPath;

      const createDiscordUserToken = Effect.fn("SheetWorkflowsClient.createDiscordUserToken")(
        function* (
          token: {
            readonly accessToken: Redacted.Redacted<string>;
          },
          discordUserId: string,
        ) {
          const kubernetesServiceAccountToken = yield* readKubernetesServiceAccountToken(
            subjectTokenKubernetesTokenPath,
          );
          const subjectToken = yield* createOAuthSubjectToken(
            sheetAuthClient,
            workflowSubjectTokenOptions(discordUserId, kubernetesServiceAccountToken),
          );

          return yield* exchangeOAuthToken(sheetAuthClient, {
            subjectToken: subjectToken.subjectToken,
            subjectTokenType: subjectToken.subjectTokenType,
            actorToken: token.accessToken,
            actorTokenType: accessTokenType,
            requestedTokenType: accessTokenType,
            audience: "sheet-ingress",
            scope: ["workflow.dispatch"],
          }).pipe(
            Effect.map((exchangedToken) => ({
              token: exchangedToken.accessToken,
              expiresAt: exchangedToken.expiresAt,
            })),
          );
        },
      );

      const tokenCache = yield* Cache.makeWith<string, TokenCacheEntry>(
        Effect.fn("SheetWorkflowsClient.lookup")(function* (discordUserId: string) {
          let oauthSession:
            | {
                token: Redacted.Redacted<string> | undefined;
                expiresAt: number | undefined;
              }
            | undefined;

          oauthSession = yield* createOAuthClientCredentialsToken(sheetAuthClient, {
            clientId: oauthClientId,
            clientSecret: oauthClientSecret,
            scope: workflowRequesterActorScopes(discordUserId),
            resource: "sheet-ingress",
          }).pipe(
            Effect.flatMap((token) =>
              discordUserId === DISCORD_SERVICE_USER_ID_SENTINEL
                ? Effect.succeed({
                    token: token.accessToken,
                    expiresAt: token.expiresAt,
                  })
                : createDiscordUserToken(token, discordUserId),
            ),
            Effect.tap(() =>
              Effect.logDebug("Using OAuth token for sheet-workflows request", { discordUserId }),
            ),
            Effect.matchEffect({
              onSuccess: (session) => Effect.succeed(session),
              onFailure: (error) =>
                Effect.logError("Failed to create OAuth token for sheet-workflows request", {
                  error,
                  discordUserId,
                }).pipe(Effect.as(undefined)),
            }),
          );

          if (oauthSession?.token) {
            const millisUntilExpiration = oauthSession.expiresAt
              ? oauthSession.expiresAt * 1000 - Date.now() - 60_000
              : Duration.toMillis(Duration.minutes(5));
            return {
              token: oauthSession.token,
              timeToLive: Duration.max(
                Duration.millis(millisUntilExpiration),
                Duration.seconds(15),
              ),
              failed: false,
            };
          }

          return {
            token: undefined,
            timeToLive: Duration.minutes(1),
            failed: true,
          };
        }),
        {
          capacity: Infinity,
          timeToLive: Exit.match({
            onFailure: () => Duration.minutes(1),
            onSuccess: ({ timeToLive }) => timeToLive,
          }),
        },
      );

      const getRequesterToken = Effect.fn("SheetWorkflowsClient.getRequesterToken")(function* (
        requester: SheetWorkflowsRequester,
      ) {
        const cacheKey = Match.value(requester).pipe(
          Match.tagsExhaustive({
            Service: () => DISCORD_SERVICE_USER_ID_SENTINEL,
            DiscordUser: (requester) => requester.discordUserId,
          }),
        );
        return yield* Match.value(requester).pipe(
          Match.tagsExhaustive({
            Service: () => Cache.get(tokenCache, cacheKey),
            DiscordUser: () => Cache.get(tokenCache, cacheKey),
          }),
        );
      });

      const httpClientWithToken = HttpClient.mapRequestEffect(
        httpClient,
        Effect.fnUntraced(function* (request) {
          const { requester } = yield* Effect.serviceOption(sheetWorkflowsRequestContextTag).pipe(
            Effect.map(
              Option.getOrElse(
                (): SheetWorkflowsRequestContextType => ({
                  requester: SheetWorkflowsRequester.Service(),
                }),
              ),
            ),
          );
          const { token, failed } = yield* getRequesterToken(requester);

          if (requester._tag === "DiscordUser" && (token === undefined || failed)) {
            return yield* Effect.fail(
              new Error("Failed to get Discord user auth token for sheet-workflows request"),
            );
          }

          return token ? HttpClientRequest.bearerToken(request, Redacted.value(token)) : request;
        }),
      ) as unknown as HttpClient.HttpClient;

      const client = yield* HttpApiClient.makeWith(SheetWorkflowsApi, {
        httpClient: httpClientWithToken,
        baseUrl,
      });

      return {
        get: () => client,
        getServicesStatus: Effect.fn("SheetWorkflowsClient.getServicesStatus")(function* () {
          const response = yield* httpClientWithToken.get(`${baseUrl}/status/services`);

          if (response.status < 200 || response.status >= 300) {
            const body = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")));
            return yield* Effect.fail(
              new Error(`Service status request failed with HTTP ${response.status}: ${body}`),
            );
          }

          const body = yield* response.json;
          return yield* Schema.decodeUnknownEffect(ServicesStatusResponse)(body);
        }),
      };
    }),
  },
) {
  static layer = Layer.effect(SheetWorkflowsClient, this.make).pipe(
    Layer.provide(SheetAuthClient.layer),
  );
}
