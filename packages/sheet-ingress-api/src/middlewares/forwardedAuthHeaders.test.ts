import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Redacted } from "effect";
import { Headers } from "effect/unstable/http";
import {
  decodeForwardedSheetAuthUser,
  SHEET_AUTH_SESSION_TOKEN_HEADER,
  SHEET_AUTH_TOKEN_HEADER,
} from "./forwardedAuthHeaders";

const makeHeaders = (headers: Record<string, string>) =>
  Object.entries(headers).reduce(
    (acc, [key, value]) => Headers.set(acc, key, value),
    Headers.empty,
  );

const decode = (headers: Record<string, string>) =>
  decodeForwardedSheetAuthUser(makeHeaders(headers), {
    unavailableToken: Redacted.make("unavailable"),
  });

describe("decodeForwardedSheetAuthUser", () => {
  const baseHeaders = {
    "x-sheet-auth-user-id": "user-1",
    "x-sheet-auth-account-id": "discord-user-1",
    "x-sheet-auth-permissions": "account:discord:discord-user-1",
    "x-sheet-auth-scopes": "sheet.read",
  };

  it.effect("fails when forwarded scopes include an unknown scope", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decode({
          ...baseHeaders,
          "x-sheet-auth-scopes": "sheet.read,unknown.scope",
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("unknown.scope");
      }
    }),
  );

  it.effect("prefers the neutral forwarded sheet-auth token header", () =>
    Effect.gen(function* () {
      const user = yield* decode({
        ...baseHeaders,
        [SHEET_AUTH_TOKEN_HEADER]: "Bearer oauth-token",
        [SHEET_AUTH_SESSION_TOKEN_HEADER]: "Bearer session-token",
      });

      expect(Redacted.value(user.token)).toBe("oauth-token");
      expect(user.tokenType).toBe("oauth_access_token");
    }),
  );

  it.effect("falls back to the legacy forwarded session token header", () =>
    Effect.gen(function* () {
      const user = yield* decode({
        ...baseHeaders,
        [SHEET_AUTH_SESSION_TOKEN_HEADER]: "Bearer session-token",
      });

      expect(Redacted.value(user.token)).toBe("session-token");
      expect(user.tokenType).toBe("session");
    }),
  );

  it.effect("uses the unavailable token when neither forwarded token header is present", () =>
    Effect.gen(function* () {
      const user = yield* decode(baseHeaders);

      expect(Redacted.value(user.token)).toBe("unavailable");
      expect(user.tokenType).toBe("unavailable");
    }),
  );
});
