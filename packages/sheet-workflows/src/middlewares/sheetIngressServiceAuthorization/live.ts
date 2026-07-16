// fallow-ignore-file code-duplication
import { Effect, HashSet, Layer, Predicate, Redacted, Schema } from "effect";
import { makeOAuthResourceTokenAuthorizer } from "sheet-auth/oauth-resource-authorization";
import type { VerifiedOAuthResourceToken } from "sheet-auth/oauth-resource-authorization";
import { DISCORD_SERVICE_USER_ID_SENTINEL } from "sheet-auth/oauth";
import { SheetIngressServiceAuthorization } from "sheet-ingress-api/internal";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { SheetAuthOAuthScope, type Permission } from "sheet-ingress-api/schemas/permissions";
import { Unauthorized } from "typhoon-core/error";
import { config } from "@/config";

const isSheetAuthOAuthScope = Schema.is(SheetAuthOAuthScope);
type VerifiedIngressToken = VerifiedOAuthResourceToken;

const toSheetAuthOAuthScopes = (scopes: ReadonlySet<string>) =>
  new Set(Array.from(scopes).filter(isSheetAuthOAuthScope)) as ReadonlySet<SheetAuthOAuthScope>;

const hasWorkflowDispatchScope = (scopes: ReadonlySet<SheetAuthOAuthScope>) =>
  scopes.has("workflow.dispatch");

const hasActorClaims = (token: VerifiedIngressToken) =>
  [token.actorClientId, token.actorSub].some(Predicate.isString);

const hasTrustedClientId = (clientId: unknown, trustedClientIds: ReadonlySet<string>) =>
  Predicate.isString(clientId) && trustedClientIds.has(clientId);

const isTrustedServiceToken = (
  token: VerifiedIngressToken,
  trustedClientIds: ReadonlySet<string>,
) =>
  token.scopes.has("service") &&
  !hasActorClaims(token) &&
  hasTrustedClientId(token.clientId, trustedClientIds);

const isTrustedDelegationToken = (
  token: VerifiedIngressToken,
  trustedClientIds: ReadonlySet<string>,
) =>
  [token.clientId, token.actorClientId].every((clientId) =>
    hasTrustedClientId(clientId, trustedClientIds),
  ) &&
  Predicate.isString(token.actorSub) &&
  Predicate.isString(token.sub) &&
  Predicate.isString(token.accountId);

const provideServiceUser = <A, E, R>(
  httpEffect: Effect.Effect<A, E, R>,
  credential: Redacted.Redacted<string>,
  scopes: ReadonlySet<SheetAuthOAuthScope>,
) =>
  httpEffect.pipe(
    Effect.provideService(SheetAuthUser, {
      accountId: DISCORD_SERVICE_USER_ID_SENTINEL,
      userId: DISCORD_SERVICE_USER_ID_SENTINEL,
      permissions: HashSet.fromIterable(["service"] satisfies Permission[]),
      scopes,
      token: credential,
      tokenType: "service",
    }),
  );

const provideDelegatedUser = <A, E, R>(
  httpEffect: Effect.Effect<A, E, R>,
  token: VerifiedIngressToken,
  credential: Redacted.Redacted<string>,
  scopes: ReadonlySet<SheetAuthOAuthScope>,
) =>
  httpEffect.pipe(
    Effect.provideService(SheetAuthUser, {
      accountId: token.accountId!,
      userId: token.sub!,
      permissions: HashSet.fromIterable([
        `account:discord:${token.accountId}`,
      ] satisfies Permission[]),
      scopes,
      token: credential,
      tokenType: "delegated_oauth_access_token",
    }),
  );

export const SheetIngressServiceAuthorizationLive = Layer.effect(
  SheetIngressServiceAuthorization,
  Effect.gen(function* () {
    const audience = yield* config.sheetAuthOAuthAudience;
    const sheetAuthIssuer = yield* config.sheetAuthIssuer;
    const oauthClientId = yield* config.sheetAuthOAuthClientId;
    const configuredTrustedClientIds = yield* config.sheetAuthTrustedDelegationClientIds;
    const trustedClientIds = new Set(
      configuredTrustedClientIds.length > 0 ? configuredTrustedClientIds : [oauthClientId],
    );
    const oauthAuthorizer = yield* makeOAuthResourceTokenAuthorizer({
      issuer: sheetAuthIssuer,
      audience,
      requiredScopes: [],
    });

    return SheetIngressServiceAuthorization.of({
      sheetIngressServiceToken: Effect.fn(
        "SheetIngressServiceAuthorization.sheetIngressServiceToken",
      )(function* (httpEffect, { credential }) {
        const token = Redacted.value(credential);
        const verified = yield* oauthAuthorizer.requireAuthorizedBearerToken(token);
        const scopes = toSheetAuthOAuthScopes(verified.scopes);

        if (isTrustedServiceToken(verified, trustedClientIds)) {
          return yield* provideServiceUser(httpEffect, credential, scopes);
        }
        if (
          isTrustedDelegationToken(verified, trustedClientIds) &&
          hasWorkflowDispatchScope(scopes)
        ) {
          return yield* provideDelegatedUser(httpEffect, verified, credential, scopes);
        }

        return yield* Effect.fail(new Unauthorized({ message: "Invalid ingress delegation" }));
      }),
    });
  }),
);
