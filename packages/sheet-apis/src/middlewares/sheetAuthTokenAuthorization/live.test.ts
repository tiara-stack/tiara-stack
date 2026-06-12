import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { ConfigProvider, Effect, HashSet, Redacted, Schema } from "effect";
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

const runMiddleware = (
  headers: Headers.Headers,
  rpcTag = "permissions.getCurrentUserPermissions",
): Promise<AuthorizedUser> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const authorization = yield* SheetApisRpcAuthorization;
        return yield* authorization(
          Effect.gen(function* () {
            const user = yield* SheetAuthUser;
            return {
              accountId: user.accountId,
              userId: user.userId,
              permissions: user.permissions,
              token: Redacted.value(user.token),
            };
          }) as never,
          {
            client: {} as never,
            requestId: 0 as never,
            rpc: SheetApisRpcs.requests.get(rpcTag) as never,
            payload: undefined,
            headers,
          },
        );
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
      ) as unknown as Effect.Effect<AuthorizedUser, never, never>,
    ),
  );

const runUnconfiguredMiddleware = (headers: Headers.Headers): Promise<AuthorizedUser> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const authorization = yield* SheetApisRpcAuthorization;
        return yield* authorization(
          Effect.gen(function* () {
            const user = yield* SheetAuthUser;
            return {
              accountId: user.accountId,
              userId: user.userId,
              permissions: user.permissions,
              token: Redacted.value(user.token),
            };
          }) as never,
          {
            client: {} as never,
            requestId: 0 as never,
            rpc: Rpc.make("unconfigured.rpc", { success: Schema.Void }).middleware(
              SheetApisRpcAuthorization,
            ) as never,
            payload: undefined,
            headers,
          },
        );
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
      ) as unknown as Effect.Effect<AuthorizedUser, never, never>,
    ),
  );

describe("SheetAuthTokenAuthorizationLive", () => {
  it("provides forwarded sheet-auth session token on SheetAuthUser", async () => {
    const user = await runMiddleware(
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
  });

  it("uses unavailable sentinel when no sheet-auth session token is forwarded", async () => {
    const user = await runMiddleware(
      makeHeaders({
        "x-sheet-ingress-auth": "Bearer ingress-token",
        "x-sheet-auth-user-id": "service-user",
        "x-sheet-auth-account-id": "service",
        "x-sheet-auth-permissions": "service",
      }),
      "sheet.getPlayers",
    );

    expect(user.token).toBe(SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE);
  });

  it("rejects forwarded users that lack the route OAuth scope", async () => {
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

    await expect(effect).rejects.toThrow(
      "permissions.getCurrentUserPermissions requires sheet.read scope",
    );
  });

  it("rejects protected RPCs without a declared scope policy", async () => {
    const effect = runUnconfiguredMiddleware(
      makeHeaders({
        "x-sheet-ingress-auth": "Bearer ingress-token",
        "x-sheet-auth-user-id": "user-1",
        "x-sheet-auth-account-id": "discord-user-1",
        "x-sheet-auth-permissions": "account:discord:discord-user-1",
        "x-sheet-auth-scopes": "sheet.read",
      }),
    );

    await expect(effect).rejects.toThrow("No OAuth scope policy configured for unconfigured.rpc");
  });

  it("allows sheet.write RPCs with sheet.write scope", async () => {
    const user = await runMiddleware(
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
  });

  it("rejects sheet.write RPCs with only sheet.read scope", async () => {
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

    await expect(effect).rejects.toThrow(
      "messageSlot.upsertMessageSlotData requires sheet.write scope",
    );
  });

  it("allows sheet.manage RPCs with sheet.manage scope", async () => {
    const user = await runMiddleware(
      makeHeaders({
        "x-sheet-ingress-auth": "Bearer ingress-token",
        "x-sheet-auth-user-id": "user-1",
        "x-sheet-auth-account-id": "discord-user-1",
        "x-sheet-auth-permissions": "account:discord:discord-user-1",
        "x-sheet-auth-scopes": "sheet.manage",
      }),
      "guildConfig.getGuildConfig",
    );

    expect(user.accountId).toBe("discord-user-1");
  });

  it("allows service RPCs with service permission", async () => {
    const user = await runMiddleware(
      makeHeaders({
        "x-sheet-ingress-auth": "Bearer ingress-token",
        "x-sheet-auth-user-id": "service-user",
        "x-sheet-auth-account-id": "service",
        "x-sheet-auth-permissions": "service",
      }),
      "sheet.getPlayers",
    );

    expect(HashSet.has(user.permissions, "service")).toBe(true);
  });

  it("rejects service RPCs for ordinary user scopes", async () => {
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

    await expect(effect).rejects.toThrow("sheet.getPlayers requires service permission");
  });

  it("allows none-policy RPCs after ingress forwarding auth succeeds", async () => {
    const user = await runMiddleware(
      makeHeaders({
        "x-sheet-ingress-auth": "Bearer ingress-token",
        "x-sheet-auth-user-id": "user-1",
        "x-sheet-auth-account-id": "discord-user-1",
        "x-sheet-auth-permissions": "account:discord:discord-user-1",
      }),
      "status.getServices",
    );

    expect(user.accountId).toBe("discord-user-1");
  });
});
