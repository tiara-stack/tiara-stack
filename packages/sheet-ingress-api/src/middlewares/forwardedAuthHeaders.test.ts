// fallow-ignore-file code-duplication
import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
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
  Effect.runPromise(
    decodeForwardedSheetAuthUser(makeHeaders(headers), {
      unavailableToken: Redacted.make("unavailable"),
    }),
  );

describe("decodeForwardedSheetAuthUser", () => {
  const baseHeaders = {
    "x-sheet-auth-user-id": "user-1",
    "x-sheet-auth-account-id": "discord-user-1",
    "x-sheet-auth-permissions": "account:discord:discord-user-1",
    "x-sheet-auth-scopes": "sheet.read",
  };

  it("fails when forwarded scopes include an unknown scope", async () => {
    await expect(
      decode({
        ...baseHeaders,
        "x-sheet-auth-scopes": "sheet.read,unknown.scope",
      }),
    ).rejects.toThrow("Invalid forwarded auth scopes");
  });

  it("prefers the neutral forwarded sheet-auth token header", async () => {
    const user = await decode({
      ...baseHeaders,
      [SHEET_AUTH_TOKEN_HEADER]: "Bearer oauth-token",
      [SHEET_AUTH_SESSION_TOKEN_HEADER]: "Bearer session-token",
    });

    expect(Redacted.value(user.token)).toBe("oauth-token");
  });

  it("falls back to the legacy forwarded session token header", async () => {
    const user = await decode({
      ...baseHeaders,
      [SHEET_AUTH_SESSION_TOKEN_HEADER]: "Bearer session-token",
    });

    expect(Redacted.value(user.token)).toBe("session-token");
  });

  it("uses the unavailable token when neither forwarded token header is present", async () => {
    const user = await decode(baseHeaders);

    expect(Redacted.value(user.token)).toBe("unavailable");
  });
});
