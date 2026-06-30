import { Context, Effect, HashSet, Layer, Option, Redacted } from "effect";
import { createOAuthClientCredentialsToken, exchangeOAuthToken } from "sheet-auth/client";
import {
  AccessTokenType,
  DISCORD_SERVICE_USER_ID_SENTINEL,
  SessionTokenType,
} from "sheet-auth/oauth";
import { SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE } from "sheet-ingress-api/middlewares/forwardedAuthHeaders";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import type { SheetAuthOAuthScope } from "sheet-ingress-api/schemas/permissions";
import { Unauthorized } from "typhoon-core/error";
import { config } from "@/config";
import { SheetAuthClient } from "./sheetAuthClient";

const sheetApisResource = "sheet-apis";
const sheetWorkflowsResource = "sheet-workflows";
const sheetBotResource = "sheet-bot";
const sheetIngressResource = "sheet-ingress";

const oauthAudiences: Record<string, string> = {
  [sheetApisResource]: sheetApisResource,
  [sheetWorkflowsResource]: sheetWorkflowsResource,
  [sheetBotResource]: sheetBotResource,
  [sheetIngressResource]: sheetIngressResource,
};

const knownForwardingResources = new Set(Object.keys(oauthAudiences));

const actorScopes = [
  "token.exchange",
  "ingress.forward",
  "sheet.read",
  "sheet.write",
  "sheet.manage",
  "workflow.dispatch",
  "bot.impersonate",
] as const;

const serviceScopes = ["service", "ingress.forward"] as const;

const delegatedUserScopes = (user: SheetAuthUserType) => [
  "ingress.forward",
  ...Array.from(user.scopes).filter(
    (scope) =>
      scope !== "service" &&
      scope !== "ingress.forward" &&
      scope !== "bot.impersonate" &&
      scope !== "token.exchange",
  ),
];

type SheetAuthUserType = Context.Service.Shape<typeof SheetAuthUser>;

export class SheetApisRpcTokens extends Context.Service<SheetApisRpcTokens>()(
  "SheetApisRpcTokens",
  {
    make: Effect.gen(function* () {
      const sheetAuthClient = yield* SheetAuthClient;
      const oauthClientId = yield* config.sheetAuthOAuthClientId;
      const oauthClientSecret = yield* config.sheetAuthOAuthClientSecret;
      const tokenExchangeOAuthClientIdOption = yield* config.sheetAuthOAuthTokenExchangeClientId;
      const tokenExchangeOAuthClientSecretOption =
        yield* config.sheetAuthOAuthTokenExchangeClientSecret;
      const hasTokenExchangeOAuthClientId = Option.isSome(tokenExchangeOAuthClientIdOption);
      const hasTokenExchangeOAuthClientSecret = Option.isSome(tokenExchangeOAuthClientSecretOption);

      if (hasTokenExchangeOAuthClientId !== hasTokenExchangeOAuthClientSecret) {
        return yield* Effect.fail(
          new Unauthorized({
            message: "Token exchange OAuth client id and secret must be configured together",
          }),
        );
      }

      const tokenExchangeOAuthClient =
        Option.isSome(tokenExchangeOAuthClientIdOption) &&
        Option.isSome(tokenExchangeOAuthClientSecretOption)
          ? {
              clientId: tokenExchangeOAuthClientIdOption.value,
              clientSecret: tokenExchangeOAuthClientSecretOption.value,
            }
          : { clientId: oauthClientId, clientSecret: oauthClientSecret };
      const getOAuthAudience = Effect.fn("SheetApisRpcTokens.getOAuthAudience")(function* (
        resource: string,
      ) {
        if (!knownForwardingResources.has(resource)) {
          return yield* Effect.fail(
            new Unauthorized({ message: `Unknown OAuth forwarding resource: ${resource}` }),
          );
        }

        return oauthAudiences[resource]!;
      });

      const getOAuthToken = (scope: readonly string[], resource: string | undefined) =>
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
          tokenType: "service",
        } satisfies SheetAuthUserType),
      );

      return {
        getServiceToken: Effect.fn("SheetApisRpcTokens.getServiceToken")(function* (
          resource: string,
        ) {
          const audience = yield* getOAuthAudience(resource);
          const oauthToken = yield* getOAuthToken(serviceScopes, audience);
          yield* Effect.logDebug("Using OAuth ingress forwarding token", { resource });
          return Redacted.value(oauthToken.accessToken);
        }),
        getDelegatedAuthorization: Effect.fn("SheetApisRpcTokens.getDelegatedAuthorization")(
          function* ({
            resource,
            user,
          }: {
            readonly resource: string;
            readonly user: SheetAuthUserType;
          }) {
            const audience = yield* getOAuthAudience(resource);
            if (resource === sheetBotResource || HashSet.has(user.permissions, "service")) {
              return yield* Effect.map(
                createOAuthClientCredentialsToken(sheetAuthClient, {
                  clientId: oauthClientId,
                  clientSecret: oauthClientSecret,
                  scope: serviceScopes,
                  resource: audience,
                }),
                (token) => token.accessToken,
              );
            }

            if (user.tokenType !== "session" && user.tokenType !== "oauth_access_token") {
              return yield* Effect.fail(
                new Unauthorized({ message: "Cannot delegate unavailable sheet-auth token" }),
              );
            }

            const scopes = delegatedUserScopes(user);
            const actorToken = yield* createOAuthClientCredentialsToken(sheetAuthClient, {
              clientId: tokenExchangeOAuthClient.clientId,
              clientSecret: tokenExchangeOAuthClient.clientSecret,
              scope: actorScopes,
              resource: yield* getOAuthAudience(sheetIngressResource),
            });
            const delegatedToken = yield* exchangeOAuthToken(sheetAuthClient, {
              subjectToken: user.token,
              subjectTokenType:
                user.tokenType === "oauth_access_token" ? AccessTokenType : SessionTokenType,
              actorToken: actorToken.accessToken,
              actorTokenType: AccessTokenType,
              requestedTokenType: AccessTokenType,
              resource: audience,
              scope: scopes,
            });

            yield* Effect.logDebug("Using OAuth ingress delegation token", { resource });
            return delegatedToken.accessToken;
          },
        ),
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
