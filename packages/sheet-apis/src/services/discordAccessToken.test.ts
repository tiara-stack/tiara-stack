// fallow-ignore-file code-duplication
import { beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Cause, Effect, Exit, HashSet, Layer, Redacted } from "effect";
import { getDiscordAccessToken, getDiscordAccessTokenWithOAuth } from "sheet-auth/client";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { ArgumentError } from "typhoon-core/error";
import {
  DiscordAccessTokenService,
  SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE,
} from "./discordAccessToken";
import { SheetAuthClient } from "./sheetAuthClient";

vi.mock("sheet-auth/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sheet-auth/client")>();
  return {
    ...actual,
    getDiscordAccessToken: vi.fn(),
    getDiscordAccessTokenWithOAuth: vi.fn(),
  };
});

const makeUser = (token: string) => ({
  accountId: "discord-user-1",
  userId: "user-1",
  permissions: HashSet.empty(),
  scopes: new Set() as never,
  token: Redacted.make(token),
  tokenType: "session" as const,
});

const run = <A, E, R>(effect: Effect.Effect<A, E, R>, token = "sheet-auth-session-token") =>
  provide(effect, token);

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>, token = "sheet-auth-session-token") =>
  effect.pipe(
    Effect.provide(Layer.effect(DiscordAccessTokenService, DiscordAccessTokenService.make)),
    Effect.provideService(SheetAuthClient, {} as never),
    Effect.provideService(SheetAuthUser, makeUser(token)),
  ) as Effect.Effect<A, E, never>;

describe("DiscordAccessTokenService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.effect("retrieves the current user's Discord access token through sheet-auth", () =>
    Effect.gen(function* () {
      vi.mocked(getDiscordAccessTokenWithOAuth).mockReturnValueOnce(
        Effect.succeed({ accessToken: Redacted.make("discord-access-token") }) as never,
      );

      const accessToken = yield* run(
        Effect.gen(function* () {
          const service = yield* DiscordAccessTokenService;
          return yield* service.getCurrentUserDiscordAccessToken();
        }),
      );

      expect(Redacted.value(accessToken)).toBe("discord-access-token");
      expect(getDiscordAccessTokenWithOAuth).toHaveBeenCalledWith(
        {},
        { Authorization: "Bearer sheet-auth-session-token" },
      );
      expect(getDiscordAccessToken).not.toHaveBeenCalled();
    }),
  );

  it.effect("falls back to the Better Auth session endpoint during rollout", () =>
    Effect.gen(function* () {
      vi.mocked(getDiscordAccessTokenWithOAuth).mockReturnValueOnce(
        Effect.fail(new Error("oauth failed")) as never,
      );
      vi.mocked(getDiscordAccessToken).mockReturnValueOnce(
        Effect.succeed({ accessToken: Redacted.make("discord-access-token") }) as never,
      );

      const accessToken = yield* run(
        Effect.gen(function* () {
          const service = yield* DiscordAccessTokenService;
          return yield* service.getCurrentUserDiscordAccessToken();
        }),
      );

      expect(Redacted.value(accessToken)).toBe("discord-access-token");
      expect(getDiscordAccessToken).toHaveBeenCalledWith(
        {},
        { Authorization: "Bearer sheet-auth-session-token" },
      );
    }),
  );

  it.live("fails when the sheet-auth session token is unavailable", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        provide(
          Effect.gen(function* () {
            const service = yield* DiscordAccessTokenService;
            return yield* service.getCurrentUserDiscordAccessToken();
          }),
          SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE,
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("Missing sheet-auth session token");
      }
      expect(getDiscordAccessTokenWithOAuth).not.toHaveBeenCalled();
      expect(getDiscordAccessToken).not.toHaveBeenCalled();
    }),
  );

  it.live("maps sheet-auth lookup failures to ArgumentError", () =>
    Effect.gen(function* () {
      vi.mocked(getDiscordAccessTokenWithOAuth).mockReturnValueOnce(
        Effect.fail(new Error("sheet-auth failed")) as never,
      );
      vi.mocked(getDiscordAccessToken).mockReturnValueOnce(
        Effect.fail(new Error("sheet-auth session failed")) as never,
      );

      const exit = yield* Effect.exit(
        provide(
          Effect.gen(function* () {
            const service = yield* DiscordAccessTokenService;
            return yield* service.getCurrentUserDiscordAccessToken();
          }),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(ArgumentError.name);
      }
    }),
  );
});
