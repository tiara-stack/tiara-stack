import { MembersApiCacheView } from "dfx-discord-utils/discord/cache/members";
import { RolesApiCacheView } from "dfx-discord-utils/discord/cache/roles";
import { CacheNotFoundError } from "dfx-discord-utils/discord/schema";
import type { CachedGuildMember } from "dfx-discord-utils/cache";
import { Discord, Perms } from "dfx";
import { Effect, HashSet, Layer, Option, Context } from "effect";
import type { Permission, PermissionSet } from "sheet-ingress-api/schemas/permissions";
import { SheetAuthGuildUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthGuildUser";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { Unauthorized } from "typhoon-core/error";
import { GuildConfigService } from "./guildConfig";
import { discordLayer } from "./discord";

type SheetAuthUserType = Context.Service.Shape<typeof SheetAuthUser>;
type SheetAuthGuildUserType = Context.Service.Shape<typeof SheetAuthGuildUser>;

type GuildPermissionScope = "member" | "monitor" | "manage";

interface ResolvedGuildPermissions {
  permissions: PermissionSet;
  maybeMember: Option.Option<CachedGuildMember>;
}

// fallow-ignore-next-line code-duplication
export const permissionSetFromIterable = (permissions: Iterable<Permission>): PermissionSet =>
  HashSet.fromIterable(permissions);

// fallow-ignore-next-line code-duplication
export const hasPermission = (permissions: PermissionSet, permission: Permission) =>
  HashSet.has(permissions, permission);

// fallow-ignore-next-line code-duplication
export const hasGuildPermission = (
  permissions: PermissionSet,
  prefix: "member_guild" | "monitor_guild" | "manage_guild",
  guildId: string,
) => HashSet.has(permissions, `${prefix}:${guildId}`);

// fallow-ignore-next-line code-duplication
export const hasDiscordAccountPermission = (permissions: PermissionSet, accountId: string) =>
  HashSet.has(permissions, `account:discord:${accountId}`);

const requirePermissions = (
  permissions: PermissionSet,
  predicate: (permissions: PermissionSet) => boolean,
  message: string,
) => (predicate(permissions) ? Effect.void : Effect.fail(new Unauthorized({ message })));

// fallow-ignore-next-line code-duplication
export const appendPermission = (
  permissions: PermissionSet,
  permission: Permission,
): PermissionSet => HashSet.add(permissions, permission);

// fallow-ignore-next-line code-duplication
const appendPermissions = (
  permissions: PermissionSet,
  nextPermissions: Iterable<Permission>,
): PermissionSet => HashSet.union(permissions, permissionSetFromIterable(nextPermissions));

// fallow-ignore-next-line code-duplication
const hasManageGuildPermission = (
  member: CachedGuildMember,
  roles: ReadonlyMap<string, Discord.GuildRoleResponse>,
) => {
  const resolvedUserPermissions = Perms.forMember([...roles.values()])(
    member as Discord.GuildMemberResponse,
  );

  return Perms.has(Discord.Permissions.ManageGuild)(resolvedUserPermissions);
};

// fallow-ignore-next-line code-duplication
const hasMonitorGuildPermission = (
  member: { roles: ReadonlyArray<string> },
  monitorRoleIds: ReadonlySet<string>,
) => member.roles.some((roleId) => monitorRoleIds.has(roleId));

// fallow-ignore-next-line code-duplication
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

// fallow-ignore-next-line code-duplication
const provideResolvedGuildUser = Effect.fn("AuthorizationService.provideResolvedGuildUser")(
  function* <A, E, R, R2>(
    resolvedGuildUser: Effect.Effect<SheetAuthGuildUserType, never, R2>,
    effect: Effect.Effect<A, E, R>,
  ) {
    const user = yield* resolvedGuildUser;
    return yield* effect.pipe(Effect.provideService(SheetAuthGuildUser, user)) as Effect.Effect<
      A,
      E,
      Exclude<R, SheetAuthGuildUser>
    >;
  },
);

export class AuthorizationService extends Context.Service<AuthorizationService>()(
  "AuthorizationService",
  {
    make: Effect.gen(function* () {
      const membersCache = yield* MembersApiCacheView;
      const guildConfigService = yield* GuildConfigService;
      const rolesCache = yield* RolesApiCacheView;

      const getOptionalGuildMember = Effect.fn("AuthorizationService.getOptionalGuildMember")(
        function* (guildId: string, accountId: string) {
          return yield* Effect.matchEffect(membersCache.get(guildId, accountId), {
            onSuccess: (member) => Effect.succeed(Option.some(member)),
            onFailure: Effect.fnUntraced(function* (error) {
              if (error instanceof CacheNotFoundError) {
                yield* Effect.logError(error);
              }
              return Option.none();
            }),
          });
        },
      );

      const getOptionalMonitorRoleIds = Effect.fn("AuthorizationService.getOptionalMonitorRoleIds")(
        function* (guildId: string) {
          return yield* Effect.matchEffect(guildConfigService.getGuildMonitorRoles(guildId), {
            onSuccess: (monitorRoles) =>
              Effect.succeed(
                Option.some(
                  new Set(monitorRoles.map((role) => role.roleId)) as ReadonlySet<string>,
                ),
              ),
            onFailure: Effect.fnUntraced(function* (error) {
              yield* Effect.logError(error);
              return Option.none<ReadonlySet<string>>();
            }),
          });
        },
      );

      const getOptionalGuildRoles = (guildId: string) =>
        rolesCache.getForParent(guildId).pipe(Effect.tapError(Effect.logError), Effect.option);

      // fallow-ignore-next-line code-duplication
      // fallow-ignore-next-line complexity
      const resolveGuildScopedPermissions = Effect.fn(
        "AuthorizationService.resolveGuildScopedPermissions",
      )(
        // fallow-ignore-next-line complexity
        function* (user: SheetAuthUserType, guildId: string) {
          if (
            hasPermission(user.permissions, "service") ||
            hasPermission(user.permissions, "app_owner")
          ) {
            return {
              permissions: appendPermissions(user.permissions, [
                `member_guild:${guildId}`,
                `monitor_guild:${guildId}`,
                `manage_guild:${guildId}`,
              ]),
              maybeMember: Option.none(),
            } satisfies ResolvedGuildPermissions;
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

          return {
            permissions,
            maybeMember,
          } satisfies ResolvedGuildPermissions;
        },
      );

      const resolveSheetAuthGuildUser = Effect.fn("AuthorizationService.resolveSheetAuthGuildUser")(
        function* (user: SheetAuthUserType, guildId: string) {
          const { permissions } = yield* resolveGuildScopedPermissions(user, guildId);
          return makeSheetAuthGuildUser(user, guildId, permissions);
        },
      );

      const resolveCurrentGuildUser = Effect.fn("AuthorizationService.resolveCurrentGuildUser")(
        function* (guildId: string) {
          const user = yield* SheetAuthUser;
          return yield* resolveSheetAuthGuildUser(user, guildId);
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

      const getGuildMonitorAccessLevel = Effect.fn(
        "AuthorizationService.getGuildMonitorAccessLevel",
      )(function* (user: SheetAuthUserType, guildId: string) {
        const resolvedUser = yield* resolveSheetAuthGuildUser(user, guildId);

        if (hasGuildPermission(resolvedUser.permissions, "monitor_guild", guildId)) {
          return "monitor" as const;
        }

        if (hasGuildPermission(resolvedUser.permissions, "member_guild", guildId)) {
          return "member" as const;
        }

        return "none" as const;
      });

      const getCurrentGuildMonitorAccessLevel = Effect.fn(
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

        return yield* Effect.void;
      });

      return {
        resolveSheetAuthGuildUser,
        resolveCurrentGuildUser,
        provideCurrentGuildUser,
        getGuildMonitorAccessLevel,
        getCurrentGuildMonitorAccessLevel,
        requireManageGuild: (
          guildId: string,
          message = "User does not have manage guild permission",
        ) => requireResolvedGuildPermission(guildId, "manage", message),
        requireMonitorGuild: (
          guildId: string,
          message = "User does not have monitor guild permission",
        ) => requireResolvedGuildPermission(guildId, "monitor", message),
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
          const user = yield* getRequiredCurrentGuildUser(guildId);

          if (
            hasPermission(user.permissions, "service") ||
            hasPermission(user.permissions, "app_owner") ||
            hasDiscordAccountPermission(user.permissions, accountId) ||
            hasGuildPermission(user.permissions, "monitor_guild", guildId)
          ) {
            return yield* Effect.void;
          }

          return yield* Effect.fail(new Unauthorized({ message }));
        }),
        requireGuildMember: (guildId: string, message = "User is not a member of this guild") =>
          requireResolvedGuildPermission(guildId, "member", message),
      };
    }),
  },
) {
  static layer = Layer.effect(AuthorizationService, this.make).pipe(
    Layer.provide([GuildConfigService.layer, discordLayer]),
  );
}
