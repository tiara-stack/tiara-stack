// fallow-ignore-file code-duplication
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Cause, ConfigProvider, Effect, Exit, HashSet, Redacted, Schema } from "effect";
import { Headers } from "effect/unstable/http";
import { Rpc } from "effect/unstable/rpc";
import { SheetApisRpcAuthorization } from "sheet-ingress-api/middlewares/sheetApisRpcAuthorization/tag";
import { SheetApisRpcs } from "sheet-ingress-api/sheet-apis-rpc";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE } from "@/services/discordAccessToken";
import { SheetAuthTokenAuthorizationLive } from "./live";

interface AuthorizedUser {
  readonly accountId: string;
  readonly userId: string;
  readonly permissions: HashSet.HashSet<string>;
  readonly token: string;
}

vi.mock("sheet-auth/oauth-resource-authorization", async () => {
  const { Effect } = await import("effect");
  return {
    makeOAuthResourceTokenAuthorizer: vi.fn(() =>
      Effect.succeed({
        requireAuthorizedBearerToken: vi.fn(() => Effect.void),
        requireAuthorizedHeaders: vi.fn(() => Effect.void),
      }),
    ),
  };
});

const makeHeaders = (headers: Record<string, string>) =>
  Object.entries(headers).reduce(
    (acc, [key, value]) => Headers.set(acc, key, value),
    Headers.empty,
  );

const readAuthorizedUser: Effect.Effect<AuthorizedUser, never, SheetAuthUser> = Effect.gen(
  function* () {
    const user = yield* SheetAuthUser;
    return {
      accountId: user.accountId,
      userId: user.userId,
      permissions: user.permissions,
      token: Redacted.value(user.token),
    };
  },
);

const runMiddleware = (
  headers: Headers.Headers,
  rpcTag = "permissions.getCurrentUserPermissions",
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const authorization = yield* SheetApisRpcAuthorization;
      const user = yield* authorization(readAuthorizedUser as never, {
        client: {} as never,
        requestId: 0 as never,
        rpc: SheetApisRpcs.requests.get(rpcTag) as never,
        payload: undefined,
        headers,
      });
      return user as unknown as AuthorizedUser;
    }).pipe(
      Effect.provide(SheetAuthTokenAuthorizationLive),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            POD_NAMESPACE: "default",
            SHEET_AUTH_ISSUER: "https://sheet-auth.example.test",
            SHEET_AUTH_OAUTH_AUDIENCE: "sheet-apis",
          }),
        ),
      ),
    ),
  );

const runUnconfiguredMiddleware = (headers: Headers.Headers) =>
  Effect.scoped(
    Effect.gen(function* () {
      const authorization = yield* SheetApisRpcAuthorization;
      const user = yield* authorization(readAuthorizedUser as never, {
        client: {} as never,
        requestId: 0 as never,
        rpc: Rpc.make("unconfigured.rpc", { success: Schema.Void }).middleware(
          SheetApisRpcAuthorization,
        ) as never,
        payload: undefined,
        headers,
      });
      return user as unknown as AuthorizedUser;
    }).pipe(
      Effect.provide(SheetAuthTokenAuthorizationLive),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            POD_NAMESPACE: "default",
            SHEET_AUTH_ISSUER: "https://sheet-auth.example.test",
            SHEET_AUTH_OAUTH_AUDIENCE: "sheet-apis",
          }),
        ),
      ),
    ),
  );

describe("SheetAuthTokenAuthorizationLive", () => {
  it.live("provides forwarded sheet-auth session token on SheetAuthUser", () =>
    Effect.gen(function* () {
      const user = yield* runMiddleware(
        makeHeaders({
          "x-sheet-ingress-auth": "Bearer ingress-token",
          "x-sheet-auth-user-id": "user-1",
          "x-sheet-auth-account-id": "discord-user-1",
          "x-sheet-auth-permissions": "account:discord:discord-user-1",
          "x-sheet-auth-scopes": "sheet.read",
          "x-sheet-auth-session-token": "Bearer sheet-auth-session-token",
        }),
      );

      expect(user.accountId).toBe("discord-user-1");
      expect(user.userId).toBe("user-1");
      expect(HashSet.has(user.permissions, "account:discord:discord-user-1")).toBe(true);
      expect(user.token).toBe("sheet-auth-session-token");
    }),
  );

  it.live("uses unavailable sentinel when no sheet-auth session token is forwarded", () =>
    Effect.gen(function* () {
      const user = yield* runMiddleware(
        makeHeaders({
          "x-sheet-ingress-auth": "Bearer ingress-token",
          "x-sheet-auth-user-id": "service-user",
          "x-sheet-auth-account-id": "service",
          "x-sheet-auth-permissions": "service",
        }),
        "sheet.getPlayers",
      );

      expect(user.token).toBe(SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE);
    }),
  );

  it.live("rejects forwarded users that lack the route OAuth scope", () =>
    Effect.gen(function* () {
      const effect = runMiddleware(
        makeHeaders({
          "x-sheet-ingress-auth": "Bearer ingress-token",
          "x-sheet-auth-user-id": "user-1",
          "x-sheet-auth-account-id": "discord-user-1",
          "x-sheet-auth-permissions": "account:discord:discord-user-1",
          "x-sheet-auth-scopes": "sheet.write",
        }),
        "permissions.getCurrentUserPermissions",
      );

      const exit = yield* Effect.exit(effect);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(
          "permissions.getCurrentUserPermissions requires sheet.read scope",
        );
      }
    }),
  );

  it.live("rejects protected RPCs without a declared scope policy", () =>
    Effect.gen(function* () {
      const effect = runUnconfiguredMiddleware(
        makeHeaders({
          "x-sheet-ingress-auth": "Bearer ingress-token",
          "x-sheet-auth-user-id": "user-1",
          "x-sheet-auth-account-id": "discord-user-1",
          "x-sheet-auth-permissions": "account:discord:discord-user-1",
          "x-sheet-auth-scopes": "sheet.read",
        }),
      );

      const exit = yield* Effect.exit(effect);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(
          "No OAuth scope policy configured for unconfigured.rpc",
        );
      }
    }),
  );

  it.live("allows sheet.write RPCs with sheet.write scope", () =>
    Effect.gen(function* () {
      const user = yield* runMiddleware(
        makeHeaders({
          "x-sheet-ingress-auth": "Bearer ingress-token",
          "x-sheet-auth-user-id": "user-1",
          "x-sheet-auth-account-id": "discord-user-1",
          "x-sheet-auth-permissions": "account:discord:discord-user-1",
          "x-sheet-auth-scopes": "sheet.write",
        }),
        "messageSlot.upsertMessageSlotData",
      );

      expect(user.accountId).toBe("discord-user-1");
    }),
  );

  it.live("rejects sheet.write RPCs with only sheet.read scope", () =>
    Effect.gen(function* () {
      const effect = runMiddleware(
        makeHeaders({
          "x-sheet-ingress-auth": "Bearer ingress-token",
          "x-sheet-auth-user-id": "user-1",
          "x-sheet-auth-account-id": "discord-user-1",
          "x-sheet-auth-permissions": "account:discord:discord-user-1",
          "x-sheet-auth-scopes": "sheet.read",
        }),
        "messageSlot.upsertMessageSlotData",
      );

      const exit = yield* Effect.exit(effect);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(
          "messageSlot.upsertMessageSlotData requires sheet.write scope",
        );
      }
    }),
  );

  it.live("allows sheet.manage RPCs with sheet.manage scope", () =>
    Effect.gen(function* () {
      const user = yield* runMiddleware(
        makeHeaders({
          "x-sheet-ingress-auth": "Bearer ingress-token",
          "x-sheet-auth-user-id": "user-1",
          "x-sheet-auth-account-id": "discord-user-1",
          "x-sheet-auth-permissions": "account:discord:discord-user-1",
          "x-sheet-auth-scopes": "sheet.manage",
        }),
        "workspaceConfig.getWorkspaceConfig",
      );

      expect(user.accountId).toBe("discord-user-1");
    }),
  );

  it.live("allows service RPCs with service permission", () =>
    Effect.gen(function* () {
      const user = yield* runMiddleware(
        makeHeaders({
          "x-sheet-ingress-auth": "Bearer ingress-token",
          "x-sheet-auth-user-id": "service-user",
          "x-sheet-auth-account-id": "service",
          "x-sheet-auth-permissions": "service",
        }),
        "sheet.getPlayers",
      );

      expect(HashSet.has(user.permissions, "service")).toBe(true);
    }),
  );

  it.live("rejects service RPCs for ordinary user scopes", () =>
    Effect.gen(function* () {
      const effect = runMiddleware(
        makeHeaders({
          "x-sheet-ingress-auth": "Bearer ingress-token",
          "x-sheet-auth-user-id": "user-1",
          "x-sheet-auth-account-id": "discord-user-1",
          "x-sheet-auth-permissions": "account:discord:discord-user-1",
          "x-sheet-auth-scopes": "sheet.read,sheet.write,sheet.manage",
        }),
        "sheet.getPlayers",
      );

      const exit = yield* Effect.exit(effect);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("sheet.getPlayers requires service permission");
      }
    }),
  );

  it.live("allows none-policy RPCs after ingress forwarding auth succeeds", () =>
    Effect.gen(function* () {
      const user = yield* runMiddleware(
        makeHeaders({
          "x-sheet-ingress-auth": "Bearer ingress-token",
          "x-sheet-auth-user-id": "user-1",
          "x-sheet-auth-account-id": "discord-user-1",
          "x-sheet-auth-permissions": "account:discord:discord-user-1",
        }),
        "status.getServices",
      );

      expect(user.accountId).toBe("discord-user-1");
    }),
  );
});
