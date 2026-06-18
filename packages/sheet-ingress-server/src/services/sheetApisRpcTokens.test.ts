import { beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { ConfigProvider, Effect, HashSet, Layer, Redacted } from "effect";
import { createOAuthClientCredentialsToken } from "sheet-auth/client";
import { DISCORD_SERVICE_USER_ID_SENTINEL } from "sheet-auth/oauth";
import { SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE } from "sheet-ingress-api/middlewares/forwardedAuthHeaders";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";
import { SheetAuthClient } from "./sheetAuthClient";

vi.mock("sheet-auth/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sheet-auth/client")>();
  return {
    ...actual,
    createOAuthClientCredentialsToken: vi.fn(),
  };
});

const run = <A, E>(effect: Effect.Effect<A, E, SheetApisRpcTokens>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.effect(SheetApisRpcTokens, SheetApisRpcTokens.make)),
      Effect.provideService(SheetAuthClient, {} as never),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            SHEET_AUTH_OAUTH_CLIENT_ID: "sheet-ingress-server",
            SHEET_AUTH_OAUTH_CLIENT_SECRET: "client-secret",
          }),
        ),
      ),
    ),
  );

describe("SheetApisRpcTokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the fallback service user without requesting a service OAuth token", async () => {
    const user = await run(
      Effect.gen(function* () {
        const tokens = yield* SheetApisRpcTokens;
        return yield* tokens.getServiceUser();
      }),
    );

    expect(user.accountId).toBe(DISCORD_SERVICE_USER_ID_SENTINEL);
    expect(user.userId).toBe(DISCORD_SERVICE_USER_ID_SENTINEL);
    expect(HashSet.has(user.permissions, "service")).toBe(true);
    expect(user.scopes.has("service")).toBe(true);
    expect(Redacted.value(user.token)).toBe(SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE);
    expect(createOAuthClientCredentialsToken).not.toHaveBeenCalled();
  });

  it("requests ingress forwarding OAuth tokens for forwarded RPC calls", async () => {
    vi.mocked(createOAuthClientCredentialsToken).mockReturnValueOnce(
      Effect.succeed({
        accessToken: Redacted.make("ingress-token"),
        expiresAt: 1_800_000_000,
        expiresIn: 3600,
        scope: "ingress.forward",
        tokenType: "Bearer",
      }) as never,
    );

    const token = await run(
      Effect.gen(function* () {
        const tokens = yield* SheetApisRpcTokens;
        return yield* tokens.getServiceToken("sheet-apis");
      }),
    );

    expect(token).toBe("ingress-token");
    expect(createOAuthClientCredentialsToken).toHaveBeenCalledOnce();
    expect(createOAuthClientCredentialsToken).toHaveBeenCalledWith(
      {},
      {
        clientId: "sheet-ingress-server",
        clientSecret: expect.anything(),
        resource: "sheet-apis",
        scope: ["ingress.forward"],
      },
    );
    const [, options] = vi.mocked(createOAuthClientCredentialsToken).mock.calls[0]!;
    expect(Redacted.value(options.clientSecret as Redacted.Redacted<string>)).toBe("client-secret");
  });
});
