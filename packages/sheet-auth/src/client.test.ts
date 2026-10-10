import { Effect, Redacted } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vitest";
import { createOAuthClientCredentialsToken, createSheetAuthClient } from "./client";

describe("createSheetAuthClient", () => {
  it("rejects issuer URLs with unsupported query or fragment components", () => {
    const invalidIssuers = [
      "/auth",
      "https://auth.example.com?tenant=sheet-web",
      "https://auth.example.com#issuer",
    ];
    for (const issuer of invalidIssuers)
      expect(() => createSheetAuthClient(issuer)).toThrow(
        "SHEET_AUTH_ISSUER must be an absolute HTTP(S) URL without query or fragment components",
      );
  });
});

describe("createOAuthClientCredentialsToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.live("requests client credentials tokens with form encoding", () =>
    Effect.gen(function* () {
      const fetch = vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) =>
          new Response(
            JSON.stringify({
              access_token: "access-token-1",
              token_type: "Bearer",
              expires_in: 3600,
              expires_at: 1_800_000_000,
              scope: "service workflow.dispatch",
            }),
            {
              headers: {
                "Content-Type": "application/json",
              },
              status: 200,
            },
          ),
      );
      vi.stubGlobal("fetch", fetch);

      const token = yield* createOAuthClientCredentialsToken(
        createSheetAuthClient("https://auth.example.com"),
        {
          clientId: "sheet-bot",
          clientSecret: Redacted.make("client-secret"),
          resource: "sheet-workflows-http",
          scope: ["service", "workflow.enqueue"],
        },
      );

      expect(Redacted.value(token.accessToken)).toBe("access-token-1");
      expect(fetch).toHaveBeenCalledOnce();

      const [url, init] = fetch.mock.calls[0]!;
      if (!init) {
        throw new Error("Expected request init");
      }
      const requestUrl = url instanceof URL ? url.href : url instanceof Request ? url.url : url;
      expect(requestUrl).toBe("https://auth.example.com/oauth2/token");
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );
      expect(init.body).toBe(
        "grant_type=client_credentials&client_id=sheet-bot&client_secret=client-secret&scope=service+workflow.enqueue&resource=sheet-workflows-http",
      );
    }),
  );

  it.live("preserves a mediated gateway path prefix for auth requests", () =>
    Effect.gen(function* () {
      const fetch = vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) =>
          new Response(
            JSON.stringify({
              access_token: "access-token-1",
              token_type: "Bearer",
              expires_in: 3600,
              expires_at: 1_800_000_000,
              scope: "service workflow.dispatch",
            }),
            { headers: { "Content-Type": "application/json" }, status: 200 },
          ),
      );
      vi.stubGlobal("fetch", fetch);

      yield* createOAuthClientCredentialsToken(
        createSheetAuthClient(
          "https://p-session-sheet-web.dev.theerapakg.moe/_preview/dependencies/auth/",
        ),
        {
          clientId: "sheet-web",
          clientSecret: Redacted.make("client-secret"),
          resource: "sheet-zero",
          scope: ["service", "zero.read"],
        },
      );

      const [url] = fetch.mock.calls[0]!;
      const requestUrl = url instanceof URL ? url.href : url instanceof Request ? url.url : url;
      expect(requestUrl).toBe(
        "https://p-session-sheet-web.dev.theerapakg.moe/_preview/dependencies/auth/oauth2/token",
      );
    }),
  );
});
