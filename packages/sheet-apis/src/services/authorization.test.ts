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
import { SheetAuthGuildUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthGuildUser";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { GuildConfigService } from "@/services";

type MembersApiCacheViewService = Context.Service.Shape<typeof MembersApiCacheView>;
type RolesApiCacheViewService = Context.Service.Shape<typeof RolesApiCacheView>;
type GuildConfigServiceApi = Context.Service.Shape<typeof GuildConfigService>;
type AuthorizationServiceApi = Context.Service.Shape<typeof AuthorizationService>;

type TestPermission =
  | "service"
  | "app_owner"
  | `member_guild:${string}`
  | `monitor_guild:${string}`
  | `manage_guild:${string}`
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

const resolveSheetAuthGuildUser = (user: ReturnType<typeof makeUser>, guildId: string) =>
  withAuthorization((authorizationService) =>
    authorizationService.resolveSheetAuthGuildUser(user, guildId),
  );

const resolveCurrentGuildUser = (guildId: string) =>
  withAuthorization((authorizationService) =>
    authorizationService.resolveCurrentGuildUser(guildId),
  );

const getGuildMonitorAccessLevel = (user: ReturnType<typeof makeUser>, guildId: string) =>
  withAuthorization((authorizationService) =>
    authorizationService.getGuildMonitorAccessLevel(user, guildId),
  );

const getCurrentGuildMonitorAccessLevel = (guildId: string) =>
  withAuthorization((authorizationService) =>
    authorizationService.getCurrentGuildMonitorAccessLevel(guildId),
  );

const requireManageGuild = (guildId: string) =>
  withAuthorization((authorizationService) => authorizationService.requireManageGuild(guildId));

const requireMonitorGuild = (guildId: string) =>
  withAuthorization((authorizationService) => authorizationService.requireMonitorGuild(guildId));

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

const requireGuildMember = (guildId: string) =>
  withAuthorization((authorizationService) => authorizationService.requireGuildMember(guildId));

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
    Effect.provideService(SheetAuthGuildUser, {
      ...makeUser(permissions, identity),
      guildId,
    }),
  ) as Effect.Effect<A, E, Exclude<R, SheetAuthGuildUser>>;

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
      Effect.provideService(GuildConfigService, {
        getGuildMonitorRoles: () =>
          options?.monitorRolesError
            ? Effect.fail(options.monitorRolesError)
            : Effect.succeed((options?.monitorRoleIds ?? []).map((roleId) => ({ roleId }))),
      } as unknown as GuildConfigServiceApi),
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
    resolveSheetAuthGuildUser(makeUser(["app_owner"]), "guild-1").pipe(
      Effect.map((user) => {
        expect(user.guildId).toBe("guild-1");
        expect(resolvedPermissionValues(user.permissions)).toEqual(
          permissionValues([
            "app_owner",
            "member_guild:guild-1",
            "monitor_guild:guild-1",
            "manage_guild:guild-1",
          ]),
        );
      }),
      liveGuildServices(),
    ),
  );

  it.effect("resolves guild member permission from live membership", () =>
    resolveSheetAuthGuildUser(makeUser([]), "guild-1").pipe(
      Effect.map((user) => {
        expect(user.guildId).toBe("guild-1");
        expect(resolvedPermissionValues(user.permissions)).toEqual(
          permissionValues(["member_guild:guild-1"]),
        );
      }),
      liveGuildServices({ member: makeMember([]) }),
    ),
  );

  it.effect("resolves current guild user from SheetAuthUser context", () =>
    withUser(
      [],
      resolveCurrentGuildUser("guild-1").pipe(
        Effect.map((user) => {
          expect(user.guildId).toBe("guild-1");
          expect(resolvedPermissionValues(user.permissions)).toEqual(
            permissionValues(["member_guild:guild-1"]),
          );
        }),
      ),
    ).pipe(liveGuildServices({ member: makeMember([]) })),
  );

  it.effect("resolves monitor and manage permissions from live guild data", () =>
    resolveSheetAuthGuildUser(makeUser([]), "guild-1").pipe(
      Effect.map((user) => {
        expect(resolvedPermissionValues(user.permissions)).toEqual(
          permissionValues([
            "member_guild:guild-1",
            "monitor_guild:guild-1",
            "manage_guild:guild-1",
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
    resolveSheetAuthGuildUser(makeUser(["monitor_guild:guild-1"]), "guild-1").pipe(
      Effect.map((user) => {
        expect(resolvedPermissionValues(user.permissions)).toEqual(
          permissionValues([
            "member_guild:guild-1",
            "monitor_guild:guild-1",
            "manage_guild:guild-1",
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
      resolveSheetAuthGuildUser(makeUser(["manage_guild:guild-1"]), "guild-1").pipe(
        Effect.map((user) => {
          expect(resolvedPermissionValues(user.permissions)).toEqual(
            permissionValues([
              "member_guild:guild-1",
              "monitor_guild:guild-1",
              "manage_guild:guild-1",
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
      guild1: resolveSheetAuthGuildUser(makeUser([]), "guild-1"),
      guild2: resolveSheetAuthGuildUser(makeUser([]), "guild-2"),
    }).pipe(
      Effect.map(({ guild1, guild2 }) => {
        expect(guild1.guildId).toBe("guild-1");
        expect(guild2.guildId).toBe("guild-2");
        expect(resolvedPermissionValues(guild1.permissions)).toEqual(
          permissionValues(["member_guild:guild-1", "monitor_guild:guild-1"]),
        );
        expect(resolvedPermissionValues(guild2.permissions)).toEqual(
          permissionValues(["member_guild:guild-2"]),
        );
      }),
      Effect.provideService(MembersApiCacheView, {
        get: (guildId: string, _accountId: string) =>
          guildId === "guild-1"
            ? Effect.succeed(makeMember(["role-1"]))
            : Effect.succeed(makeMember([])),
      } as unknown as MembersApiCacheViewService),
      Effect.provideService(GuildConfigService, {
        getGuildMonitorRoles: (guildId: string) =>
          Effect.succeed(guildId === "guild-1" ? [{ roleId: "role-1" }] : []),
      } as unknown as GuildConfigServiceApi),
      Effect.provideService(RolesApiCacheView, {
        getForParent: () => Effect.succeed(new Map()),
      } as unknown as RolesApiCacheViewService),
    ),
  );

  it.effect("degrades safely when guild lookups fail", () =>
    resolveSheetAuthGuildUser(makeUser([]), "guild-1").pipe(
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
    withGuildUser(["manage_guild:guild-1"], "guild-1", requireManageGuild("guild-1")).pipe(
      liveGuildServices(),
    ),
  );

  it.effect(
    "allows guild access shortcuts for app owner",
    Effect.fnUntraced(function* () {
      yield* withGuildUser(
        ["app_owner", "member_guild:guild-1"],
        "guild-1",
        requireGuildMember("guild-1"),
      ).pipe(liveGuildServices());
      yield* withGuildUser(
        ["app_owner", "monitor_guild:guild-1"],
        "guild-1",
        requireMonitorGuild("guild-1"),
      ).pipe(liveGuildServices());
      yield* withGuildUser(
        ["app_owner", "manage_guild:guild-1"],
        "guild-1",
        requireManageGuild("guild-1"),
      ).pipe(liveGuildServices());
    }),
  );

  it.effect("allows monitor guild access with a resolved monitor permission", () =>
    withGuildUser(["monitor_guild:guild-1"], "guild-1", requireMonitorGuild("guild-1")).pipe(
      liveGuildServices(),
    ),
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
      ["monitor_guild:guild-1"],
      "guild-1",
      requireDiscordAccountIdOrMonitorGuild("guild-1", "discord-account-2"),
    ).pipe(liveGuildServices()),
  );

  it.effect("allows guild member access from membership service", () =>
    withGuildUser(["member_guild:guild-1"], "guild-1", requireGuildMember("guild-1")).pipe(
      liveGuildServices(),
    ),
  );

  it.effect(
    "dies when provided SheetAuthGuildUser is for a different guild",
    Effect.fnUntraced(function* () {
      const exit = yield* Effect.exit(
        withGuildUser(["member_guild:guild-2"], "guild-2", requireGuildMember("guild-1")).pipe(
          liveGuildServices(),
        ),
      );

      expect(exit._tag).toBe("Failure");
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
      }
    }),
  );

  it.effect(
    "uses SheetAuthGuildUser context for guild membership checks",
    Effect.fnUntraced(function* () {
      yield* withGuildUser(["member_guild:guild-1"], "guild-1", requireGuildMember("guild-1")).pipe(
        liveGuildServices(),
      );
    }),
  );

  it.effect(
    "rejects monitor-only access without guild membership",
    Effect.fnUntraced(function* () {
      const exit = yield* Effect.exit(
        withGuildUser(["monitor_guild:guild-1"], "guild-1", requireGuildMember("guild-1")).pipe(
          liveGuildServices(),
        ),
      );

      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect(
    "does not allow monitor_guild permission for a different guild to satisfy requireMonitorGuild",
    Effect.fnUntraced(function* () {
      const exit = yield* Effect.exit(
        withGuildUser(["monitor_guild:guild-2"], "guild-1", requireMonitorGuild("guild-1")).pipe(
          liveGuildServices(),
        ),
      );

      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect(
    "rejects manage-only access without guild membership",
    Effect.fnUntraced(function* () {
      const exit = yield* Effect.exit(
        withGuildUser(["manage_guild:guild-1"], "guild-1", requireGuildMember("guild-1")).pipe(
          liveGuildServices(),
        ),
      );

      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect(
    "dies when SheetAuthGuildUser is not provided for guild checks",
    Effect.fnUntraced(function* () {
      const exit = yield* Effect.exit(
        withUser([], requireGuildMember("guild-1")).pipe(liveGuildServices()) as Effect.Effect<
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
        withUser(["manage_guild:guild-1"], requireService()).pipe(liveGuildServices()),
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
        const monitor = yield* getGuildMonitorAccessLevel(makeUser([]), "guild-monitor");
        const member = yield* getGuildMonitorAccessLevel(makeUser([]), "guild-member");
        const none = yield* getGuildMonitorAccessLevel(makeUser([]), "guild-none");

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
      Effect.provideService(GuildConfigService, {
        getGuildMonitorRoles: () => Effect.succeed([{ roleId: "role-1" }]),
      } as unknown as GuildConfigServiceApi),
      Effect.provideService(RolesApiCacheView, {
        getForParent: () => Effect.succeed(new Map()),
      } as unknown as RolesApiCacheViewService),
    ),
  );

  it.effect(
    "reports current monitor access level from SheetAuthUser context",
    Effect.fnUntraced(
      function* () {
        const monitor = yield* withUser([], getCurrentGuildMonitorAccessLevel("guild-monitor"));
        const member = yield* withUser([], getCurrentGuildMonitorAccessLevel("guild-member"));
        const none = yield* withUser([], getCurrentGuildMonitorAccessLevel("guild-none"));

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
      Effect.provideService(GuildConfigService, {
        getGuildMonitorRoles: () => Effect.succeed([{ roleId: "role-1" }]),
      } as unknown as GuildConfigServiceApi),
      Effect.provideService(RolesApiCacheView, {
        getForParent: () => Effect.succeed(new Map()),
      } as unknown as RolesApiCacheViewService),
    ),
  );

  it.effect(
    "uses SheetAuthGuildUser context for self-or-monitor checks",
    Effect.fnUntraced(function* () {
      yield* withGuildUser(
        ["monitor_guild:guild-1"],
        "guild-1",
        requireDiscordAccountIdOrMonitorGuild("guild-1", "discord-account-2"),
      ).pipe(liveGuildServices());
    }),
  );
});
