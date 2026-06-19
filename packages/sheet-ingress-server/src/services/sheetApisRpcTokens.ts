import { Context, Effect, HashSet, Layer, Redacted } from "effect";
import { createOAuthClientCredentialsToken } from "sheet-auth/client";
import { DISCORD_SERVICE_USER_ID_SENTINEL } from "sheet-auth/oauth";
import { SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE } from "sheet-ingress-api/middlewares/forwardedAuthHeaders";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import type { SheetAuthOAuthScope } from "sheet-ingress-api/schemas/permissions";
import { config } from "@/config";
import { SheetAuthClient } from "./sheetAuthClient";

const sheetApisResource = "sheet-apis";
const sheetWorkflowsResource = "sheet-workflows";
const sheetBotResource = "sheet-bot";

const oauthAudiences: Record<string, string> = {
  [sheetApisResource]: sheetApisResource,
  [sheetWorkflowsResource]: sheetWorkflowsResource,
  [sheetBotResource]: sheetBotResource,
};

type SheetAuthUserType = Context.Service.Shape<typeof SheetAuthUser>;

export class SheetApisRpcTokens extends Context.Service<SheetApisRpcTokens>()(
  "SheetApisRpcTokens",
  {
    make: Effect.gen(function* () {
      const sheetAuthClient = yield* SheetAuthClient;
      const oauthClientId = yield* config.sheetAuthOAuthClientId;
      const oauthClientSecret = yield* config.sheetAuthOAuthClientSecret;
      const getOAuthAudience = (resource: string) => oauthAudiences[resource];

      const getOAuthToken = (scope: readonly ["ingress.forward"], resource: string | undefined) =>
        createOAuthClientCredentialsToken(sheetAuthClient, {
          clientId: oauthClientId,
          clientSecret: oauthClientSecret,
          scope,
          resource,
        });

      const getServiceUser = Effect.fn("SheetApisRpcTokens.getServiceUser")(() =>
        Effect.succeed({
          accountId: DISCORD_SERVICE_USER_ID_SENTINEL,
          userId: DISCORD_SERVICE_USER_ID_SENTINEL,
          permissions: HashSet.fromIterable(["service"]),
          scopes: new Set<SheetAuthOAuthScope>(["service"]),
          token: Redacted.make(SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE),
        } satisfies SheetAuthUserType),
      );

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
