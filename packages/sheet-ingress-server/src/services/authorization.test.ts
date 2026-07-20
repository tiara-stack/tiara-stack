// fallow-ignore-file code-duplication
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Cause, Duration, Effect, Exit, Layer, Option, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { SheetAuthUser } from "sheet-ingress-api/internal";
import {
  AuthorizationService,
  hasDiscordAccountPermission,
  hasWorkspacePermission,
  hasPermission,
  permissionSetFromIterable,
} from "./authorization";
import { SheetApisForwardingClient } from "./sheetApisForwardingClient";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";
import { SheetBotCacheClient } from "./sheetBotCacheClient";
import * as Data from "effect/Data";

class SheetIngressServerServicesAuthorizationTestError extends Data.TaggedError(
  "SheetIngressServerServicesAuthorizationTestError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

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
  tokenType: "session" as const,
});

const makeSheetApisForwardingClient = (monitorRoleIds: ReadonlyArray<string> = []) => {
  const getWorkspaceMonitorRoles = vi.fn(() =>
    Effect.succeed(monitorRoleIds.map((roleId) => ({ roleId }))),
  );

  return {
    client: {
      workspaceConfig: {
        getWorkspaceMonitorRoles,
      },
    } as never,
    getWorkspaceMonitorRoles,
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
      "monitor_workspace:guild-1",
      "account:discord:discord-user-1",
    ]);

    expect(hasPermission(permissions, "service")).toBe(true);
    expect(hasWorkspacePermission(permissions, "monitor_workspace", "guild-1")).toBe(true);
    expect(hasWorkspacePermission(permissions, "monitor_workspace", "guild-2")).toBe(false);
    expect(hasDiscordAccountPermission(permissions, "discord-user-1")).toBe(true);
    expect(hasDiscordAccountPermission(permissions, "discord-user-2")).toBe(false);
  });
});

describe("AuthorizationService", () => {
  it.live("allows service users through requireService", () =>
    runAuthorization(
      Effect.gen(function* () {
        const authorization = yield* AuthorizationService;
        yield* authorization.requireService();
      }),
      { user: makeUser(["service"]) },
    ),
  );

  it.live("rejects non-service users from requireService", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
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
    }),
  );

  it.live("allows matching Discord account users and rejects other account users", () =>
    Effect.gen(function* () {
      const allowed = Effect.gen(function* () {
        const authorization = yield* AuthorizationService;
        yield* authorization.requireDiscordAccountId("discord-user-1");
      });

      yield* runAuthorization(allowed, {
        user: makeUser(["account:discord:discord-user-1"]),
      });

      const denied = yield* Effect.exit(
        runAuthorization(allowed, {
          user: makeUser(["account:discord:discord-user-2"]),
        }),
      );

      expect(Exit.isFailure(denied)).toBe(true);
    }),
  );

  it.live("resolves guild permissions before requiring guild permission", () =>
    Effect.gen(function* () {
      const { client, getWorkspaceMonitorRoles } = makeSheetApisForwardingClient(["role-1"]);
      const sheetBotCacheClient = makeSheetBotCacheClient({
        member: Option.some({ roles: ["role-1"] }),
      });

      yield* runAuthorization(
        Effect.gen(function* () {
          const authorization = yield* AuthorizationService;
          yield* authorization.requireMonitorWorkspace("guild-1");
        }),
        {
          sheetApisForwardingClient: client,
          sheetBotCacheClient,
        },
      );

      expect(getWorkspaceMonitorRoles).toHaveBeenCalledTimes(1);
      expect(sheetBotCacheClient.getMember).toHaveBeenCalledTimes(1);
    }),
  );

  it.live("caches guild permission resolution for the same token and guild", () =>
    Effect.gen(function* () {
      const { client, getWorkspaceMonitorRoles } = makeSheetApisForwardingClient([]);
      const sheetBotCacheClient = makeSheetBotCacheClient({
        member: Option.some({ roles: [] }),
      });

      yield* runAuthorization(
        Effect.gen(function* () {
          const authorization = yield* AuthorizationService;
          yield* authorization.resolveCurrentWorkspaceUser("guild-1");
          yield* authorization.resolveCurrentWorkspaceUser("guild-1");
        }),
        {
          sheetApisForwardingClient: client,
          sheetBotCacheClient,
        },
      );

      expect(getWorkspaceMonitorRoles).toHaveBeenCalledTimes(1);
      expect(sheetBotCacheClient.getMember).toHaveBeenCalledTimes(1);
    }),
  );

  it.live("refreshes resolved guild permissions after the cache ttl", () =>
    Effect.gen(function* () {
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

      const resolvedUsers = yield* Effect.scoped(
        runAuthorization(
          Effect.gen(function* () {
            const authorization = yield* AuthorizationService;
            const initialUser = yield* authorization.resolveCurrentWorkspaceUser("guild-1");
            memberRoles = ["role-1"];
            const cachedUser = yield* authorization.resolveCurrentWorkspaceUser("guild-1");
            yield* TestClock.adjust(Duration.seconds(31));
            const refreshedUser = yield* authorization.resolveCurrentWorkspaceUser("guild-1");

            return { cachedUser, initialUser, refreshedUser };
          }),
          { sheetBotCacheClient },
        ).pipe(Effect.provide(TestClock.layer())),
      );

      expect(
        hasWorkspacePermission(
          resolvedUsers.initialUser.permissions,
          "manage_workspace",
          "guild-1",
        ),
      ).toBe(false);
      expect(
        hasWorkspacePermission(resolvedUsers.cachedUser.permissions, "manage_workspace", "guild-1"),
      ).toBe(false);
      expect(
        hasWorkspacePermission(
          resolvedUsers.refreshedUser.permissions,
          "manage_workspace",
          "guild-1",
        ),
      ).toBe(true);
      expect(sheetBotCacheClient.getMember).toHaveBeenCalledTimes(2);
      expect(sheetBotCacheClient.getRolesForGuild).toHaveBeenCalledTimes(2);
    }),
  );

  it.live("caches guild role lookups across users for the same guild", () =>
    Effect.gen(function* () {
      const sheetBotCacheClient = makeSheetBotCacheClient({
        member: Option.some({ roles: ["role-1"] }),
        roles: new Map([["role-1", { id: "role-1", permissions: "32" }]]),
      });

      yield* runAuthorization(
        Effect.gen(function* () {
          const authorization = yield* AuthorizationService;
          yield* authorization.resolveCurrentWorkspaceUser("guild-1");
          yield* authorization.resolveSheetAuthWorkspaceUser(
            makeUser([], { accountId: "discord-user-2", userId: "user-2" }),
            "guild-1",
          );
        }),
        { sheetBotCacheClient },
      );

      expect(sheetBotCacheClient.getRolesForGuild).toHaveBeenCalledTimes(1);
    }),
  );

  it.live("caches monitor role lookups across users for the same guild", () =>
    Effect.gen(function* () {
      const { client, getWorkspaceMonitorRoles } = makeSheetApisForwardingClient(["role-1"]);
      const sheetBotCacheClient = makeSheetBotCacheClient({
        member: Option.some({ roles: ["role-1"] }),
      });

      yield* runAuthorization(
        Effect.gen(function* () {
          const authorization = yield* AuthorizationService;
          yield* authorization.resolveCurrentWorkspaceUser("guild-1");
          yield* authorization.resolveSheetAuthWorkspaceUser(
            makeUser([], { accountId: "discord-user-2", userId: "user-2" }),
            "guild-1",
          );
        }),
        { sheetApisForwardingClient: client, sheetBotCacheClient },
      );

      expect(getWorkspaceMonitorRoles).toHaveBeenCalledTimes(1);
    }),
  );

  it.live("degrades safely when guild permission lookups fail", () =>
    Effect.gen(function* () {
      const sheetApisForwardingClient = {
        workspaceConfig: {
          getWorkspaceMonitorRoles: () =>
            Effect.fail(
              new SheetIngressServerServicesAuthorizationTestError({ message: "lookup failed" }),
            ),
        },
      } as never;
      const sheetBotCacheClient = makeSheetBotCacheClient({
        memberError: new Error("member lookup failed"),
        rolesError: new Error("roles lookup failed"),
      });

      const resolvedUser = yield* runAuthorization(
        Effect.gen(function* () {
          const authorization = yield* AuthorizationService;
          return yield* authorization.resolveCurrentWorkspaceUser("guild-1");
        }),
        { sheetApisForwardingClient, sheetBotCacheClient },
      );

      expect(Array.from(resolvedUser.permissions)).toEqual([]);
    }),
  );

  it.live("resolves manage guild permission from cached role permissions", () =>
    Effect.gen(function* () {
      const sheetBotCacheClient = makeSheetBotCacheClient({
        member: Option.some({ roles: ["role-1"] }),
        roles: new Map([["role-1", { id: "role-1", permissions: "32" }]]),
      });

      yield* runAuthorization(
        Effect.gen(function* () {
          const authorization = yield* AuthorizationService;
          yield* authorization.requireManageWorkspace("guild-1");
        }),
        { sheetBotCacheClient },
      );
    }),
  );

  it.live("resolves manage guild permission from the implicit everyone role", () =>
    Effect.gen(function* () {
      const sheetBotCacheClient = makeSheetBotCacheClient({
        member: Option.some({ roles: [] }),
        roles: new Map([["guild-1", { id: "guild-1", permissions: "32" }]]),
      });

      yield* runAuthorization(
        Effect.gen(function* () {
          const authorization = yield* AuthorizationService;
          yield* authorization.requireManageWorkspace("guild-1");
        }),
        { sheetBotCacheClient },
      );
    }),
  );
});
