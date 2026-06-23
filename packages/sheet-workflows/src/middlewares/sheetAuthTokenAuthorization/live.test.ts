// fallow-ignore-file code-duplication
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Cause, ConfigProvider, Effect, HashSet, Redacted, Schema } from "effect";
import { Headers } from "effect/unstable/http";
import { Rpc } from "effect/unstable/rpc";
import { SheetApisRpcAuthorization } from "sheet-ingress-api/middlewares/sheetApisRpcAuthorization/tag";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { DispatchWorkflowRpcs } from "sheet-ingress-api/sheet-workflows-workflows";
import { SheetAuthTokenAuthorizationLive } from "./live";

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

const runMiddleware = (headers: Headers.Headers, rpcTag = "dispatch.checkin") =>
  Effect.scoped(
    Effect.gen(function* () {
      const authorization = yield* SheetApisRpcAuthorization;
      return yield* authorization(
        Effect.gen(function* () {
          const user = yield* SheetAuthUser;
          return {
            permissions: user.permissions,
            token: Redacted.value(user.token),
          };
        }) as never,
        {
          client: {} as never,
          requestId: 0 as never,
          rpc: DispatchWorkflowRpcs.requests.get(rpcTag) as never,
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
            SHEET_AUTH_OAUTH_AUDIENCE: "sheet-workflows",
          }),
        ),
      ),
    ) as unknown as Effect.Effect<
      { readonly permissions: HashSet.HashSet<string>; readonly token: string },
      never,
      never
    >,
  );

const runUnconfiguredMiddleware = (headers: Headers.Headers) =>
  Effect.scoped(
    Effect.gen(function* () {
      const authorization = yield* SheetApisRpcAuthorization;
      return yield* authorization(
        Effect.gen(function* () {
          const user = yield* SheetAuthUser;
          return {
            permissions: user.permissions,
            token: Redacted.value(user.token),
          };
        }) as never,
        {
          client: {} as never,
          requestId: 0 as never,
          rpc: Rpc.make("unconfigured.workflow", { success: Schema.Void }).middleware(
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
            SHEET_AUTH_OAUTH_AUDIENCE: "sheet-workflows",
          }),
        ),
      ),
    ) as unknown as Effect.Effect<
      { readonly permissions: HashSet.HashSet<string>; readonly token: string },
      never,
      never
    >,
  );

describe("SheetAuthTokenAuthorizationLive", () => {
  it.live("allows workflow dispatch calls with workflow.dispatch scope", () =>
    Effect.gen(function* () {
      const user = yield* runMiddleware(
        makeHeaders({
          "x-sheet-ingress-auth": "Bearer ingress-token",
          "x-sheet-auth-user-id": "user-1",
          "x-sheet-auth-account-id": "discord-user-1",
          "x-sheet-auth-permissions": "account:discord:discord-user-1",
          "x-sheet-auth-scopes": "workflow.dispatch",
          "x-sheet-auth-session-token": "Bearer sheet-auth-session-token",
        }),
      );

      expect(HashSet.has(user.permissions, "account:discord:discord-user-1")).toBe(true);
      expect(user.token).toBe("sheet-auth-session-token");
    }),
  );

  it.live("rejects workflow dispatch calls without workflow.dispatch scope", () =>
    Effect.gen(function* () {
      const effect = runMiddleware(
        makeHeaders({
          "x-sheet-ingress-auth": "Bearer ingress-token",
          "x-sheet-auth-user-id": "user-1",
          "x-sheet-auth-account-id": "discord-user-1",
          "x-sheet-auth-permissions": "account:discord:discord-user-1",
          "x-sheet-auth-scopes": "sheet.read",
        }),
      );

      const exit = yield* Effect.exit(effect);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.pretty(exit.cause)).toContain(
          "dispatch.checkin requires workflow.dispatch scope",
        );
      }
    }),
  );

  it.live("rejects protected workflow RPCs without a declared scope policy", () =>
    Effect.gen(function* () {
      const effect = runUnconfiguredMiddleware(
        makeHeaders({
          "x-sheet-ingress-auth": "Bearer ingress-token",
          "x-sheet-auth-user-id": "user-1",
          "x-sheet-auth-account-id": "discord-user-1",
          "x-sheet-auth-permissions": "account:discord:discord-user-1",
          "x-sheet-auth-scopes": "workflow.dispatch",
        }),
      );

      const exit = yield* Effect.exit(effect);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.pretty(exit.cause)).toContain(
          "No OAuth scope policy configured for unconfigured.workflow",
        );
      }
    }),
  );
});
