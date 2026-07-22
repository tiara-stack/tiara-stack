import { describe, expect, it } from "@effect/vitest";
import { MembersApiCacheView } from "dfx-discord-utils/discord/cache/members";
import { RolesApiCacheView } from "dfx-discord-utils/discord/cache/roles";
import { CacheNotFoundError } from "dfx-discord-utils/discord/schema";
import type { CachedGuildMember } from "dfx-discord-utils/cache";
import { Discord } from "dfx";
import { Cause, Effect, Exit, Redacted, Context } from "effect";
import {
  AuthorizationService,
  hasDiscordAccountPermission,
  permissionSetFromIterable,
} from "./authorization";
import { SheetAuthWorkspaceUser } from "sheet-ingress-api/internal";
import { SheetAuthUser } from "sheet-ingress-api/internal";
import { WorkspaceConfigService } from "@/services";

type MembersApiCacheViewService = Context.Service.Shape<typeof MembersApiCacheView>;
type RolesApiCacheViewService = Context.Service.Shape<typeof RolesApiCacheView>;
type WorkspaceConfigServiceApi = Context.Service.Shape<typeof WorkspaceConfigService>;
type AuthorizationServiceApi = Context.Service.Shape<typeof AuthorizationService>;

type TestPermission =
  | "service"
  | "app_owner"
  | `member_workspace:${string}`
  | `monitor_workspace:${string}`
  | `manage_workspace:${string}`
  | `account:discord:${string}`;

const makeUser = (
  permissions: ReadonlyArray<TestPermission>,
  identity = { accountId: "discord-account-1", userId: "better-auth-user-1" },
) => ({
  accountId: identity.accountId,
  userId: identity.userId,
  permissions: permissionSetFromIterable(permissions),
  scopes: new Set() as never,
  token: Redacted.make("token"),
  tokenType: "session" as const,
});

const permissionValues = (permissions: Iterable<TestPermission>) =>
  Array.from(permissionSetFromIterable(permissions)).sort();

const resolvedPermissionValues = (permissions: ReturnType<typeof permissionSetFromIterable>) =>
  Array.from(permissions).sort();

const withAuthorization = Effect.fnUntraced(function* <A, E, R>(
  f: (authorizationService: AuthorizationServiceApi) => Effect.Effect<A, E, R>,
) {
  const authorizationService = yield* AuthorizationService.make;
  return yield* f(authorizationService);
});

const resolveSheetAuthWorkspaceUser = (user: ReturnType<typeof makeUser>, guildId: string) =>
  withAuthorization((authorizationService) =>
    authorizationService.resolveSheetAuthWorkspaceUser(user, guildId),
  );

const resolveCurrentWorkspaceUser = (guildId: string) =>
  withAuthorization((authorizationService) =>
    authorizationService.resolveCurrentWorkspaceUser(guildId),
  );

const getWorkspaceMonitorAccessLevel = (user: ReturnType<typeof makeUser>, guildId: string) =>
  withAuthorization((authorizationService) =>
    authorizationService.getWorkspaceMonitorAccessLevel(user, guildId),
  );

const getCurrentWorkspaceMonitorAccessLevel = (guildId: string) =>
  withAuthorization((authorizationService) =>
    authorizationService.getCurrentWorkspaceMonitorAccessLevel(guildId),
  );

const requireManageWorkspace = (guildId: string) =>
  withAuthorization((authorizationService) => authorizationService.requireManageWorkspace(guildId));

const requireMonitorWorkspace = (guildId: string) =>
  withAuthorization((authorizationService) =>
    authorizationService.requireMonitorWorkspace(guildId),
  );

const requireService = () =>
  withAuthorization((authorizationService) => authorizationService.requireService());

const requireDiscordAccountId = (accountId: string) =>
  withAuthorization((authorizationService) =>
    authorizationService.requireDiscordAccountId(accountId),
  );

const requireDiscordAccountIdOrMonitorGuild = (guildId: string, accountId: string) =>
  withAuthorization((authorizationService) =>
    authorizationService.requireDiscordAccountIdOrMonitorGuild(guildId, accountId),
  );

const requireWorkspaceMember = (guildId: string) =>
  withAuthorization((authorizationService) => authorizationService.requireWorkspaceMember(guildId));

const withUser = <A, E, R>(
  permissions: ReadonlyArray<TestPermission>,
  effect: Effect.Effect<A, E, R>,
  identity?: { accountId: string; userId: string },
) =>
  effect.pipe(
    Effect.provideService(SheetAuthUser, makeUser(permissions, identity)),
  ) as Effect.Effect<A, E, Exclude<R, SheetAuthUser>>;

const withGuildUser = <A, E, R>(
  permissions: ReadonlyArray<TestPermission>,
  guildId: string,
  effect: Effect.Effect<A, E, R>,
  identity?: { accountId: string; userId: string },
) =>
  effect.pipe(
    Effect.provideService(SheetAuthWorkspaceUser, {
      ...makeUser(permissions, identity),
      guildId,
    }),
  ) as Effect.Effect<A, E, Exclude<R, SheetAuthWorkspaceUser>>;

const makeMember = (roles: string[]) =>
  ({
    roles,
    user: { id: "account-1" },
  }) as unknown as CachedGuildMember;

const makeRole = (id: string, permissions: bigint | string) =>
  ({
    id,
    permissions: permissions.toString(),
  }) as unknown as Discord.GuildRoleResponse;

const liveGuildServices =
  (options?: {
    readonly member?: ReturnType<typeof makeMember>;
    readonly monitorRoleIds?: ReadonlyArray<string>;
    readonly roleMap?: ReadonlyMap<string, ReturnType<typeof makeRole>>;
    readonly memberError?: unknown;
    readonly monitorRolesError?: unknown;
    readonly rolesError?: unknown;
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(MembersApiCacheView, {
        get: (_guildId: string, _accountId: string) =>
          options?.memberError
            ? Effect.fail(options.memberError)
            : typeof options?.member === "undefined"
              ? Effect.fail(new CacheNotFoundError({ message: "not found" }))
              : Effect.succeed(options.member),
      } as unknown as MembersApiCacheViewService),
      Effect.provideService(WorkspaceConfigService, {
        getWorkspaceMonitorRoles: () =>
          options?.monitorRolesError
            ? Effect.fail(options.monitorRolesError)
            : Effect.succeed((options?.monitorRoleIds ?? []).map((roleId) => ({ roleId }))),
      } as unknown as WorkspaceConfigServiceApi),
      Effect.provideService(RolesApiCacheView, {
        getForParent: () =>
          options?.rolesError
            ? Effect.fail(options.rolesError)
            : Effect.succeed(new Map(options?.roleMap ?? [])),
      } as unknown as RolesApiCacheViewService),
    );

describe("authorization service helpers", () => {
  it.effect("matches exact discord account permission", () =>
    Effect.sync(() => {
      expect(
        hasDiscordAccountPermission(
          permissionSetFromIterable(["account:discord:discord-account-1"]),
          "discord-account-1",
        ),
      ).toBe(true);
      expect(
        hasDiscordAccountPermission(
          permissionSetFromIterable(["account:discord:discord-account-1"]),
          "discord-account-2",
        ),
      ).toBe(false);
    }),
  );

  it.effect("resolves full guild permissions for app owner without live lookups", () =>
    resolveSheetAuthWorkspaceUser(makeUser(["app_owner"]), "guild-1").pipe(
      Effect.map((user) => {
        expect(user.guildId).toBe("guild-1");
        expect(resolvedPermissionValues(user.permissions)).toEqual(
          permissionValues([
            "app_owner",
            "member_workspace:guild-1",
            "monitor_workspace:guild-1",
            "manage_workspace:guild-1",
          ]),
        );
      }),
      liveGuildServices(),
    ),
  );

  it.effect("resolves guild member permission from live membership", () =>
    resolveSheetAuthWorkspaceUser(makeUser([]), "guild-1").pipe(
      Effect.map((user) => {
        expect(user.guildId).toBe("guild-1");
        expect(resolvedPermissionValues(user.permissions)).toEqual(
          permissionValues(["member_workspace:guild-1"]),
        );
      }),
      liveGuildServices({ member: makeMember([]) }),
    ),
  );

  it.effect("resolves current guild user from SheetAuthUser context", () =>
    withUser(
      [],
      resolveCurrentWorkspaceUser("guild-1").pipe(
        Effect.map((user) => {
          expect(user.guildId).toBe("guild-1");
          expect(resolvedPermissionValues(user.permissions)).toEqual(
            permissionValues(["member_workspace:guild-1"]),
          );
        }),
      ),
    ).pipe(liveGuildServices({ member: makeMember([]) })),
  );

  it.effect("resolves monitor and manage permissions from live guild data", () =>
    resolveSheetAuthWorkspaceUser(makeUser([]), "guild-1").pipe(
      Effect.map((user) => {
        expect(resolvedPermissionValues(user.permissions)).toEqual(
          permissionValues([
            "member_workspace:guild-1",
            "monitor_workspace:guild-1",
            "manage_workspace:guild-1",
          ]),
        );
      }),
      liveGuildServices({
        member: makeMember(["role-1", "role-2"]),
        monitorRoleIds: ["role-1"],
        roleMap: new Map([["role-2", makeRole("role-2", Discord.Permissions.ManageGuild)]]),
      }),
    ),
  );

  it.effect("resolves manage permission even when monitor permission already exists", () =>
    resolveSheetAuthWorkspaceUser(makeUser(["monitor_workspace:guild-1"]), "guild-1").pipe(
      Effect.map((user) => {
        expect(resolvedPermissionValues(user.permissions)).toEqual(
          permissionValues([
            "member_workspace:guild-1",
            "monitor_workspace:guild-1",
            "manage_workspace:guild-1",
          ]),
        );
      }),
      liveGuildServices({
        member: makeMember(["role-1", "role-2"]),
        monitorRoleIds: ["role-1"],
        roleMap: new Map([["role-2", makeRole("role-2", Discord.Permissions.ManageGuild)]]),
      }),
    ),
  );

  it.effect(
    "resolves member and monitor permissions even when manage permission already exists",
    () =>
      resolveSheetAuthWorkspaceUser(makeUser(["manage_workspace:guild-1"]), "guild-1").pipe(
        Effect.map((user) => {
          expect(resolvedPermissionValues(user.permissions)).toEqual(
            permissionValues([
              "member_workspace:guild-1",
              "monitor_workspace:guild-1",
              "manage_workspace:guild-1",
            ]),
          );
        }),
        liveGuildServices({
          member: makeMember(["role-1", "role-2"]),
          monitorRoleIds: ["role-1"],
          roleMap: new Map([["role-2", makeRole("role-2", Discord.Permissions.ManageGuild)]]),
        }),
      ),
  );

  it.effect("does not leak resolved permissions across guilds", () =>
    Effect.all({
      guild1: resolveSheetAuthWorkspaceUser(makeUser([]), "guild-1"),
      guild2: resolveSheetAuthWorkspaceUser(makeUser([]), "guild-2"),
    }).pipe(
      Effect.map(({ guild1, guild2 }) => {
        expect(guild1.guildId).toBe("guild-1");
        expect(guild2.guildId).toBe("guild-2");
        expect(resolvedPermissionValues(guild1.permissions)).toEqual(
          permissionValues(["member_workspace:guild-1", "monitor_workspace:guild-1"]),
        );
        expect(resolvedPermissionValues(guild2.permissions)).toEqual(
          permissionValues(["member_workspace:guild-2"]),
        );
      }),
      Effect.provideService(MembersApiCacheView, {
        get: (guildId: string, _accountId: string) =>
          guildId === "guild-1"
            ? Effect.succeed(makeMember(["role-1"]))
            : Effect.succeed(makeMember([])),
      } as unknown as MembersApiCacheViewService),
      Effect.provideService(WorkspaceConfigService, {
        getWorkspaceMonitorRoles: (guildId: string) =>
          Effect.succeed(guildId === "guild-1" ? [{ roleId: "role-1" }] : []),
      } as unknown as WorkspaceConfigServiceApi),
      Effect.provideService(RolesApiCacheView, {
        getForParent: () => Effect.succeed(new Map()),
      } as unknown as RolesApiCacheViewService),
    ),
  );

  it.effect("degrades safely when guild lookups fail", () =>
    resolveSheetAuthWorkspaceUser(makeUser([]), "guild-1").pipe(
      Effect.map((user) => {
        expect(user.guildId).toBe("guild-1");
        expect(resolvedPermissionValues(user.permissions)).toEqual([]);
      }),
      liveGuildServices({
        memberError: new Error("member lookup failed"),
        monitorRolesError: new Error("monitor roles lookup failed"),
        rolesError: new Error("roles lookup failed"),
      }),
    ),
  );

  it.effect("allows manage guild access with a resolved manage permission", () =>
    withGuildUser(["manage_workspace:guild-1"], "guild-1", requireManageWorkspace("guild-1")).pipe(
      liveGuildServices(),
    ),
  );

  it.effect(
    "allows guild access shortcuts for app owner",
    Effect.fnUntraced(function* () {
      yield* withGuildUser(
        ["app_owner", "member_workspace:guild-1"],
        "guild-1",
        requireWorkspaceMember("guild-1"),
      ).pipe(liveGuildServices());
      yield* withGuildUser(
        ["app_owner", "monitor_workspace:guild-1"],
        "guild-1",
        requireMonitorWorkspace("guild-1"),
      ).pipe(liveGuildServices());
      yield* withGuildUser(
        ["app_owner", "manage_workspace:guild-1"],
        "guild-1",
        requireManageWorkspace("guild-1"),
      ).pipe(liveGuildServices());
    }),
  );

  it.effect("allows monitor guild access with a resolved monitor permission", () =>
    withGuildUser(
      ["monitor_workspace:guild-1"],
      "guild-1",
      requireMonitorWorkspace("guild-1"),
    ).pipe(liveGuildServices()),
  );

  it.effect(
    "allows self access with matching discord account permission",
    Effect.fnUntraced(function* () {
      yield* withUser(
        ["account:discord:discord-account-1"],
        requireDiscordAccountId("discord-account-1"),
      ).pipe(liveGuildServices());
    }),
  );

  it.effect("allows self-or-monitor access with resolved monitor permission", () =>
    withGuildUser(
      ["monitor_workspace:guild-1"],
      "guild-1",
      requireDiscordAccountIdOrMonitorGuild("guild-1", "discord-account-2"),
    ).pipe(liveGuildServices()),
  );

  it.effect("allows guild member access from membership service", () =>
    withGuildUser(["member_workspace:guild-1"], "guild-1", requireWorkspaceMember("guild-1")).pipe(
      liveGuildServices(),
    ),
  );

  it.effect(
    "dies when provided SheetAuthWorkspaceUser is for a different guild",
    Effect.fnUntraced(function* () {
      const exit = yield* Effect.exit(
        withGuildUser(
          ["member_workspace:guild-2"],
          "guild-2",
          requireWorkspaceMember("guild-1"),
        ).pipe(liveGuildServices()),
      );

      expect(exit._tag).toBe("Failure");
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
      }
    }),
  );

  it.effect(
    "uses SheetAuthWorkspaceUser context for guild membership checks",
    Effect.fnUntraced(function* () {
      yield* withGuildUser(
        ["member_workspace:guild-1"],
        "guild-1",
        requireWorkspaceMember("guild-1"),
      ).pipe(liveGuildServices());
    }),
  );

  it.effect(
    "rejects monitor-only access without guild membership",
    Effect.fnUntraced(function* () {
      const exit = yield* Effect.exit(
        withGuildUser(
          ["monitor_workspace:guild-1"],
          "guild-1",
          requireWorkspaceMember("guild-1"),
        ).pipe(liveGuildServices()),
      );

      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect(
    "does not allow monitor_workspace permission for a different guild to satisfy requireMonitorWorkspace",
    Effect.fnUntraced(function* () {
      const exit = yield* Effect.exit(
        withGuildUser(
          ["monitor_workspace:guild-2"],
          "guild-1",
          requireMonitorWorkspace("guild-1"),
        ).pipe(liveGuildServices()),
      );

      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect(
    "rejects manage-only access without guild membership",
    Effect.fnUntraced(function* () {
      const exit = yield* Effect.exit(
        withGuildUser(
          ["manage_workspace:guild-1"],
          "guild-1",
          requireWorkspaceMember("guild-1"),
        ).pipe(liveGuildServices()),
      );

      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect(
    "dies when SheetAuthWorkspaceUser is not provided for guild checks",
    Effect.fnUntraced(function* () {
      const exit = yield* Effect.exit(
        withUser([], requireWorkspaceMember("guild-1")).pipe(liveGuildServices()) as Effect.Effect<
          void,
          never,
          never
        >,
      );

      expect(exit._tag).toBe("Failure");
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
      }
    }),
  );

  it.effect(
    "rejects missing service permission for service-only routes",
    Effect.fnUntraced(function* () {
      const exit = yield* Effect.exit(
        withUser(["manage_workspace:guild-1"], requireService()).pipe(liveGuildServices()),
      );

      expect(exit._tag).toBe("Failure");
      if (Exit.isFailure(exit)) {
        expect(Cause.hasFails(exit.cause)).toBe(true);
      }
    }),
  );

  it.effect(
    "rejects mismatched discord account permission",
    Effect.fnUntraced(function* () {
      const exit = yield* Effect.exit(
        withUser(
          ["account:discord:discord-account-1"],
          requireDiscordAccountId("discord-account-2"),
        ).pipe(liveGuildServices()),
      );

      expect(exit._tag).toBe("Failure");
      if (Exit.isFailure(exit)) {
        expect(Cause.hasFails(exit.cause)).toBe(true);
      }
    }),
  );

  it.effect(
    "rejects better-auth user id when only discord account permission is present",
    Effect.fnUntraced(function* () {
      const exit = yield* Effect.exit(
        withUser(
          ["account:discord:discord-account-1"],
          requireDiscordAccountId("better-auth-user-1"),
          { accountId: "discord-account-1", userId: "better-auth-user-1" },
        ).pipe(liveGuildServices()),
      );

      expect(exit._tag).toBe("Failure");
      if (Exit.isFailure(exit)) {
        expect(Cause.hasFails(exit.cause)).toBe(true);
      }
    }),
  );

  it.effect(
    "reports monitor access level for monitor, member, and non-member",
    Effect.fnUntraced(
      function* () {
        const monitor = yield* getWorkspaceMonitorAccessLevel(makeUser([]), "guild-monitor");
        const member = yield* getWorkspaceMonitorAccessLevel(makeUser([]), "guild-member");
        const none = yield* getWorkspaceMonitorAccessLevel(makeUser([]), "guild-none");

        expect(monitor).toBe("monitor");
        expect(member).toBe("member");
        expect(none).toBe("none");
      },
      Effect.provideService(MembersApiCacheView, {
        get: (guildId: string, _accountId: string) =>
          guildId === "guild-monitor"
            ? Effect.succeed(makeMember(["role-1"]))
            : guildId === "guild-member"
              ? Effect.succeed(makeMember([]))
              : Effect.fail(new CacheNotFoundError({ message: "not found" })),
      } as unknown as MembersApiCacheViewService),
      Effect.provideService(WorkspaceConfigService, {
        getWorkspaceMonitorRoles: () => Effect.succeed([{ roleId: "role-1" }]),
      } as unknown as WorkspaceConfigServiceApi),
      Effect.provideService(RolesApiCacheView, {
        getForParent: () => Effect.succeed(new Map()),
      } as unknown as RolesApiCacheViewService),
    ),
  );

  it.effect(
    "reports current monitor access level from SheetAuthUser context",
    Effect.fnUntraced(
      function* () {
        const monitor = yield* withUser([], getCurrentWorkspaceMonitorAccessLevel("guild-monitor"));
        const member = yield* withUser([], getCurrentWorkspaceMonitorAccessLevel("guild-member"));
        const none = yield* withUser([], getCurrentWorkspaceMonitorAccessLevel("guild-none"));

        expect(monitor).toBe("monitor");
        expect(member).toBe("member");
        expect(none).toBe("none");
      },
      Effect.provideService(MembersApiCacheView, {
        get: (guildId: string, _accountId: string) =>
          guildId === "guild-monitor"
            ? Effect.succeed(makeMember(["role-1"]))
            : guildId === "guild-member"
              ? Effect.succeed(makeMember([]))
              : Effect.fail(new CacheNotFoundError({ message: "not found" })),
      } as unknown as MembersApiCacheViewService),
      Effect.provideService(WorkspaceConfigService, {
        getWorkspaceMonitorRoles: () => Effect.succeed([{ roleId: "role-1" }]),
      } as unknown as WorkspaceConfigServiceApi),
      Effect.provideService(RolesApiCacheView, {
        getForParent: () => Effect.succeed(new Map()),
      } as unknown as RolesApiCacheViewService),
    ),
  );

  it.effect(
    "uses SheetAuthWorkspaceUser context for self-or-monitor checks",
    Effect.fnUntraced(function* () {
      yield* withGuildUser(
        ["monitor_workspace:guild-1"],
        "guild-1",
        requireDiscordAccountIdOrMonitorGuild("guild-1", "discord-account-2"),
      ).pipe(liveGuildServices());
    }),
  );
});
