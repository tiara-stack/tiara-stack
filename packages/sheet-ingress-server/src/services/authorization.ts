import {
  Cache,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  HashSet,
  Layer,
  Option,
  Redacted,
} from "effect";
import { SheetAuthTokenAuthorization } from "sheet-ingress-api/middlewares/sheetAuthTokenAuthorization/tag";
import { SheetAuthGuildUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthGuildUser";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { Unauthorized } from "sheet-ingress-api/schemas/middlewares/unauthorized";
import type { Permission, PermissionSet } from "sheet-ingress-api/schemas/permissions";
import { SheetAuthUserResolver } from "./authResolver";
import { decodeBearerCredential } from "./bearerCredential";
import { SheetApisClient } from "./sheetApisClient";
import {
  type CachedGuildMember,
  type CachedGuildRole,
  SheetBotCacheClient,
} from "./sheetBotCacheClient";

type SheetAuthUserType = Context.Service.Shape<typeof SheetAuthUser>;
type SheetAuthGuildUserType = Context.Service.Shape<typeof SheetAuthGuildUser>;
type GuildPermissionScope = "member" | "monitor" | "manage";
class ResolvedGuildUserCacheKey extends Data.Class<{
  readonly guildId: string;
  readonly token: Redacted.Redacted<string>;
}> {}

export const permissionSetFromIterable = (permissions: Iterable<Permission>): PermissionSet =>
  HashSet.fromIterable(permissions);

export const hasPermission = (permissions: PermissionSet, permission: Permission) =>
  HashSet.has(permissions, permission);

export const hasGuildPermission = (
  permissions: PermissionSet,
  prefix: "member_guild" | "monitor_guild" | "manage_guild",
  guildId: string,
) => HashSet.has(permissions, `${prefix}:${guildId}`);

export const hasDiscordAccountPermission = (permissions: PermissionSet, accountId: string) =>
  HashSet.has(permissions, `account:discord:${accountId}`);

const requirePermissions = (
  permissions: PermissionSet,
  predicate: (permissions: PermissionSet) => boolean,
  message: string,
) => (predicate(permissions) ? Effect.void : Effect.fail(new Unauthorized({ message })));

const appendPermission = (permissions: PermissionSet, permission: Permission): PermissionSet =>
  HashSet.add(permissions, permission);

const appendPermissions = (
  permissions: PermissionSet,
  nextPermissions: Iterable<Permission>,
): PermissionSet => HashSet.union(permissions, permissionSetFromIterable(nextPermissions));

const manageGuildPermission = 0x20n;
const administratorPermission = 0x08n;

const hasManageGuildPermission = (
  member: CachedGuildMember,
  roles: ReadonlyMap<string, CachedGuildRole>,
) =>
  member.roles.some((roleId) => {
    const role = roles.get(roleId);
    if (!role) {
      return false;
    }

    const permissions = BigInt(role.permissions);
    return (
      (permissions & manageGuildPermission) === manageGuildPermission ||
      (permissions & administratorPermission) === administratorPermission
    );
  });

const hasMonitorGuildPermission = (
  member: CachedGuildMember,
  monitorRoleIds: ReadonlySet<string>,
) => member.roles.some((roleId) => monitorRoleIds.has(roleId));

const makeSheetAuthGuildUser = (
  user: SheetAuthUserType,
  guildId: string,
  permissions: PermissionSet,
): SheetAuthGuildUserType => ({
  accountId: user.accountId,
  userId: user.userId,
  guildId,
  permissions,
  token: user.token,
});

const provideResolvedGuildUser = Effect.fn("AuthorizationService.provideResolvedGuildUser")(
  function* <A, E, E2, R, R2>(
    resolvedGuildUser: Effect.Effect<SheetAuthGuildUserType, E2, R2>,
    effect: Effect.Effect<A, E, R>,
  ) {
    const user = yield* resolvedGuildUser;
    return yield* effect.pipe(Effect.provideService(SheetAuthGuildUser, user));
  },
);

export class AuthorizationService extends Context.Service<AuthorizationService>()(
  "AuthorizationService",
  {
    make: Effect.gen(function* () {
      const sheetApisClient = yield* SheetApisClient;
      const sheetBotCacheClient = yield* SheetBotCacheClient;

      const getOptionalGuildMember = Effect.fn("AuthorizationService.getOptionalGuildMember")(
        function* (guildId: string, accountId: string) {
          return yield* sheetBotCacheClient.getMember(guildId, accountId).pipe(
            Effect.tapError(Effect.logError),
            Effect.orElseSucceed(() => Option.none<CachedGuildMember>()),
          );
        },
      );

      const getOptionalMonitorRoleIds = Effect.fn("AuthorizationService.getOptionalMonitorRoleIds")(
        function* (guildId: string) {
          return yield* sheetApisClient
            .withServiceUser(
              sheetApisClient.guildConfig.getGuildMonitorRoles({ query: { guildId } }),
            )
            .pipe(
              Effect.map((roles) =>
                Option.some(new Set(roles.map((role) => role.roleId)) as ReadonlySet<string>),
              ),
              Effect.tapError(Effect.logError),
              Effect.orElseSucceed(() => Option.none<ReadonlySet<string>>()),
            );
        },
      );

      const getOptionalGuildRoles = (guildId: string) =>
        sheetBotCacheClient
          .getRolesForGuild(guildId)
          .pipe(Effect.tapError(Effect.logError), Effect.option);

      const resolveGuildScopedPermissions = Effect.fn(
        "AuthorizationService.resolveGuildScopedPermissions",
      )(function* (user: SheetAuthUserType, guildId: string) {
        if (
          hasPermission(user.permissions, "service") ||
          hasPermission(user.permissions, "app_owner")
        ) {
          return appendPermissions(user.permissions, [
            `member_guild:${guildId}`,
            `monitor_guild:${guildId}`,
            `manage_guild:${guildId}`,
          ]);
        }

        const [maybeMember, maybeMonitorRoleIds, maybeRoles] = yield* Effect.all(
          [
            getOptionalGuildMember(guildId, user.accountId),
            getOptionalMonitorRoleIds(guildId),
            getOptionalGuildRoles(guildId),
          ],
          { concurrency: "unbounded" },
        );

        let permissions = user.permissions;

        if (Option.isSome(maybeMember)) {
          permissions = appendPermission(permissions, `member_guild:${guildId}`);
        }

        if (
          Option.isSome(maybeMember) &&
          Option.isSome(maybeMonitorRoleIds) &&
          maybeMonitorRoleIds.value.size > 0 &&
          hasMonitorGuildPermission(maybeMember.value, maybeMonitorRoleIds.value)
        ) {
          permissions = appendPermission(permissions, `monitor_guild:${guildId}`);
        }

        if (
          Option.isSome(maybeMember) &&
          Option.isSome(maybeRoles) &&
          hasManageGuildPermission(maybeMember.value, maybeRoles.value)
        ) {
          permissions = appendPermission(permissions, `manage_guild:${guildId}`);
        }

        return permissions;
      });

      const resolveSheetAuthGuildUser = Effect.fn("AuthorizationService.resolveSheetAuthGuildUser")(
        function* (user: SheetAuthUserType, guildId: string) {
          const permissions = yield* resolveGuildScopedPermissions(user, guildId);
          return makeSheetAuthGuildUser(user, guildId, permissions);
        },
      );

      const resolvedGuildUserCache = yield* Cache.makeWith<
        ResolvedGuildUserCacheKey,
        SheetAuthGuildUserType,
        never,
        SheetAuthUser
      >(
        Effect.fn("AuthorizationService.resolveCurrentGuildUserCached")(function* ({
          guildId,
          token,
        }) {
          const user = yield* SheetAuthUser;
          return yield* resolveSheetAuthGuildUser({ ...user, token }, guildId);
        }),
        {
          capacity: 1_000,
          timeToLive: Exit.match({
            onFailure: () => Duration.seconds(1),
            onSuccess: () => Duration.seconds(30),
          }),
        },
      );

      const resolveCurrentGuildUser = Effect.fn("AuthorizationService.resolveCurrentGuildUser")(
        function* (guildId: string) {
          const user = yield* SheetAuthUser;
          return yield* Cache.get(
            resolvedGuildUserCache,
            new ResolvedGuildUserCacheKey({
              guildId,
              token: user.token,
            }),
          );
        },
      );

      const provideCurrentGuildUser = <A, E, R>(guildId: string, effect: Effect.Effect<A, E, R>) =>
        provideResolvedGuildUser(resolveCurrentGuildUser(guildId), effect);

      const getRequiredCurrentGuildUser = Effect.fn(
        "AuthorizationService.getRequiredCurrentGuildUser",
      )(function* (guildId: string) {
        const user = yield* SheetAuthGuildUser;

        if (user.guildId === guildId) {
          return user;
        }

        return yield* Effect.die(
          new Error(
            `SheetAuthGuildUser guild mismatch: expected ${guildId}, received ${user.guildId}`,
          ),
        );
      });

      const requireResolvedGuildPermission = Effect.fn(
        "AuthorizationService.requireResolvedGuildPermission",
      )(function* (guildId: string, scope: GuildPermissionScope, message: string) {
        const user = yield* getRequiredCurrentGuildUser(guildId);
        const hasRequiredScope =
          scope === "member"
            ? hasGuildPermission(user.permissions, "member_guild", guildId)
            : scope === "monitor"
              ? hasGuildPermission(user.permissions, "monitor_guild", guildId)
              : hasGuildPermission(user.permissions, "manage_guild", guildId);

        if (!hasRequiredScope) {
          return yield* Effect.fail(new Unauthorized({ message }));
        }
      });

      return {
        resolveSheetAuthGuildUser,
        resolveCurrentGuildUser,
        provideCurrentGuildUser,
        getCurrentGuildMonitorAccessLevel: Effect.fn(
          "AuthorizationService.getCurrentGuildMonitorAccessLevel",
        )(function* (guildId: string) {
          const resolvedUser = yield* resolveCurrentGuildUser(guildId);

          if (hasGuildPermission(resolvedUser.permissions, "monitor_guild", guildId)) {
            return "monitor" as const;
          }

          if (hasGuildPermission(resolvedUser.permissions, "member_guild", guildId)) {
            return "member" as const;
          }

          return "none" as const;
        }),
        requireManageGuild: (
          guildId: string,
          message = "User does not have manage guild permission",
        ) =>
          provideCurrentGuildUser(
            guildId,
            requireResolvedGuildPermission(guildId, "manage", message),
          ),
        requireMonitorGuild: (
          guildId: string,
          message = "User does not have monitor guild permission",
        ) =>
          provideCurrentGuildUser(
            guildId,
            requireResolvedGuildPermission(guildId, "monitor", message),
          ),
        requireGuildMember: (guildId: string, message = "User is not a member of this guild") =>
          provideCurrentGuildUser(
            guildId,
            requireResolvedGuildPermission(guildId, "member", message),
          ),
        requireService: Effect.fn("AuthorizationService.requireService")(function* (
          message = "User is not the service user",
        ) {
          const user = yield* SheetAuthUser;
          return yield* requirePermissions(
            user.permissions,
            (permissions) => hasPermission(permissions, "service"),
            message,
          );
        }),
        requireDiscordAccountId: Effect.fn("AuthorizationService.requireDiscordAccountId")(
          function* (accountId: string, message = "User does not have access to this user") {
            const user = yield* SheetAuthUser;
            return yield* requirePermissions(
              user.permissions,
              (permissions) =>
                hasPermission(permissions, "service") ||
                hasPermission(permissions, "app_owner") ||
                hasDiscordAccountPermission(permissions, accountId),
              message,
            );
          },
        ),
        requireDiscordAccountIdOrMonitorGuild: Effect.fn(
          "AuthorizationService.requireDiscordAccountIdOrMonitorGuild",
        )(function* (
          guildId: string,
          accountId: string,
          message = "User does not have access to this user",
        ) {
          const user = yield* resolveCurrentGuildUser(guildId);

          if (
            hasPermission(user.permissions, "service") ||
            hasPermission(user.permissions, "app_owner") ||
            hasDiscordAccountPermission(user.permissions, accountId) ||
            hasGuildPermission(user.permissions, "monitor_guild", guildId)
          ) {
            return;
          }

          return yield* Effect.fail(new Unauthorized({ message }));
        }),
      };
    }),
  },
) {
  static layer = Layer.effect(AuthorizationService, this.make).pipe(
    Layer.provide([SheetApisClient.layer, SheetBotCacheClient.layer]),
  );
}

export const SheetAuthTokenAuthorizationLive = Layer.effect(
  SheetAuthTokenAuthorization,
  Effect.gen(function* () {
    const sheetAuthUserResolver = yield* SheetAuthUserResolver;

    return SheetAuthTokenAuthorization.of({
      sheetAuthToken: Effect.fn("SheetAuthTokenAuthorization.sheetAuthToken")(function* (
        httpEffect,
        { credential },
      ) {
        const token = decodeBearerCredential(credential);
        const resolvedUser = yield* sheetAuthUserResolver.resolveToken(token);

        return yield* Effect.provideService(httpEffect, SheetAuthUser, {
          accountId: resolvedUser.accountId,
          userId: resolvedUser.userId,
          permissions: resolvedUser.permissions,
          token,
        });
      }),
    });
  }),
).pipe(Layer.provide(SheetAuthUserResolver.layer));
