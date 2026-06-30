import {
  Cache,
  Context,
  Duration,
  Effect,
  Exit,
  HashSet,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import {
  getSheetAuthIdentity,
  type SheetAuthClient as SheetAuthClientValue,
} from "sheet-auth/client";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import type { SheetAuthUserTokenType } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { Unauthorized } from "typhoon-core/error";
import {
  SheetAuthOAuthScope,
  type Permission,
  type PermissionSet,
} from "sheet-ingress-api/schemas/permissions";
import { SheetBotForwardingClient } from "./sheetBotForwardingClient";
import { SheetAuthClient } from "./sheetAuthClient";

const SUCCESS_TTL = Duration.seconds(30);
const FAILURE_TTL = Duration.seconds(1);

interface CachedAuthorization {
  readonly userId: string;
  readonly accountId: string;
  readonly permissions: PermissionSet;
  readonly scopes: ReadonlySet<SheetAuthOAuthScope>;
  readonly tokenType: SheetAuthUserTokenType;
}

type SheetAuthUserType = Context.Service.Shape<typeof SheetAuthUser>;

const permissionSetFromIterable = (permissions: Iterable<Permission>): PermissionSet =>
  HashSet.fromIterable(permissions);

const hasPermission = (permissions: PermissionSet, permission: Permission) =>
  HashSet.has(permissions, permission);

const appendPermission = (permissions: PermissionSet, permission: Permission): PermissionSet =>
  HashSet.add(permissions, permission);

const isSheetAuthOAuthScope = Schema.is(SheetAuthOAuthScope);

export const sheetAuthOAuthScopeSetFromIterable = (
  scopes: Iterable<string>,
): ReadonlySet<SheetAuthOAuthScope> =>
  new Set(Array.from(scopes).filter(isSheetAuthOAuthScope)) as ReadonlySet<SheetAuthOAuthScope>;

const makeUnauthorized = (message: string, cause?: unknown) =>
  new Unauthorized({
    message: `Invalid sheet-auth token: ${message}`,
    cause,
  });

const resolveCachedAuthorization = Effect.fn("resolveCachedAuthorization")(function* (
  authClient: SheetAuthClientValue,
  token: Redacted.Redacted<string>,
) {
  const authorizationHeaders = {
    Authorization: `Bearer ${Redacted.value(token)}`,
  };

  const identity = yield* getSheetAuthIdentity(authClient, authorizationHeaders).pipe(
    Effect.mapError((error) => makeUnauthorized(error.message, error.cause)),
  );

  return {
    userId: identity.userId,
    accountId: identity.accountId,
    permissions: permissionSetFromIterable(
      identity.permissions.filter(
        (permission): permission is Permission => permission === "service",
      ),
    ),
    scopes: sheetAuthOAuthScopeSetFromIterable(identity.scopes),
    tokenType: identity.tokenType,
  } satisfies CachedAuthorization;
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
      const authorizationCache = yield* Cache.makeWith(
        (token: Redacted.Redacted<string>) => resolveCachedAuthorization(authClient, token),
        {
          capacity: 10_000,
          timeToLive: Exit.match({
            onFailure: () => FAILURE_TTL,
            onSuccess: () => SUCCESS_TTL,
          }),
        },
      );

      const resolveBaseAuthorizationPermissions = Effect.fn(
        "SheetAuthUserResolver.resolveBaseAuthorizationPermissions",
      )(function* (authorization: CachedAuthorization) {
        let permissions = appendPermission(
          authorization.permissions,
          `account:discord:${authorization.accountId}`,
        );

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
            permissions,
            scopes: authorization.scopes,
            token,
            tokenType: authorization.tokenType,
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
