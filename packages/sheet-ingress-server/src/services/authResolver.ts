import { Cache, Context, Duration, Effect, Exit, HashSet, Layer, Option, Redacted } from "effect";
import { HttpClient } from "effect/unstable/http";
import {
  getAccount,
  getKubernetesOAuthImplicitPermissions,
  type SheetAuthClient as SheetAuthClientValue,
} from "sheet-auth/client";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { Unauthorized } from "sheet-ingress-api/schemas/middlewares/unauthorized";
import type { Permission, PermissionSet } from "sheet-ingress-api/schemas/permissions";
import { config } from "@/config";
import { SheetApisClient } from "./sheetApisClient";
import { SheetAuthClient } from "./sheetAuthClient";

const SUCCESS_TTL = Duration.seconds(30);
const FAILURE_TTL = Duration.seconds(1);

interface CachedAuthorization {
  readonly userId: string;
  readonly accountId: string;
  readonly permissions: PermissionSet;
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

const resolveCachedAuthorization = Effect.fn("resolveCachedAuthorization")(function* (
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

export class ApplicationOwnerResolver extends Context.Service<ApplicationOwnerResolver>()(
  "ApplicationOwnerResolver",
  {
    make: Effect.gen(function* () {
      const baseUrl = yield* config.sheetBotBaseUrl;
      const sheetApisClient = yield* SheetApisClient;
      const httpClient = yield* HttpClient.HttpClient;
      const application = yield* Cache.makeWith(
        Effect.fn("ApplicationOwnerResolver.lookup")(function* (_key: string) {
          const serviceUser = yield* sheetApisClient.getServiceUser();
          const url = new URL("application", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
          const response = yield* httpClient
            .get(url, {
              headers: {
                Authorization: `Bearer ${Redacted.value(serviceUser.token)}`,
              },
            })
            .pipe(Effect.orElseSucceed(() => undefined));

          if (!response || response.status < 200 || response.status >= 300) {
            return Option.none<string>();
          }

          const json = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));

          return typeof json === "object" &&
            json !== null &&
            "ownerId" in json &&
            typeof json.ownerId === "string"
            ? Option.some(json.ownerId)
            : Option.none<string>();
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
    Layer.provide(SheetApisClient.layer),
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
