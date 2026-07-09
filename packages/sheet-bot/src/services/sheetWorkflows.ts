import { readFile } from "node:fs/promises";
import { config } from "@/config";
import { Interaction } from "dfx-discord-utils";
import { DiscordInteraction } from "dfx/Interactions/context";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import {
  Cache,
  Data,
  Duration,
  Effect,
  Match,
  Layer,
  Option,
  Predicate,
  Redacted,
  Context,
  Schema,
} from "effect";
import {
  createOAuthClientCredentialsToken,
  createOAuthSubjectToken,
  exchangeOAuthToken,
} from "sheet-auth/client";
import { DISCORD_SERVICE_USER_ID_SENTINEL } from "sheet-auth/oauth";
import type { ClientRef } from "sheet-ingress-api/schemas/client";
import { ServicesStatusResponse } from "sheet-ingress-api/sheet-apis-rpc";
import { SheetWorkflowsApi } from "sheet-ingress-api/sheet-workflows";
import { makeCachedBearerTokenHttpClient } from "./oauthHttpClient";
import { SheetAuthClient } from "./sheetAuthClient";

class SheetBotServicesSheetWorkflowsError extends Data.TaggedError(
  "SheetBotServicesSheetWorkflowsError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type SheetWorkflowsRequester = Data.TaggedEnum<{
  Service: {};
  DiscordUser: { readonly discordUserId: string };
}>;
const SheetWorkflowsRequester = Data.taggedEnum<SheetWorkflowsRequester>();

type SheetWorkflowsRequestContextType = {
  requester: SheetWorkflowsRequester;
};

export interface SheetWorkflowsServiceStatus {
  readonly name: string;
  readonly status: "ok" | "down";
  readonly error?: string | null | undefined;
}

export interface SheetWorkflowsServicesStatus {
  readonly overallStatus: "ok" | "degraded";
  readonly checkedAt: unknown;
  readonly services: ReadonlyArray<SheetWorkflowsServiceStatus>;
}

type SheetWorkflowsServicesStatusError = HttpClientError.HttpClientError | Schema.SchemaError;

interface SheetWorkflowsClientShape {
  readonly get: () => HttpApiClient.ForApi<typeof SheetWorkflowsApi>;
  readonly getServicesStatus: () => Effect.Effect<
    SheetWorkflowsServicesStatus,
    SheetWorkflowsServicesStatusError
  >;
}

const accessTokenType = "urn:ietf:params:oauth:token-type:access_token";
const workflowRequesterTokenCacheCapacity = 500;

const withClientPayload = <T>(args: T, client: ClientRef): T => {
  if (!Predicate.isObject(args) || !Predicate.hasProperty(args, "payload")) {
    return args;
  }

  const payload = args.payload;
  if (!Predicate.isObject(payload)) {
    return args;
  }

  return {
    ...args,
    payload: {
      ...payload,
      client: Predicate.hasProperty(payload, "client") ? payload.client : client,
    },
  };
};

const withClientDispatch = <TDispatch extends object>(
  dispatch: TDispatch,
  client: ClientRef,
): TDispatch =>
  new Proxy(dispatch as Record<PropertyKey, unknown>, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (!Predicate.isFunction(value)) {
        return value;
      }
      return (args: unknown) => value.call(target, withClientPayload(args, client));
    },
  }) as TDispatch;

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
      new SheetBotServicesSheetWorkflowsError({
        message: `Failed to read Kubernetes service account token: ${
          Predicate.isError(error) ? error.message : String(error)
        }`,
      }),
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

export class SheetWorkflowsClient extends Context.Service<
  SheetWorkflowsClient,
  SheetWorkflowsClientShape
>()("SheetWorkflowsClient", {
  make: Effect.gen(function* () {
    const sheetAuthClient = yield* SheetAuthClient;
    const httpClient = yield* HttpClient.HttpClient;
    const baseUrl = yield* config.sheetIngressBaseUrl;
    const sheetBotClientId = yield* config.sheetBotClientId;
    const oauthClientId = yield* config.sheetAuthOAuthClientId;
    const oauthClientSecret = yield* config.sheetAuthOAuthClientSecret;
    const subjectTokenKubernetesTokenPath = yield* config.sheetAuthSubjectTokenKubernetesTokenPath;

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

    const httpClientWithToken = yield* makeCachedBearerTokenHttpClient({
      httpClient,
      allowMissingToken: true,
      cacheCapacity: workflowRequesterTokenCacheCapacity,
      lookupName: "SheetWorkflowsClient.lookup",
      lookup: (discordUserId: string) =>
        Effect.gen(function* () {
          const requesterKind =
            discordUserId === DISCORD_SERVICE_USER_ID_SENTINEL ? "service" : "discordUser";
          const oauthSession = yield* createOAuthClientCredentialsToken(sheetAuthClient, {
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
              Effect.logDebug("Using OAuth token for sheet-workflows request", { requesterKind }),
            ),
            Effect.matchEffect({
              onSuccess: (session) => Effect.succeed(session),
              onFailure: (error) =>
                Effect.logError("Failed to create OAuth token for sheet-workflows request", {
                  error,
                  requesterKind,
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
      missingToken: Effect.fail(
        new SheetBotServicesSheetWorkflowsError({
          message: "Failed to get auth token for sheet-workflows request",
        }),
      ),
      tokenEntry: (tokenCache) =>
        Effect.gen(function* () {
          const { requester } = yield* Effect.serviceOption(sheetWorkflowsRequestContextTag).pipe(
            Effect.map(
              Option.getOrElse(
                (): SheetWorkflowsRequestContextType => ({
                  requester: SheetWorkflowsRequester.Service(),
                }),
              ),
            ),
          );
          const cacheKey = Match.value(requester).pipe(
            Match.tagsExhaustive({
              Service: () => DISCORD_SERVICE_USER_ID_SENTINEL,
              DiscordUser: (requester) => requester.discordUserId,
            }),
          );
          const entry = yield* Cache.get(tokenCache, cacheKey);

          const requesterTokenFailed = Match.value(requester).pipe(
            Match.tagsExhaustive({
              Service: () => entry.failed,
              DiscordUser: () => entry.token === undefined || entry.failed,
            }),
          );

          return { ...entry, failed: requesterTokenFailed };
        }),
    });

    const client = yield* HttpApiClient.makeWith(SheetWorkflowsApi, {
      httpClient: httpClientWithToken,
      baseUrl,
    });
    const workflowClient: HttpApiClient.ForApi<typeof SheetWorkflowsApi> = {
      ...client,
      dispatch: withClientDispatch(client.dispatch, {
        platform: "discord",
        clientId: sheetBotClientId,
      }),
    };

    const service: SheetWorkflowsClientShape = {
      get: () => workflowClient,
      getServicesStatus: Effect.fn("SheetWorkflowsClient.getServicesStatus")(function* () {
        return yield* httpClientWithToken
          .get(`${baseUrl}/status/services`)
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(ServicesStatusResponse)),
          );
      }),
    };

    return service;
  }),
}) {
  static layer = Layer.effect(SheetWorkflowsClient, this.make).pipe(
    Layer.provide(SheetAuthClient.layer),
  );
}
