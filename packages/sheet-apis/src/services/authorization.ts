// fallow-ignore-file code-duplication
import { MembersApiCacheView } from "dfx-discord-utils/discord/cache/members";
import { RolesApiCacheView } from "dfx-discord-utils/discord/cache/roles";
import { CacheNotFoundError } from "dfx-discord-utils/discord/schema";
import type { CachedGuildMember } from "dfx-discord-utils/cache";
import { Discord, Perms } from "dfx";
import { Effect, HashSet, Layer, Option, Context } from "effect";
import type { Permission, PermissionSet } from "sheet-ingress-api/schemas/permissions";
import { SheetAuthWorkspaceUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthWorkspaceUser";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { Unauthorized } from "typhoon-core/error";
import { WorkspaceConfigService } from "./workspaceConfig";
import { discordLayer } from "./discord";

type SheetAuthUserType = Context.Service.Shape<typeof SheetAuthUser>;
type SheetAuthWorkspaceUserType = Context.Service.Shape<typeof SheetAuthWorkspaceUser>;

type WorkspacePermissionScope = "member" | "monitor" | "manage";

interface ResolvedWorkspacePermissions {
  permissions: PermissionSet;
  maybeMember: Option.Option<CachedGuildMember>;
}

export const permissionSetFromIterable = (permissions: Iterable<Permission>): PermissionSet =>
  HashSet.fromIterable(permissions);

export const hasPermission = (permissions: PermissionSet, permission: Permission) =>
  HashSet.has(permissions, permission);

export const hasWorkspacePermission = (
  permissions: PermissionSet,
  prefix: "member_workspace" | "monitor_workspace" | "manage_workspace",
  guildId: string,
) => HashSet.has(permissions, `${prefix}:${guildId}`);

export const hasDiscordAccountPermission = (permissions: PermissionSet, accountId: string) =>
  HashSet.has(permissions, `account:discord:${accountId}`);

const requirePermissions = (
  permissions: PermissionSet,
  predicate: (permissions: PermissionSet) => boolean,
  message: string,
) => (predicate(permissions) ? Effect.void : Effect.fail(new Unauthorized({ message })));

export const appendPermission = (
  permissions: PermissionSet,
  permission: Permission,
): PermissionSet => HashSet.add(permissions, permission);

const appendPermissions = (
  permissions: PermissionSet,
  nextPermissions: Iterable<Permission>,
): PermissionSet => HashSet.union(permissions, permissionSetFromIterable(nextPermissions));

const hasManageWorkspacePermission = (
  member: CachedGuildMember,
  roles: ReadonlyMap<string, Discord.GuildRoleResponse>,
) => {
  const resolvedUserPermissions = Perms.forMember([...roles.values()])(
    member as Discord.GuildMemberResponse,
  );

  return Perms.has(Discord.Permissions.ManageGuild)(resolvedUserPermissions);
};

const hasMonitorWorkspacePermission = (
  member: { roles: ReadonlyArray<string> },
  monitorRoleIds: ReadonlySet<string>,
) => member.roles.some((roleId) => monitorRoleIds.has(roleId));

const makeSheetAuthWorkspaceUser = (
  user: SheetAuthUserType,
  guildId: string,
  permissions: PermissionSet,
): SheetAuthWorkspaceUserType => ({
  accountId: user.accountId,
  userId: user.userId,
  guildId,
  permissions,
  token: user.token,
});

const provideResolvedWorkspaceUser = Effect.fn("AuthorizationService.provideResolvedWorkspaceUser")(
  function* <A, E, R, R2>(
    resolvedWorkspaceUser: Effect.Effect<SheetAuthWorkspaceUserType, never, R2>,
    effect: Effect.Effect<A, E, R>,
  ) {
    const user = yield* resolvedWorkspaceUser;
    return yield* effect.pipe(Effect.provideService(SheetAuthWorkspaceUser, user)) as Effect.Effect<
      A,
      E,
      Exclude<R, SheetAuthWorkspaceUser>
    >;
  },
);

export class AuthorizationService extends Context.Service<AuthorizationService>()(
  "AuthorizationService",
  {
    make: Effect.gen(function* () {
      const membersCache = yield* MembersApiCacheView;
      const workspaceConfigService = yield* WorkspaceConfigService;
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
          return yield* Effect.matchEffect(
            workspaceConfigService.getWorkspaceMonitorRoles(guildId),
            {
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
            },
          );
        },
      );

      const getOptionalGuildRoles = (guildId: string) =>
        rolesCache.getForParent(guildId).pipe(Effect.tapError(Effect.logError), Effect.option);

      const resolveWorkspaceScopedPermissions = Effect.fn(
        "AuthorizationService.resolveWorkspaceScopedPermissions",
        // fallow-ignore-next-line complexity
      )(function* (user: SheetAuthUserType, guildId: string) {
        if (
          hasPermission(user.permissions, "service") ||
          hasPermission(user.permissions, "app_owner")
        ) {
          return {
            permissions: appendPermissions(user.permissions, [
              `member_workspace:${guildId}`,
              `monitor_workspace:${guildId}`,
              `manage_workspace:${guildId}`,
            ]),
            maybeMember: Option.none(),
          } satisfies ResolvedWorkspacePermissions;
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
          permissions = appendPermission(permissions, `member_workspace:${guildId}`);
        }

        if (
          Option.isSome(maybeMember) &&
          Option.isSome(maybeMonitorRoleIds) &&
          maybeMonitorRoleIds.value.size > 0 &&
          hasMonitorWorkspacePermission(maybeMember.value, maybeMonitorRoleIds.value)
        ) {
          permissions = appendPermission(permissions, `monitor_workspace:${guildId}`);
        }

        if (
          Option.isSome(maybeMember) &&
          Option.isSome(maybeRoles) &&
          hasManageWorkspacePermission(maybeMember.value, maybeRoles.value)
        ) {
          permissions = appendPermission(permissions, `manage_workspace:${guildId}`);
        }

        return {
          permissions,
          maybeMember,
        } satisfies ResolvedWorkspacePermissions;
      });

      const resolveSheetAuthWorkspaceUser = Effect.fn(
        "AuthorizationService.resolveSheetAuthWorkspaceUser",
      )(function* (user: SheetAuthUserType, guildId: string) {
        const { permissions } = yield* resolveWorkspaceScopedPermissions(user, guildId);
        return makeSheetAuthWorkspaceUser(user, guildId, permissions);
      });

      const resolveCurrentWorkspaceUser = Effect.fn(
        "AuthorizationService.resolveCurrentWorkspaceUser",
      )(function* (guildId: string) {
        const user = yield* SheetAuthUser;
        return yield* resolveSheetAuthWorkspaceUser(user, guildId);
      });

      const provideCurrentWorkspaceUser = <A, E, R>(
        guildId: string,
        effect: Effect.Effect<A, E, R>,
      ) => provideResolvedWorkspaceUser(resolveCurrentWorkspaceUser(guildId), effect);

      const getRequiredCurrentWorkspaceUser = Effect.fn(
        "AuthorizationService.getRequiredCurrentWorkspaceUser",
      )(function* (guildId: string) {
        const user = yield* SheetAuthWorkspaceUser;

        if (user.guildId === guildId) {
          return user;
        }

        return yield* Effect.die(
          new Error(
            `SheetAuthWorkspaceUser guild mismatch: expected ${guildId}, received ${user.guildId}`,
          ),
        );
      });

      const getWorkspaceMonitorAccessLevel = Effect.fn(
        "AuthorizationService.getWorkspaceMonitorAccessLevel",
      )(function* (user: SheetAuthUserType, guildId: string) {
        const resolvedUser = yield* resolveSheetAuthWorkspaceUser(user, guildId);

        if (hasWorkspacePermission(resolvedUser.permissions, "monitor_workspace", guildId)) {
          return "monitor" as const;
        }

        if (hasWorkspacePermission(resolvedUser.permissions, "member_workspace", guildId)) {
          return "member" as const;
        }

        return "none" as const;
      });

      const getCurrentWorkspaceMonitorAccessLevel = Effect.fn(
        "AuthorizationService.getCurrentWorkspaceMonitorAccessLevel",
      )(function* (guildId: string) {
        const resolvedUser = yield* resolveCurrentWorkspaceUser(guildId);

        if (hasWorkspacePermission(resolvedUser.permissions, "monitor_workspace", guildId)) {
          return "monitor" as const;
        }

        if (hasWorkspacePermission(resolvedUser.permissions, "member_workspace", guildId)) {
          return "member" as const;
        }

        return "none" as const;
      });

      const requireResolvedGuildPermission = Effect.fn(
        "AuthorizationService.requireResolvedGuildPermission",
      )(function* (guildId: string, scope: WorkspacePermissionScope, message: string) {
        const user = yield* getRequiredCurrentWorkspaceUser(guildId);
        const hasRequiredScope =
          scope === "member"
            ? hasWorkspacePermission(user.permissions, "member_workspace", guildId)
            : scope === "monitor"
              ? hasWorkspacePermission(user.permissions, "monitor_workspace", guildId)
              : hasWorkspacePermission(user.permissions, "manage_workspace", guildId);

        if (!hasRequiredScope) {
          return yield* Effect.fail(new Unauthorized({ message }));
        }

        return yield* Effect.void;
      });

      return {
        resolveSheetAuthWorkspaceUser,
        resolveCurrentWorkspaceUser,
        provideCurrentWorkspaceUser,
        getWorkspaceMonitorAccessLevel,
        getCurrentWorkspaceMonitorAccessLevel,
        requireManageWorkspace: (
          guildId: string,
          message = "User does not have manage workspace permission",
        ) => requireResolvedGuildPermission(guildId, "manage", message),
        requireMonitorWorkspace: (
          guildId: string,
          message = "User does not have monitor workspace permission",
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
          const user = yield* getRequiredCurrentWorkspaceUser(guildId);

          if (
            hasPermission(user.permissions, "service") ||
            hasPermission(user.permissions, "app_owner") ||
            hasDiscordAccountPermission(user.permissions, accountId) ||
            hasWorkspacePermission(user.permissions, "monitor_workspace", guildId)
          ) {
            return yield* Effect.void;
          }

          return yield* Effect.fail(new Unauthorized({ message }));
        }),
        requireWorkspaceMember: (
          guildId: string,
          message = "User is not a member of this workspace",
        ) => requireResolvedGuildPermission(guildId, "member", message),
      };
    }),
  },
) {
  static layer = Layer.effect(AuthorizationService, this.make).pipe(
    Layer.provide([WorkspaceConfigService.layer, discordLayer]),
  );
}
