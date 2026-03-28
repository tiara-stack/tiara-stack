import { config } from "@/config";
import { FileSystem, HttpApiClient, HttpClient, HttpClientRequest } from "@effect/platform";
import { Interaction } from "dfx-discord-utils";
import { DiscordInteraction } from "dfx/Interactions/context";
import {
  Cache,
  Data,
  Duration,
  Effect,
  Exit,
  Ref,
  pipe,
  Schedule,
  Context,
  DateTime,
  Redacted,
} from "effect";
import { createKubernetesOAuthSession } from "sheet-auth/client";
import { DISCORD_BOT_USER_ID_SENTINEL } from "sheet-auth/plugins/kubernetes-oauth";
import { Api } from "sheet-apis/api";
import { SheetAuthClient } from "./sheetAuthClient";

type SheetApisRequester = Data.TaggedEnum<{
  Bot: {};
  DiscordUser: { readonly discordUserId: string };
}>;
export const SheetApisRequester = Data.taggedEnum<SheetApisRequester>();

export class SheetApisRequestContext extends Context.Tag("SheetApisRequestContext")<
  SheetApisRequestContext,
  {
    requester: SheetApisRequester;
  }
>() {
  static asBot = <Args extends any[], A, E, R>(
    fn: (...args: Args) => Effect.Effect<A, E, R>,
  ): ((...args: Args) => Effect.Effect<A, E, Exclude<R, SheetApisRequestContext>>) =>
    Effect.fn("SheetApisRequestContext.asBot")(function* (...args: Args) {
      const sheetApisRequestContext = SheetApisRequestContext.of({
        requester: SheetApisRequester.Bot(),
      });

      return yield* fn(...args).pipe(
        Effect.provideService(SheetApisRequestContext, sheetApisRequestContext),
      );
    });

  static asInteractionUser = <Args extends any[], A, E, R>(
    fn: (...args: Args) => Effect.Effect<A, E, R>,
  ): ((
    ...args: Args
  ) => Effect.Effect<A, E, DiscordInteraction | Exclude<R, SheetApisRequestContext>>) =>
    Effect.fn("SheetApisRequestContext.asInteractionUser")(function* (...args: Args) {
      const interactionUser = yield* Interaction.user();
      const sheetApisRequestContext = SheetApisRequestContext.of({
        requester: SheetApisRequester.DiscordUser({ discordUserId: interactionUser.id }),
      });

      return yield* fn(...args).pipe(
        Effect.provideService(SheetApisRequestContext, sheetApisRequestContext),
      );
    });
}

export class SheetApisClient extends Effect.Service<SheetApisClient>()("SheetApisClient", {
  scoped: pipe(
    Effect.all({
      fs: FileSystem.FileSystem,
      sheetAuthClient: SheetAuthClient,
      httpClient: HttpClient.HttpClient,
      k8sTokenRef: Ref.make(""),
      baseUrl: config.sheetApisBaseUrl,
    }),
    Effect.tap(({ fs, k8sTokenRef }) =>
      // Periodic K8s token refresh every 5 minutes
      Effect.forkScoped(
        pipe(
          fs.readFileString("/var/run/secrets/tokens/sheet-auth-token", "utf-8"),
          Effect.map((token) => token.trim()),
          Effect.flatMap((token) => Ref.set(k8sTokenRef, token)),
          Effect.retry({ schedule: Schedule.exponential("1 second"), times: 3 }),
          Effect.catchAll(() => Effect.void),
          Effect.repeat(Schedule.spaced("5 minutes")),
        ),
      ),
    ),
    Effect.bind("tokenCache", ({ sheetAuthClient, k8sTokenRef }) =>
      Cache.makeWith({
        capacity: Infinity,
        lookup: (discordUserId: string) =>
          Effect.gen(function* () {
            const k8sToken = yield* Ref.get(k8sTokenRef);
            const session = yield* createKubernetesOAuthSession(
              sheetAuthClient,
              discordUserId,
              k8sToken,
            ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
            const now = yield* DateTime.now;
            const timeToLive = session?.session?.expiresAt
              ? DateTime.distanceDuration(now, session.session.expiresAt).pipe(
                  Duration.subtract(Duration.seconds(60)),
                )
              : Duration.minutes(1);

            return {
              token: session?.token,
              timeToLive,
            };
          }),
        timeToLive: (exit) =>
          Exit.match(exit, {
            onFailure: () => Duration.minutes(1),
            onSuccess: ({ timeToLive }) => timeToLive,
          }),
      }),
    ),
    Effect.let("httpClientWithToken", ({ httpClient, tokenCache }) =>
      HttpClient.mapRequestEffect(httpClient, (request) =>
        SheetApisRequestContext.pipe(
          Effect.map(({ requester }) => requester),
          Effect.flatMap(
            SheetApisRequester.$match({
              Bot: () => tokenCache.get(DISCORD_BOT_USER_ID_SENTINEL),
              DiscordUser: ({ discordUserId }) => tokenCache.get(discordUserId),
            }),
          ),
          Effect.map(({ token }) =>
            token ? HttpClientRequest.bearerToken(request, Redacted.value(token)) : request,
          ),
          Effect.catchAll((err) =>
            pipe(
              Effect.logWarning(
                `Failed to get auth token, proceeding unauthenticated: ${String(err)}`,
              ),
              Effect.as(request),
            ),
          ),
        ),
      ),
    ),
    Effect.bind("client", ({ httpClientWithToken, baseUrl }) =>
      HttpApiClient.makeWith(Api, {
        httpClient: httpClientWithToken,
        baseUrl,
      }),
    ),
    Effect.map(({ client }) => ({
      get: () => client,
    })),
  ),
  accessors: true,
  dependencies: [SheetAuthClient.Default],
}) {}
