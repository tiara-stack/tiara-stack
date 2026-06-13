import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeOAuthResourceTokenAuthorizer } from "./oauth-resource-authorization";

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

  it("uses authorization server metadata issuer while keeping internal jwks url", async () => {
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
      azp: "sheet-ingress-server",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://auth.example.com",
      scope: "ingress.forward",
    });

    const authorizer = await Effect.runPromise(
      makeOAuthResourceTokenAuthorizer({
        issuer: "http://sheet-auth-service",
        audience: "sheet-workflows",
        requiredScopes: ["ingress.forward"],
      }),
    );
    await Effect.runPromise(authorizer.requireAuthorizedBearerToken("access-token-1"));

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
  });

  it("falls back to the base issuer when authorization server metadata fails", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    verifyAccessToken.mockResolvedValue({
      aud: "sheet-workflows",
      azp: "sheet-ingress-server",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "http://sheet-auth-service",
      scope: "ingress.forward",
    });

    const authorizer = await Effect.runPromise(
      makeOAuthResourceTokenAuthorizer({
        issuer: "http://sheet-auth-service",
        audience: "sheet-workflows",
        requiredScopes: ["ingress.forward"],
      }),
    );
    await Effect.runPromise(authorizer.requireAuthorizedBearerToken("access-token-1"));

    expect(verifyAccessToken).toHaveBeenCalledWith(
      "access-token-1",
      expect.objectContaining({
        verifyOptions: {
          audience: "sheet-workflows",
          issuer: "http://sheet-auth-service",
        },
      }),
    );
  });
});
