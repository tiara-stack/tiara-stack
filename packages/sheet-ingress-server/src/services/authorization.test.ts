import { describe, expect, it, vi } from "vitest";
import { Cause, Effect, Exit, HashSet, Layer, Option, Redacted } from "effect";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import {
  AuthorizationService,
  hasDiscordAccountPermission,
  hasGuildPermission,
  hasPermission,
  permissionSetFromIterable,
} from "./authorization";
import { SheetApisClient } from "./sheetApisClient";
import { SheetBotCacheClient } from "./sheetBotCacheClient";

const makeUser = (permissions: Iterable<string> = []) => ({
  accountId: "discord-user-1",
  userId: "user-1",
  permissions: HashSet.fromIterable(permissions),
  token: Redacted.make("token-1"),
});

const makeSheetApisClient = (monitorRoleIds: ReadonlyArray<string> = []) => {
  const getGuildMonitorRoles = vi.fn(() =>
    Effect.succeed(monitorRoleIds.map((roleId) => ({ roleId }))),
  );

  return {
    client: {
      withServiceUser: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
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
} = {}) => ({
  getMember: vi.fn(() => (memberError ? Effect.fail(memberError) : Effect.succeed(member))),
  getRolesForGuild: vi.fn(() => (rolesError ? Effect.fail(rolesError) : Effect.succeed(roles))),
});

const runAuthorization = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  {
    user = makeUser(),
    sheetApisClient = makeSheetApisClient([]).client,
    sheetBotCacheClient = makeSheetBotCacheClient(),
  }: {
    readonly user?: ReturnType<typeof makeUser>;
    readonly sheetApisClient?: typeof SheetApisClient.Service;
    readonly sheetBotCacheClient?: typeof SheetBotCacheClient.Service;
  } = {},
) => {
  const authorizationLayer = Layer.effect(AuthorizationService, AuthorizationService.make);
  const provided = effect.pipe(
    Effect.provide(authorizationLayer),
    Effect.provideService(SheetAuthUser, user),
    Effect.provideService(SheetApisClient, sheetApisClient),
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
    const { client, getGuildMonitorRoles } = makeSheetApisClient(["role-1"]);
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
          sheetApisClient: client,
          sheetBotCacheClient,
        },
      ),
    );

    expect(getGuildMonitorRoles).toHaveBeenCalledTimes(1);
    expect(sheetBotCacheClient.getMember).toHaveBeenCalledTimes(1);
  });

  it("caches guild permission resolution for the same token and guild", async () => {
    const { client, getGuildMonitorRoles } = makeSheetApisClient([]);
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
          sheetApisClient: client,
          sheetBotCacheClient,
        },
      ),
    );

    expect(getGuildMonitorRoles).toHaveBeenCalledTimes(1);
    expect(sheetBotCacheClient.getMember).toHaveBeenCalledTimes(1);
  });

  it("degrades safely when guild permission lookups fail", async () => {
    const sheetApisClient = {
      withServiceUser: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
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
        { sheetApisClient, sheetBotCacheClient },
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
});
