import { Cache, Context, Duration, Effect, Exit, HashSet, Layer, Redacted } from "effect";
import { createOAuthClientCredentialsToken } from "sheet-auth/client";
import { DISCORD_SERVICE_USER_ID_SENTINEL } from "sheet-auth/oauth";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import type { SheetAuthOAuthScope } from "sheet-ingress-api/schemas/permissions";
import { config } from "@/config";
import { SheetAuthClient } from "./sheetAuthClient";

const sheetApisResource = "sheet-apis";
const sheetWorkflowsResource = "sheet-workflows";
const sheetBotResource = "sheet-bot";

type SheetAuthUserType = Context.Service.Shape<typeof SheetAuthUser>;

type TokenCacheEntry = {
  readonly token: Redacted.Redacted<string> | undefined;
  readonly timeToLive: Duration.Duration;
  readonly failed: boolean;
};

export class SheetApisRpcTokens extends Context.Service<SheetApisRpcTokens>()(
  "SheetApisRpcTokens",
  {
    make: Effect.gen(function* () {
      const sheetAuthClient = yield* SheetAuthClient;
      const oauthClientId = yield* config.sheetAuthOAuthClientId;
      const oauthClientSecret = yield* config.sheetAuthOAuthClientSecret;
      const getOAuthAudience = (resource: string) => {
        switch (resource) {
          case sheetApisResource:
          case sheetWorkflowsResource:
          case sheetBotResource:
            return resource;
          default:
            return undefined;
        }
      };

      const getOAuthToken = (
        scope: readonly ["ingress.forward"] | readonly ["service"],
        resource: string | undefined,
      ) =>
        createOAuthClientCredentialsToken(sheetAuthClient, {
          clientId: oauthClientId,
          clientSecret: oauthClientSecret,
          scope,
          resource,
        });

      const serviceUserTokenCache = yield* Cache.makeWith<string, TokenCacheEntry>(
        Effect.fn("SheetApisRpcTokens.lookupServiceUserToken")(() =>
          getOAuthToken(["service"], "sheet-ingress").pipe(
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
                Effect.logError("Failed to create OAuth service user token", error).pipe(
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

      const getServiceUser = Effect.fn("SheetApisRpcTokens.getServiceUser")(function* () {
        const { failed, token } = yield* Cache.get(
          serviceUserTokenCache,
          DISCORD_SERVICE_USER_ID_SENTINEL,
        );

        if (failed || !token) {
          return yield* Effect.fail(new Error("Failed to create OAuth service user token"));
        }

        return {
          accountId: DISCORD_SERVICE_USER_ID_SENTINEL,
          userId: DISCORD_SERVICE_USER_ID_SENTINEL,
          permissions: HashSet.fromIterable(["service"]),
          scopes: new Set<SheetAuthOAuthScope>(["service"]),
          token,
        } satisfies SheetAuthUserType;
      });

      return {
        getServiceToken: Effect.fn("SheetApisRpcTokens.getServiceToken")(function* (
          resource: string,
        ) {
          const oauthToken = yield* getOAuthToken(["ingress.forward"], getOAuthAudience(resource));
          yield* Effect.logDebug("Using OAuth ingress forwarding token", { resource });
          return Redacted.value(oauthToken.accessToken);
        }),
        getServiceUser,
        withServiceUser: Effect.fn("SheetApisRpcTokens.withServiceUser")(function* <A, E, R>(
          effect: Effect.Effect<A, E, R>,
        ) {
          const serviceUser = yield* getServiceUser();
          return yield* effect.pipe(Effect.provideService(SheetAuthUser, serviceUser));
        }),
      };
    }),
  },
) {
  static layer = Layer.effect(SheetApisRpcTokens, this.make).pipe(
    Layer.provide(SheetAuthClient.layer),
  );
}
