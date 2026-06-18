import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Cause, Duration, Effect, Exit, Layer, Option, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import {
  AuthorizationService,
  hasDiscordAccountPermission,
  hasGuildPermission,
  hasPermission,
  permissionSetFromIterable,
} from "./authorization";
import { SheetApisForwardingClient } from "./sheetApisForwardingClient";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";
import { SheetBotCacheClient } from "./sheetBotCacheClient";

type SheetBotCacheClientApi = typeof SheetBotCacheClient.Service;

const makeUser = (
  permissions: Iterable<string> = [],
  identity = { accountId: "discord-user-1", userId: "user-1" },
) => ({
  accountId: identity.accountId,
  userId: identity.userId,
  permissions: permissionSetFromIterable(permissions as never),
  scopes: new Set() as never,
  token: Redacted.make("token-1"),
});

const makeSheetApisForwardingClient = (monitorRoleIds: ReadonlyArray<string> = []) => {
  const getGuildMonitorRoles = vi.fn(() =>
    Effect.succeed(monitorRoleIds.map((roleId) => ({ roleId }))),
  );

  return {
    client: {
      guildConfig: {
        getGuildMonitorRoles,
      },
    } as never,
    getGuildMonitorRoles,
  };
};

const makeSheetBotCacheClient = ({
  member = Option.some({ roles: [] as ReadonlyArray<string> }),
  roles = new Map<string, { id: string; permissions: string }>(),
  memberError,
  rolesError,
}: {
  readonly member?: Option.Option<{ readonly roles: ReadonlyArray<string> }>;
  readonly roles?: ReadonlyMap<string, { readonly id: string; readonly permissions: string }>;
  readonly memberError?: unknown;
  readonly rolesError?: unknown;
} = {}): SheetBotCacheClientApi & {
  readonly getMember: ReturnType<typeof vi.fn>;
  readonly getRolesForGuild: ReturnType<typeof vi.fn>;
} =>
  ({
    getMember: vi.fn(() => (memberError ? Effect.fail(memberError) : Effect.succeed(member))),
    getRolesForGuild: vi.fn(() => (rolesError ? Effect.fail(rolesError) : Effect.succeed(roles))),
  }) as unknown as SheetBotCacheClientApi & {
    readonly getMember: ReturnType<typeof vi.fn>;
    readonly getRolesForGuild: ReturnType<typeof vi.fn>;
  };

const runAuthorization = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  {
    user = makeUser(),
    sheetApisForwardingClient = makeSheetApisForwardingClient([]).client,
    sheetBotCacheClient = makeSheetBotCacheClient(),
    sheetApisRpcTokens = {
      getServiceUser: () =>
        Effect.succeed(makeUser(["service"], { accountId: "service", userId: "service-user" })),
      withServiceUser: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    } as never,
  }: {
    readonly user?: ReturnType<typeof makeUser>;
    readonly sheetApisForwardingClient?: typeof SheetApisForwardingClient.Service;
    readonly sheetApisRpcTokens?: typeof SheetApisRpcTokens.Service;
    readonly sheetBotCacheClient?: typeof SheetBotCacheClient.Service;
  } = {},
) => {
  const authorizationLayer = Layer.effect(AuthorizationService, AuthorizationService.make);
  const provided = effect.pipe(
    Effect.provide(authorizationLayer),
    Effect.provideService(SheetAuthUser, user),
    Effect.provideService(SheetApisForwardingClient, sheetApisForwardingClient),
    Effect.provideService(SheetApisRpcTokens, sheetApisRpcTokens),
    Effect.provideService(SheetBotCacheClient, sheetBotCacheClient),
  );

  return provided;
};

describe("authorization permission helpers", () => {
  it("matches base, guild-scoped, and Discord account permissions", () => {
    const permissions = permissionSetFromIterable([
      "service",
      "monitor_guild:guild-1",
      "account:discord:discord-user-1",
    ]);

    expect(hasPermission(permissions, "service")).toBe(true);
    expect(hasGuildPermission(permissions, "monitor_guild", "guild-1")).toBe(true);
    expect(hasGuildPermission(permissions, "monitor_guild", "guild-2")).toBe(false);
    expect(hasDiscordAccountPermission(permissions, "discord-user-1")).toBe(true);
    expect(hasDiscordAccountPermission(permissions, "discord-user-2")).toBe(false);
  });
});

describe("AuthorizationService", () => {
  it("allows service users through requireService", async () => {
    await Effect.runPromise(
      runAuthorization(
        Effect.gen(function* () {
          const authorization = yield* AuthorizationService;
          yield* authorization.requireService();
        }),
        { user: makeUser(["service"]) },
      ),
    );
  });

  it("rejects non-service users from requireService", async () => {
    const exit = await Effect.runPromiseExit(
      runAuthorization(
        Effect.gen(function* () {
          const authorization = yield* AuthorizationService;
          yield* authorization.requireService();
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("User is not the service user");
    }
  });

  it("allows matching Discord account users and rejects other account users", async () => {
    const allowed = Effect.gen(function* () {
      const authorization = yield* AuthorizationService;
      yield* authorization.requireDiscordAccountId("discord-user-1");
    });

    await Effect.runPromise(
      runAuthorization(allowed, {
        user: makeUser(["account:discord:discord-user-1"]),
      }),
    );

    const denied = await Effect.runPromiseExit(
      runAuthorization(allowed, {
        user: makeUser(["account:discord:discord-user-2"]),
      }),
    );

    expect(Exit.isFailure(denied)).toBe(true);
  });

  it("resolves guild permissions before requiring guild permission", async () => {
    const { client, getGuildMonitorRoles } = makeSheetApisForwardingClient(["role-1"]);
    const sheetBotCacheClient = makeSheetBotCacheClient({
      member: Option.some({ roles: ["role-1"] }),
    });

    await Effect.runPromise(
      runAuthorization(
        Effect.gen(function* () {
          const authorization = yield* AuthorizationService;
          yield* authorization.requireMonitorGuild("guild-1");
        }),
        {
          sheetApisForwardingClient: client,
          sheetBotCacheClient,
        },
      ),
    );

    expect(getGuildMonitorRoles).toHaveBeenCalledTimes(1);
    expect(sheetBotCacheClient.getMember).toHaveBeenCalledTimes(1);
  });

  it("caches guild permission resolution for the same token and guild", async () => {
    const { client, getGuildMonitorRoles } = makeSheetApisForwardingClient([]);
    const sheetBotCacheClient = makeSheetBotCacheClient({
      member: Option.some({ roles: [] }),
    });

    await Effect.runPromise(
      runAuthorization(
        Effect.gen(function* () {
          const authorization = yield* AuthorizationService;
          yield* authorization.resolveCurrentGuildUser("guild-1");
          yield* authorization.resolveCurrentGuildUser("guild-1");
        }),
        {
          sheetApisForwardingClient: client,
          sheetBotCacheClient,
        },
      ),
    );

    expect(getGuildMonitorRoles).toHaveBeenCalledTimes(1);
    expect(sheetBotCacheClient.getMember).toHaveBeenCalledTimes(1);
  });

  it("refreshes resolved guild permissions after the cache ttl", async () => {
    let memberRoles: ReadonlyArray<string> = [];
    const sheetBotCacheClient = {
      getMember: vi.fn(() => Effect.succeed(Option.some({ roles: memberRoles }))),
      getRolesForGuild: vi.fn(() =>
        Effect.succeed(new Map([["role-1", { id: "role-1", permissions: "32" }]])),
      ),
    } as unknown as SheetBotCacheClientApi & {
      readonly getMember: ReturnType<typeof vi.fn>;
      readonly getRolesForGuild: ReturnType<typeof vi.fn>;
    };

    const resolvedUsers = await Effect.runPromise(
      Effect.scoped(
        runAuthorization(
          Effect.gen(function* () {
            const authorization = yield* AuthorizationService;
            const initialUser = yield* authorization.resolveCurrentGuildUser("guild-1");
            memberRoles = ["role-1"];
            const cachedUser = yield* authorization.resolveCurrentGuildUser("guild-1");
            yield* TestClock.adjust(Duration.seconds(31));
            const refreshedUser = yield* authorization.resolveCurrentGuildUser("guild-1");

            return { cachedUser, initialUser, refreshedUser };
          }),
          { sheetBotCacheClient },
        ).pipe(Effect.provide(TestClock.layer())),
      ),
    );

    expect(
      hasGuildPermission(resolvedUsers.initialUser.permissions, "manage_guild", "guild-1"),
    ).toBe(false);
    expect(
      hasGuildPermission(resolvedUsers.cachedUser.permissions, "manage_guild", "guild-1"),
    ).toBe(false);
    expect(
      hasGuildPermission(resolvedUsers.refreshedUser.permissions, "manage_guild", "guild-1"),
    ).toBe(true);
    expect(sheetBotCacheClient.getMember).toHaveBeenCalledTimes(2);
    expect(sheetBotCacheClient.getRolesForGuild).toHaveBeenCalledTimes(2);
  });

  it("caches guild role lookups across users for the same guild", async () => {
    const sheetBotCacheClient = makeSheetBotCacheClient({
      member: Option.some({ roles: ["role-1"] }),
      roles: new Map([["role-1", { id: "role-1", permissions: "32" }]]),
    });

    await Effect.runPromise(
      runAuthorization(
        Effect.gen(function* () {
          const authorization = yield* AuthorizationService;
          yield* authorization.resolveCurrentGuildUser("guild-1");
          yield* authorization.resolveSheetAuthGuildUser(
            makeUser([], { accountId: "discord-user-2", userId: "user-2" }),
            "guild-1",
          );
        }),
        { sheetBotCacheClient },
      ),
    );

    expect(sheetBotCacheClient.getRolesForGuild).toHaveBeenCalledTimes(1);
  });

  it("caches monitor role lookups across users for the same guild", async () => {
    const { client, getGuildMonitorRoles } = makeSheetApisForwardingClient(["role-1"]);
    const sheetBotCacheClient = makeSheetBotCacheClient({
      member: Option.some({ roles: ["role-1"] }),
    });

    await Effect.runPromise(
      runAuthorization(
        Effect.gen(function* () {
          const authorization = yield* AuthorizationService;
          yield* authorization.resolveCurrentGuildUser("guild-1");
          yield* authorization.resolveSheetAuthGuildUser(
            makeUser([], { accountId: "discord-user-2", userId: "user-2" }),
            "guild-1",
          );
        }),
        { sheetApisForwardingClient: client, sheetBotCacheClient },
      ),
    );

    expect(getGuildMonitorRoles).toHaveBeenCalledTimes(1);
  });

  it("degrades safely when guild permission lookups fail", async () => {
    const sheetApisForwardingClient = {
      guildConfig: {
        getGuildMonitorRoles: () => Effect.fail(new Error("lookup failed")),
      },
    } as never;
    const sheetBotCacheClient = makeSheetBotCacheClient({
      memberError: new Error("member lookup failed"),
      rolesError: new Error("roles lookup failed"),
    });

    const resolvedUser = await Effect.runPromise(
      runAuthorization(
        Effect.gen(function* () {
          const authorization = yield* AuthorizationService;
          return yield* authorization.resolveCurrentGuildUser("guild-1");
        }),
        { sheetApisForwardingClient, sheetBotCacheClient },
      ),
    );

    expect(Array.from(resolvedUser.permissions)).toEqual([]);
  });

  it("resolves manage guild permission from cached role permissions", async () => {
    const sheetBotCacheClient = makeSheetBotCacheClient({
      member: Option.some({ roles: ["role-1"] }),
      roles: new Map([["role-1", { id: "role-1", permissions: "32" }]]),
    });

    await Effect.runPromise(
      runAuthorization(
        Effect.gen(function* () {
          const authorization = yield* AuthorizationService;
          yield* authorization.requireManageGuild("guild-1");
        }),
        { sheetBotCacheClient },
      ),
    );
  });

  it("resolves manage guild permission from the implicit everyone role", async () => {
    const sheetBotCacheClient = makeSheetBotCacheClient({
      member: Option.some({ roles: [] }),
      roles: new Map([["guild-1", { id: "guild-1", permissions: "32" }]]),
    });

    await Effect.runPromise(
      runAuthorization(
        Effect.gen(function* () {
          const authorization = yield* AuthorizationService;
          yield* authorization.requireManageGuild("guild-1");
        }),
        { sheetBotCacheClient },
      ),
    );
  });
});
