import { Cache, Context, Duration, Effect, Exit, HashSet, Layer, Option, Redacted } from "effect";
import {
  getAccount,
  getKubernetesOAuthImplicitPermissions,
  type SheetAuthClient as SheetAuthClientValue,
} from "sheet-auth/client";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { Unauthorized } from "typhoon-core/error";
import type { Permission, PermissionSet } from "sheet-ingress-api/schemas/permissions";
import { config } from "@/config";
import { SheetBotForwardingClient } from "./sheetBotForwardingClient";
import { SheetAuthClient } from "./sheetAuthClient";

const SUCCESS_TTL = Duration.seconds(30);
const FAILURE_TTL = Duration.seconds(1);

interface CachedAuthorization {
  readonly userId: string;
  readonly accountId: string;
  readonly permissions: PermissionSet;
  readonly clientId?: string;
  readonly trustedClient?: boolean;
  readonly allowedServices?: HashSet.HashSet<string>;
  readonly allowedScopes?: HashSet.HashSet<string>;
}

type SheetAuthUserType = Context.Service.Shape<typeof SheetAuthUser>;

const permissionSetFromIterable = (permissions: Iterable<Permission>): PermissionSet =>
  HashSet.fromIterable(permissions);

const hasPermission = (permissions: PermissionSet, permission: Permission) =>
  HashSet.has(permissions, permission);

const appendPermission = (permissions: PermissionSet, permission: Permission): PermissionSet =>
  HashSet.add(permissions, permission);

const makeUnauthorized = (message: string, cause?: unknown) =>
  new Unauthorized({
    message: `Invalid sheet-auth token: ${message}`,
    cause,
  });

const toBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean"
    ? value
    : typeof value === "string"
      ? value.toLowerCase() === "true"
      : undefined;

const toStringArray = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? value
          .trim()
          .split(/[,\s]+/)
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
      : [];

const resolveKubernetesAuthorization = Effect.fn("resolveKubernetesAuthorization")(function* (
  authClient: SheetAuthClientValue,
  token: Redacted.Redacted<string>,
) {
  const authorizationHeaders = {
    Authorization: `Bearer ${Redacted.value(token)}`,
  };

  const { account, permissions } = yield* Effect.all({
    account: getAccount(authClient, ["discord", "kubernetes:discord"], authorizationHeaders),
    permissions: getKubernetesOAuthImplicitPermissions(authClient, authorizationHeaders).pipe(
      Effect.catch(() => Effect.succeed({ permissions: [] as string[] })),
    ),
  }).pipe(Effect.mapError((error) => makeUnauthorized(error.message, error.cause)));

  const discardedPermissions = permissions.permissions.filter(
    (permission: string) => permission !== "service",
  );
  if (discardedPermissions.length > 0) {
    yield* Effect.logWarning(
      `Ignoring implicit permissions that are now derived server-side: ${discardedPermissions.join(", ")}`,
    );
  }

  return {
    userId: account.userId,
    accountId: account.accountId,
    permissions: permissions.permissions.some((permission: string) => permission === "service")
      ? permissionSetFromIterable(["service"] satisfies Extract<Permission, "service">[])
      : permissionSetFromIterable([] as Permission[]),
  } satisfies CachedAuthorization;
});

interface OAuthTokenIntrospectionResponse {
  readonly active?: boolean;
  readonly client_id?: string;
  readonly sub?: string;
  readonly scope?: string;
  readonly aud?: string;
  readonly trusted_client?: boolean;
  readonly trustedServiceClient?: boolean;
  readonly allowed_services?: unknown;
  readonly allowedServices?: unknown;
  readonly allowed_scopes?: unknown;
  readonly allowedScopes?: unknown;
  readonly owner_user_id?: string;
  readonly client_type?: string;
  readonly status?: string;
}

const toBasicAuthHeader = (clientId: string, clientSecret: Redacted.Redacted<string>) =>
  `Basic ${Buffer.from(`${clientId}:${Redacted.value(clientSecret)}`).toString("base64")}`;

// fallow-ignore-next-line complexity
const parseOAuthIntrospectionClaims = Effect.fn("parseOAuthIntrospectionClaims")(function* (
  claims: OAuthTokenIntrospectionResponse,
) {
  const resolvedClientId = claims.client_id;
  if (typeof resolvedClientId !== "string" || resolvedClientId.length === 0) {
    return yield* Effect.fail(new Unauthorized({ message: "OAuth token has no client_id" }));
  }

  const status = typeof claims.status === "string" ? claims.status.toLowerCase() : undefined;
  if (status === "disabled" || status === "inactive") {
    return yield* Effect.fail(
      new Unauthorized({ message: `OAuth client status is ${claims.status}` }),
    );
  }

  return {
    userId: claims.owner_user_id ?? claims.sub ?? resolvedClientId,
    accountId: `oauth-client:${resolvedClientId}`,
    clientId: resolvedClientId,
    trustedClient: toBoolean(claims.trusted_client ?? claims.trustedServiceClient),
    allowedServices: HashSet.fromIterable(
      toStringArray(claims.allowed_services ?? claims.allowedServices),
    ),
    allowedScopes: HashSet.fromIterable(
      toStringArray(claims.allowed_scopes ?? claims.allowedScopes ?? claims.scope),
    ),
    permissions: permissionSetFromIterable(
      toStringArray(claims.scope).filter(
        (scope): scope is Permission => scope === "service" || scope === "app_owner",
      ),
    ),
  } satisfies CachedAuthorization;
});

const fetchOAuthIntrospectionClaims = Effect.fn("fetchOAuthIntrospectionClaims")(function* (
  token: Redacted.Redacted<string>,
  clientId: string,
  clientSecret: Redacted.Redacted<string>,
) {
  const introspectionUrl = new URL("/oauth2/introspect", yield* config.sheetAuthIssuer).toString();
  const form = new URLSearchParams({
    token: Redacted.value(token),
    token_type_hint: "access_token",
    client_id: clientId,
  });
  const response = yield* Effect.tryPromise({
    try: async () =>
      fetch(introspectionUrl, {
        method: "POST",
        headers: {
          authorization: toBasicAuthHeader(clientId, clientSecret),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form,
      }),
    catch: (cause) => makeUnauthorized("OAuth introspection request failed", cause),
  });

  if (!response.ok) {
    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => Effect.succeed(""),
    });
    return yield* Effect.fail(
      makeUnauthorized(
        `OAuth introspection failed with status ${response.status}: ${body || "<empty body>"}`,
      ),
    );
  }

  return yield* Effect.tryPromise({
    try: () => response.json().then((payload) => payload as OAuthTokenIntrospectionResponse),
    catch: (cause) => makeUnauthorized("OAuth introspection response parse failed", cause),
  });
});

const unauthorizedIfCredentialsMissing = (
  introspectionClientId: Option.Option<string>,
  introspectionClientSecret: Option.Option<Redacted.Redacted<string>>,
) =>
  Option.isNone(introspectionClientId) || Option.isNone(introspectionClientSecret)
    ? new Unauthorized({ message: "OAuth client introspection credentials are not configured" })
    : undefined;

const parseActiveToken = (claims: OAuthTokenIntrospectionResponse) => {
  if (claims.active !== true) {
    return new Unauthorized({ message: "OAuth token is not active" });
  }
  return undefined;
};

const resolveOAuthClientAuthorization = Effect.fn("resolveOAuthClientAuthorization")(function* (
  token: Redacted.Redacted<string>,
) {
  const introspectionClientId = yield* config.sheetAuthOAuthIntrospectionClientId;
  const introspectionClientSecret = yield* config.sheetAuthOAuthIntrospectionClientSecret;
  const introspectionClientIdValue = Option.getOrElse(introspectionClientId, () => "");
  const introspectionClientSecretValue = Option.getOrElse(introspectionClientSecret, () =>
    Redacted.make(""),
  );

  const credentialsMissing = unauthorizedIfCredentialsMissing(
    introspectionClientId,
    introspectionClientSecret,
  );
  if (credentialsMissing !== undefined) {
    return yield* Effect.fail(credentialsMissing);
  }
  const introspectionClaims = yield* fetchOAuthIntrospectionClaims(
    token,
    introspectionClientIdValue,
    introspectionClientSecretValue,
  );

  const inactiveError = parseActiveToken(introspectionClaims);
  if (inactiveError !== undefined) {
    return yield* Effect.fail(inactiveError);
  }

  return yield* parseOAuthIntrospectionClaims(introspectionClaims);
});

const resolveCachedAuthorization = Effect.fn("resolveCachedAuthorization")(function* (
  authClient: SheetAuthClientValue,
  token: Redacted.Redacted<string>,
) {
  return yield* resolveKubernetesAuthorization(authClient, token).pipe(
    Effect.catch(() =>
      resolveOAuthClientAuthorization(token).pipe(
        Effect.mapError((cause) => makeUnauthorized("Invalid OAuth bearer token", cause)),
      ),
    ),
  );
});

class ApplicationOwnerResolver extends Context.Service<ApplicationOwnerResolver>()(
  "ApplicationOwnerResolver",
  {
    make: Effect.gen(function* () {
      const sheetBotForwardingClient = yield* SheetBotForwardingClient;
      const application = yield* Cache.makeWith(
        Effect.fn("ApplicationOwnerResolver.lookup")(function* (_key: string) {
          return yield* sheetBotForwardingClient.application.getApplication().pipe(
            Effect.map(({ ownerId }) => Option.some(ownerId)),
            Effect.orElseSucceed(() => Option.none<string>()),
          );
        }),
        {
          capacity: 1,
          timeToLive: Exit.match({
            onFailure: () => Duration.minutes(1),
            onSuccess: (ownerId) =>
              Option.isSome(ownerId) ? Duration.hours(6) : Duration.minutes(1),
          }),
        },
      );

      return {
        getOwnerId: Effect.fn("ApplicationOwnerResolver.getOwnerId")(function* () {
          return yield* Cache.get(application, "owner");
        }),
      };
    }),
  },
) {
  static layer = Layer.effect(ApplicationOwnerResolver, this.make).pipe(
    Layer.provide(SheetBotForwardingClient.layer),
  );
}

export class SheetAuthUserResolver extends Context.Service<SheetAuthUserResolver>()(
  "SheetAuthUserResolver",
  {
    make: Effect.gen(function* () {
      const authClient = yield* SheetAuthClient;
      const applicationOwnerResolver = yield* ApplicationOwnerResolver;
      const resolveCachedAuthorizationForToken = (token: Redacted.Redacted<string>) =>
        resolveCachedAuthorization(authClient, token) as Effect.Effect<
          CachedAuthorization,
          Unauthorized,
          never
        >;

      const authorizationCache = yield* Cache.makeWith(resolveCachedAuthorizationForToken, {
        capacity: 10_000,
        timeToLive: Exit.match({
          onFailure: () => FAILURE_TTL,
          onSuccess: () => SUCCESS_TTL,
        }),
      });

      const resolveBaseAuthorizationPermissions = Effect.fn(
        "SheetAuthUserResolver.resolveBaseAuthorizationPermissions",
      )(function* (authorization: CachedAuthorization) {
        let permissions = authorization.permissions;

        if (!authorization.clientId) {
          permissions = appendPermission(permissions, `account:discord:${authorization.accountId}`);
        }

        if (hasPermission(permissions, "service")) {
          return permissions;
        }

        const maybeOwnerId = yield* applicationOwnerResolver.getOwnerId().pipe(
          Effect.tapError(Effect.logError),
          Effect.orElseSucceed(() => Option.none<string>()),
        );
        if (Option.isSome(maybeOwnerId) && maybeOwnerId.value === authorization.accountId) {
          permissions = appendPermission(permissions, "app_owner");
        }

        return permissions;
      });

      return {
        resolveToken: Effect.fn("SheetAuthUserResolver.resolveToken")(function* (
          token: Redacted.Redacted<string>,
        ) {
          const authorization = yield* Cache.get(authorizationCache, token);
          const permissions = yield* resolveBaseAuthorizationPermissions(authorization);

          return {
            accountId: authorization.accountId,
            userId: authorization.userId,
            clientId: authorization.clientId,
            trustedClient: authorization.trustedClient,
            allowedServices: authorization.allowedServices,
            allowedScopes: authorization.allowedScopes,
            permissions,
            token,
          } satisfies SheetAuthUserType;
        }),
      };
    }),
  },
) {
  static layer = Layer.effect(SheetAuthUserResolver, this.make).pipe(
    Layer.provide([ApplicationOwnerResolver.layer, SheetAuthClient.layer]),
  );
}
