import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { ConfigProvider, Effect, HashSet, Redacted } from "effect";
import { Headers } from "effect/unstable/http";
import { SheetApisRpcAuthorization } from "sheet-ingress-api/middlewares/sheetApisRpcAuthorization/tag";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE } from "@/services/discordAccessToken";
import { SheetAuthTokenAuthorizationLive } from "./live";

interface AuthorizedUser {
  readonly accountId: string;
  readonly userId: string;
  readonly permissions: HashSet.HashSet<string>;
  readonly token: string;
}

vi.mock("sheet-auth/plugins/kubernetes-oauth/rpc-authorization", async () => {
  const { Duration, Effect } = await import("effect");
  return {
    // fallow-ignore-next-line code-duplication
    getBearerToken: (authorization: string | undefined) => {
      if (!authorization?.startsWith("Bearer ")) {
        return undefined;
      }

      const token = authorization.slice("Bearer ".length).trim();
      return token.length === 0 ? undefined : token;
    },
    makeKubernetesServiceAccountTokenAuthorizer: vi.fn(() =>
      Effect.succeed({
        requireAuthorizedBearerToken: vi.fn(() =>
          Effect.succeed({
            exp: Math.floor(Date.now() / 1000) + 60,
            sub: "system:serviceaccount:default:sheet-ingress-server",
            ttl: Duration.minutes(1),
          }),
        ),
        requireAuthorizedHeaders: vi.fn(() =>
          Effect.succeed({
            exp: Math.floor(Date.now() / 1000) + 60,
            sub: "system:serviceaccount:default:sheet-ingress-server",
            ttl: Duration.minutes(1),
          }),
        ),
      }),
    ),
  };
});

const makeHeaders = (headers: Record<string, string>) =>
  Object.entries(headers).reduce(
    (acc, [key, value]) => Headers.set(acc, key, value),
    Headers.empty,
  );

const runMiddleware = (headers: Headers.Headers): Promise<AuthorizedUser> =>
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
            rpc: {} as never,
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
              SHEET_INGRESS_KUBERNETES_AUDIENCE: "sheet-apis",
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
    );

    expect(user.token).toBe(SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE);
  });
});
