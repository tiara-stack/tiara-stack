import { beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import {
  Cause,
  Config,
  ConfigProvider,
  Context,
  Effect,
  Exit,
  HashSet,
  Layer,
  Redacted,
} from "effect";
import { createOAuthClientCredentialsToken, exchangeOAuthToken } from "sheet-auth/client";
import { DISCORD_SERVICE_USER_ID_SENTINEL } from "sheet-auth/oauth";
import { SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE } from "sheet-ingress-api/middlewares/forwardedAuthHeaders";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import type { Permission, SheetAuthOAuthScope } from "sheet-ingress-api/schemas/permissions";
import { Unauthorized } from "typhoon-core/error";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";
import { SheetAuthClient } from "./sheetAuthClient";

vi.mock("sheet-auth/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sheet-auth/client")>();
  return {
    ...actual,
    createOAuthClientCredentialsToken: vi.fn(),
    exchangeOAuthToken: vi.fn(),
  };
});

const run = <A, E>(
  effect: Effect.Effect<A, E, SheetApisRpcTokens>,
  env: Record<string, unknown> = {},
) =>
  effect.pipe(
    Effect.provide(Layer.effect(SheetApisRpcTokens, SheetApisRpcTokens.make)),
    Effect.provideService(SheetAuthClient, {} as never),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          SHEET_AUTH_OAUTH_CLIENT_ID: "sheet-ingress-server",
          SHEET_AUTH_OAUTH_CLIENT_SECRET: "client-secret",
          ...env,
        }),
      ),
    ),
  );

const expectMissingTokenExchangeCredential = (
  exit: Exit.Exit<unknown, unknown>,
  missingKey: string,
) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure: unknown = exit.cause.reasons.find(Cause.isFailReason)?.error;
    expect(failure).toBeInstanceOf(Config.ConfigError);
    expect(String(failure)).toContain(`["${missingKey}"]`);
  }
};

describe("SheetApisRpcTokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.effect("creates the fallback service user without requesting a service OAuth token", () =>
    Effect.gen(function* () {
      const user = yield* run(
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
      expect(user.tokenType).toBe("service");
      expect(createOAuthClientCredentialsToken).not.toHaveBeenCalled();
    }),
  );

  it.effect("requires token-exchange OAuth client credentials to be configured as a pair", () =>
    Effect.gen(function* () {
      const idWithoutSecretExit = yield* Effect.exit(
        run(
          Effect.gen(function* () {
            const tokens = yield* SheetApisRpcTokens;
            return yield* tokens.getServiceUser();
          }),
          {
            SHEET_AUTH_OAUTH_TOKEN_EXCHANGE_CLIENT_ID: "sheet-ingress-token-exchange",
          },
        ),
      );
      const secretWithoutIdExit = yield* Effect.exit(
        run(
          Effect.gen(function* () {
            const tokens = yield* SheetApisRpcTokens;
            return yield* tokens.getServiceUser();
          }),
          {
            SHEET_AUTH_OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET: "exchange-secret",
          },
        ),
      );

      expectMissingTokenExchangeCredential(
        idWithoutSecretExit,
        "SHEET_AUTH_OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET",
      );
      expectMissingTokenExchangeCredential(
        secretWithoutIdExit,
        "SHEET_AUTH_OAUTH_TOKEN_EXCHANGE_CLIENT_ID",
      );
    }),
  );

  it.effect("requests ingress forwarding OAuth tokens for forwarded RPC calls", () =>
    Effect.gen(function* () {
      vi.mocked(createOAuthClientCredentialsToken).mockReturnValueOnce(
        Effect.succeed({
          accessToken: Redacted.make("ingress-token"),
          expiresAt: 1_800_000_000,
          expiresIn: 3600,
          scope: "service ingress.forward",
          tokenType: "Bearer",
        }) as never,
      );

      const token = yield* run(
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
          scope: ["service", "ingress.forward"],
        },
      );
      const [, options] = vi.mocked(createOAuthClientCredentialsToken).mock.calls[0]!;
      expect(Redacted.value(options.clientSecret as Redacted.Redacted<string>)).toBe(
        "client-secret",
      );
    }),
  );

  it.effect("rejects unknown forwarding resources before minting an OAuth token", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        run(
          Effect.gen(function* () {
            const tokens = yield* SheetApisRpcTokens;
            return yield* tokens.getServiceToken("sheet-apiss");
          }),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure: unknown = exit.cause.reasons.find(Cause.isFailReason)?.error;
        expect(failure).toBeInstanceOf(Unauthorized);
        expect((failure as Unauthorized).message).toBe(
          "Unknown OAuth forwarding resource: sheet-apiss",
        );
      }
      expect(createOAuthClientCredentialsToken).not.toHaveBeenCalled();
    }),
  );

  it.effect("filters internal exchange scope from delegated forwarding tokens", () =>
    Effect.gen(function* () {
      vi.mocked(createOAuthClientCredentialsToken).mockReturnValueOnce(
        Effect.succeed({
          accessToken: Redacted.make("actor-token"),
          expiresAt: 1_800_000_000,
          expiresIn: 3600,
          scope: "token.exchange ingress.forward sheet.read",
          tokenType: "Bearer",
        }) as never,
      );
      vi.mocked(exchangeOAuthToken).mockReturnValueOnce(
        Effect.succeed({
          accessToken: Redacted.make("delegated-token"),
          expiresAt: 1_800_000_000,
          expiresIn: 300,
          scope: "ingress.forward sheet.read",
          tokenType: "Bearer",
        }) as never,
      );

      const token = yield* run(
        Effect.gen(function* () {
          const tokens = yield* SheetApisRpcTokens;
          return yield* tokens.getDelegatedAuthorization({
            resource: "sheet-apis",
            user: {
              accountId: "discord-user-1",
              userId: "user-1",
              permissions: HashSet.empty<Permission>(),
              scopes: new Set([
                "sheet.read",
                "token.exchange",
                "bot.impersonate",
              ] satisfies SheetAuthOAuthScope[]),
              token: Redacted.make("sheet-auth-session-token"),
              tokenType: "session",
            } satisfies Context.Service.Shape<typeof SheetAuthUser>,
          });
        }),
        {
          SHEET_AUTH_OAUTH_TOKEN_EXCHANGE_CLIENT_ID: "sheet-ingress-token-exchange",
          SHEET_AUTH_OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET: "exchange-secret",
        },
      );

      expect(Redacted.value(token)).toBe("delegated-token");
      expect(createOAuthClientCredentialsToken).toHaveBeenCalledWith(
        {},
        {
          clientId: "sheet-ingress-token-exchange",
          clientSecret: expect.anything(),
          resource: "sheet-ingress",
          scope: [
            "token.exchange",
            "ingress.forward",
            "sheet.read",
            "sheet.write",
            "sheet.manage",
            "workflow.dispatch",
            "bot.impersonate",
          ],
        },
      );
      expect(exchangeOAuthToken).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          resource: "sheet-apis",
          scope: ["ingress.forward", "sheet.read"],
        }),
      );
    }),
  );
});
