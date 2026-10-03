import { Effect, Exit, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vitest";
import { makeOAuthResourceTokenAuthorizer } from "./oauth-resource-authorization";
import { makeHttpPreviewSessionAuthority } from "./preview-session";

const { verifyAccessToken } = vi.hoisted(() => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock("@better-auth/oauth-provider/resource-client", () => ({
  oauthProviderResourceClient: () => ({
    getActions: () => ({
      verifyAccessToken,
    }),
  }),
}));

describe("makeOAuthResourceTokenAuthorizer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it.live("uses authorization server metadata issuer while keeping internal jwks url", () =>
    Effect.gen(function* () {
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              issuer: "https://auth.example.com",
            }),
            {
              headers: {
                "Content-Type": "application/json",
              },
            },
          ),
      );
      vi.stubGlobal("fetch", fetch);
      verifyAccessToken.mockResolvedValue({
        aud: "sheet-workflows",
        azp: "sheet-workflows",
        exp: Math.floor(Date.now() / 1000) + 60,
        iss: "https://auth.example.com",
        scope: "workflow.enqueue",
      });

      const authorizer = yield* makeOAuthResourceTokenAuthorizer({
        issuer: "http://sheet-auth-service",
        audience: "sheet-workflows",
        requiredScopes: ["workflow.enqueue"],
      });
      yield* authorizer.requireAuthorizedBearerToken("access-token-1");

      expect(fetch).toHaveBeenCalledWith(
        "http://sheet-auth-service/.well-known/oauth-authorization-server",
        expect.objectContaining({
          headers: {
            Accept: "application/json",
          },
          signal: expect.any(AbortSignal),
        }),
      );
      expect(verifyAccessToken).toHaveBeenCalledWith(
        "access-token-1",
        expect.objectContaining({
          jwksUrl: "http://sheet-auth-service/jwks",
          verifyOptions: {
            audience: "sheet-workflows",
            issuer: "https://auth.example.com",
          },
        }),
      );
    }),
  );

  it.live("falls back to the base issuer when authorization server metadata fails", () =>
    Effect.gen(function* () {
      const fetch = vi.fn(async () => new Response(null, { status: 404 }));
      vi.stubGlobal("fetch", fetch);
      verifyAccessToken.mockResolvedValue({
        aud: "sheet-workflows",
        azp: "sheet-workflows",
        exp: Math.floor(Date.now() / 1000) + 60,
        iss: "http://sheet-auth-service",
        scope: "workflow.enqueue",
      });

      const authorizer = yield* makeOAuthResourceTokenAuthorizer({
        issuer: "http://sheet-auth-service",
        audience: "sheet-workflows",
        requiredScopes: ["workflow.enqueue"],
      });
      yield* authorizer.requireAuthorizedBearerToken("access-token-1");

      expect(verifyAccessToken).toHaveBeenCalledWith(
        "access-token-1",
        expect.objectContaining({
          verifyOptions: {
            audience: "sheet-workflows",
            issuer: "http://sheet-auth-service",
          },
        }),
      );
    }),
  );

  it.live("requires a configured trusted client when requested", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ issuer: "https://auth.example.com" }), {
              headers: { "Content-Type": "application/json" },
            }),
        ),
      );
      verifyAccessToken.mockResolvedValue({
        aud: "sheet-workflows-http",
        azp: "untrusted-client",
        exp: Math.floor(Date.now() / 1000) + 60,
        iss: "https://auth.example.com",
        scope: "service rollout.gate.write",
      });

      const authorizer = yield* makeOAuthResourceTokenAuthorizer({
        issuer: "http://sheet-auth-service",
        audience: "sheet-workflows-http",
        requiredScopes: ["service", "rollout.gate.write"],
        trustedClientIds: new Set(["trusted-client"]),
      });
      const denied = yield* Effect.exit(authorizer.requireAuthorizedBearerToken("untrusted-token"));

      expect(Exit.isFailure(denied)).toBe(true);

      verifyAccessToken.mockResolvedValue({
        aud: "sheet-workflows-http",
        azp: "trusted-client",
        exp: Math.floor(Date.now() / 1000) + 60,
        iss: "https://auth.example.com",
        scope: "service rollout.gate.write",
      });
      const authorized = yield* authorizer.requireAuthorizedBearerToken("trusted-token");

      expect(authorized.clientId).toBe("trusted-client");
    }),
  );

  it.live("rechecks preview session generation after JWT verification cache hits", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ issuer: "https://auth.example.com" }), {
              headers: { "Content-Type": "application/json" },
            }),
        ),
      );
      verifyAccessToken.mockResolvedValue({
        aud: "sheet-workflows",
        azp: "preview-runner-client",
        exp: Math.floor(Date.now() / 1000) + 300,
        iss: "https://auth.example.com",
        scope: "workflow.enqueue",
        tiara_preview_session: {
          sessionId: "session-a",
          generation: 4,
          role: "sheet-workflows-runner",
        },
      });
      let active = true;
      const authorize = vi.fn(async ({ binding, clientId }) => {
        expect(binding).toEqual({
          sessionId: "session-a",
          generation: 4,
          role: "sheet-workflows-runner",
        });
        expect(clientId).toBe("preview-runner-client");
        return active;
      });
      const authorizer = yield* makeOAuthResourceTokenAuthorizer({
        issuer: "http://sheet-auth-service",
        audience: "sheet-workflows",
        requiredScopes: ["workflow.enqueue"],
        requirePreviewSession: true,
        previewSessionAuthority: { authorize, requiresBinding: async () => true },
      });

      yield* authorizer.requireAuthorizedBearerToken("still-cryptographically-valid-token");
      active = false;
      const denied = yield* Effect.exit(
        authorizer.requireAuthorizedBearerToken("still-cryptographically-valid-token"),
      );
      expect(Exit.isFailure(denied)).toBe(true);
      expect(authorize).toHaveBeenCalledTimes(2);
      expect(verifyAccessToken).toHaveBeenCalledTimes(1);
    }),
  );

  it.live("rejects malformed preview binding claims even when bindings are optional", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ issuer: "https://auth.example.com" }), {
              headers: { "Content-Type": "application/json" },
            }),
        ),
      );
      verifyAccessToken.mockResolvedValue({
        aud: "sheet-workflows",
        azp: "ordinary-client",
        exp: Math.floor(Date.now() / 1000) + 60,
        iss: "https://auth.example.com",
        scope: "workflow.enqueue",
        tiara_preview_session: { sessionId: 42, generation: "invalid", role: "sheet-web" },
      });

      const authorizer = yield* makeOAuthResourceTokenAuthorizer({
        issuer: "http://sheet-auth-service",
        audience: "sheet-workflows",
        requiredScopes: ["workflow.enqueue"],
      });
      const result = yield* Effect.exit(
        authorizer.requireAuthorizedBearerToken("malformed-preview-binding-token"),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.live("denies a cached unexpired preview JWT after the HTTPS controller reports stop", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ issuer: "https://auth.example.com" }), {
              headers: { "Content-Type": "application/json" },
            }),
        ),
      );
      verifyAccessToken.mockResolvedValue({
        aud: "sheet-workflows",
        azp: "preview-runner-client",
        exp: Math.floor(Date.now() / 1000) + 300,
        iss: "https://auth.example.com",
        scope: "workflow.enqueue",
        tiara_preview_session: {
          sessionId: "session-a",
          generation: 4,
          role: "sheet-workflows-runner",
        },
      });
      let active = true;
      let authorityCalls = 0;
      const httpClient = HttpClient.make((request) => {
        authorityCalls += 1;
        expect(request.url).toBe("https://preview-controller.dev/_internal/preview/v1/authorize");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ authorized: active }), {
              headers: { "Content-Type": "application/json" },
            }),
          ),
        );
      });
      const previewSessionAuthority = makeHttpPreviewSessionAuthority({
        controllerUrl: "https://preview-controller.dev",
        authorityToken: Redacted.make("authority-token"),
        httpClient,
      });
      const authorizer = yield* makeOAuthResourceTokenAuthorizer({
        issuer: "http://sheet-auth-service",
        audience: "sheet-workflows",
        requiredScopes: ["workflow.enqueue"],
        requirePreviewSession: true,
        previewSessionAuthority,
      });
      yield* authorizer.requireAuthorizedBearerToken("cached-jwt-with-unexpired-exp");
      active = false;
      const denied = yield* Effect.exit(
        authorizer.requireAuthorizedBearerToken("cached-jwt-with-unexpired-exp"),
      );
      expect(Exit.isFailure(denied)).toBe(true);
      expect(authorityCalls).toBe(2);
      expect(verifyAccessToken).toHaveBeenCalledTimes(1);
    }),
  );
});
