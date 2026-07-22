import { Config, Effect, HashSet, Layer, Predicate, Redacted, Schema } from "effect";
import { Unauthorized } from "typhoon-core/error";
import { SheetAuthUser } from "../../schemas/middlewares/sheetAuthUser";
import { SheetAuthOAuthScope, type Permission } from "../../schemas/permissions";
import { SheetIngressServiceAuthorization } from "./tag";

const isSheetAuthOAuthScope = Schema.is(SheetAuthOAuthScope);

export interface VerifiedIngressToken {
  readonly scopes: ReadonlySet<string>;
  readonly clientId: string | undefined;
  readonly actorClientId: string | undefined;
  readonly actorSub: string | undefined;
  readonly sub: string | undefined;
  readonly accountId: string | undefined;
}

type TrustedDelegationToken = VerifiedIngressToken & {
  readonly actorSub: string;
  readonly sub: string;
  readonly accountId: string;
};

const toSheetAuthOAuthScopes = (scopes: ReadonlySet<string>) =>
  new Set(Array.from(scopes).filter(isSheetAuthOAuthScope)) as ReadonlySet<SheetAuthOAuthScope>;

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
): token is TrustedDelegationToken =>
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
  serviceUserId: string,
) =>
  httpEffect.pipe(
    Effect.provideService(SheetAuthUser, {
      accountId: serviceUserId,
      userId: serviceUserId,
      permissions: HashSet.fromIterable(["service"] satisfies Permission[]),
      scopes,
      token: credential,
      tokenType: "service",
    }),
  );

const provideDelegatedUser = <A, E, R>(
  httpEffect: Effect.Effect<A, E, R>,
  token: TrustedDelegationToken,
  credential: Redacted.Redacted<string>,
  scopes: ReadonlySet<SheetAuthOAuthScope>,
) =>
  httpEffect.pipe(
    Effect.provideService(SheetAuthUser, {
      accountId: token.accountId,
      userId: token.sub,
      permissions: HashSet.fromIterable([
        `account:discord:${token.accountId}`,
      ] satisfies Permission[]),
      scopes,
      token: credential,
      tokenType: "delegated_oauth_access_token",
    }),
  );

export const makeSheetIngressServiceAuthorization = (options: {
  readonly verify: (token: string) => Effect.Effect<VerifiedIngressToken, Unauthorized>;
  readonly trustedClientIds: ReadonlySet<string>;
  readonly delegatedScope: SheetAuthOAuthScope;
  readonly serviceUserId: string;
}) =>
  SheetIngressServiceAuthorization.of({
    sheetIngressServiceToken: Effect.fn(
      "SheetIngressServiceAuthorization.sheetIngressServiceToken",
    )(function* (httpEffect, { credential }) {
      const verified = yield* options.verify(Redacted.value(credential));
      const scopes = toSheetAuthOAuthScopes(verified.scopes);

      if (isTrustedServiceToken(verified, options.trustedClientIds)) {
        return yield* provideServiceUser(httpEffect, credential, scopes, options.serviceUserId);
      }
      if (
        isTrustedDelegationToken(verified, options.trustedClientIds) &&
        scopes.has(options.delegatedScope)
      ) {
        return yield* provideDelegatedUser(httpEffect, verified, credential, scopes);
      }

      return yield* Effect.fail(new Unauthorized({ message: "Invalid ingress delegation" }));
    }),
  });

interface SheetIngressServiceAuthorizationConfig {
  readonly audience: string;
  readonly issuer: string;
  readonly oauthClientId: string;
  readonly trustedClientIds: readonly string[];
}

interface SheetIngressTokenAuthorizer {
  readonly requireAuthorizedBearerToken: (
    token: string,
  ) => Effect.Effect<VerifiedIngressToken, Unauthorized>;
}

/** Builds the common authorization layer used by ingress-backed services. */
export const makeSheetIngressServiceAuthorizationLayer = <E, R>(options: {
  readonly config: {
    readonly sheetAuthOAuthAudience: Config.Config<string>;
    readonly sheetAuthIssuer: Config.Config<string>;
    readonly sheetAuthOAuthClientId: Config.Config<string>;
    readonly sheetAuthTrustedDelegationClientIds: Config.Config<readonly string[]>;
  };
  readonly makeAuthorizer: (
    config: Pick<SheetIngressServiceAuthorizationConfig, "audience" | "issuer"> & {
      readonly requiredScopes: readonly string[];
    },
  ) => Effect.Effect<SheetIngressTokenAuthorizer, E, R>;
  readonly delegatedScope: SheetAuthOAuthScope;
  readonly serviceUserId: string;
}) =>
  Layer.effect(
    SheetIngressServiceAuthorization,
    Effect.gen(function* () {
      const authorizationConfig = yield* Config.all({
        audience: options.config.sheetAuthOAuthAudience,
        issuer: options.config.sheetAuthIssuer,
        oauthClientId: options.config.sheetAuthOAuthClientId,
        trustedClientIds: options.config.sheetAuthTrustedDelegationClientIds,
      });
      const configuredTrustedClientIds = authorizationConfig.trustedClientIds;
      const trustedClientIds = new Set(
        configuredTrustedClientIds.length > 0
          ? configuredTrustedClientIds
          : [authorizationConfig.oauthClientId],
      );
      const authorizer = yield* options.makeAuthorizer({
        audience: authorizationConfig.audience,
        issuer: authorizationConfig.issuer,
        requiredScopes: [],
      });

      return makeSheetIngressServiceAuthorization({
        verify: authorizer.requireAuthorizedBearerToken,
        trustedClientIds,
        delegatedScope: options.delegatedScope,
        serviceUserId: options.serviceUserId,
      });
    }),
  );
