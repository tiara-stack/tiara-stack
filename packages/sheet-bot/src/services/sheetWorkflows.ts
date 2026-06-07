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
  FileSystem,
  Ref,
  Match,
  pipe,
  Schedule,
  Schema,
  DateTime,
  Layer,
  Option,
  Redacted,
  Context,
} from "effect";
import { createKubernetesOAuthSession } from "sheet-auth/client";
import { DISCORD_SERVICE_USER_ID_SENTINEL } from "sheet-auth/plugins/kubernetes-oauth";
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
      const fs = yield* FileSystem.FileSystem;
      const sheetAuthClient = yield* SheetAuthClient;
      const httpClient = yield* HttpClient.HttpClient;
      const k8sTokenRef = yield* Ref.make("");
      const baseUrl = yield* config.sheetIngressBaseUrl;

      yield* pipe(
        fs.readFileString("/var/run/secrets/tokens/sheet-auth-token", "utf-8"),
        Effect.map((token) => token.trim()),
        Effect.flatMap((token) => Ref.set(k8sTokenRef, token)),
        Effect.retry({ schedule: Schedule.exponential("1 second"), times: 3 }),
        Effect.catch(() => Effect.void),
        Effect.repeat(Schedule.spaced("5 minutes")),
        Effect.forkScoped,
      );

      const tokenCache = yield* Cache.makeWith<string, TokenCacheEntry>(
        Effect.fn("SheetWorkflowsClient.lookup")(function* (discordUserId: string) {
          const k8sToken = yield* Ref.get(k8sTokenRef);
          const session = yield* createKubernetesOAuthSession(
            sheetAuthClient,
            discordUserId,
            k8sToken,
          ).pipe(Effect.catch(() => Effect.succeed(undefined)));
          const now = yield* DateTime.now;
          const timeToLive = session?.session?.expiresAt
            ? pipe(
                DateTime.distance(now, session.session.expiresAt),
                Duration.subtract(Duration.seconds(60)),
              )
            : Duration.minutes(1);

          return {
            token: session?.token,
            timeToLive,
            failed: session === undefined,
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
            Service: () =>
              pipe(
                Cache.get(tokenCache, cacheKey),
                Effect.catch((err) =>
                  pipe(
                    Effect.logWarning(
                      `Failed to get service auth token, proceeding unauthenticated: ${String(err)}`,
                    ),
                    Effect.as({
                      token: undefined,
                      timeToLive: Duration.minutes(1),
                      failed: true,
                    }),
                  ),
                ),
              ),
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
