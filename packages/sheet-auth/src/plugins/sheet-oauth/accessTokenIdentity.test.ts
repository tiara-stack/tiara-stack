import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyOAuthAccessToken } from ".";

const resourceClientMock = vi.hoisted(() => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock("@better-auth/oauth-provider/resource-client", () => ({
  oauthProviderResourceClient: () => ({
    getActions: () => ({
      verifyAccessToken: resourceClientMock.verifyAccessToken,
    }),
  }),
}));

describe("verifyOAuthAccessToken", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("passes resource metadata mappings for internal resource audiences", async () => {
    resourceClientMock.verifyAccessToken.mockResolvedValue({
      aud: "sheet-ingress",
      iss: "https://auth.example.com",
      scope: "user",
      sub: "user-1",
    });

    await verifyOAuthAccessToken("access-token", {
      issuer: "https://auth.example.com/",
      jwksUrl: "http://127.0.0.1:3000/jwks",
      validAudiences: [
        "https://auth.example.com",
        "sheet-ingress",
        "sheet-ingress/admin",
        "sheet-apis",
        "sheet-workflows",
        "sheet-bot",
      ],
    });

    expect(resourceClientMock.verifyAccessToken).toHaveBeenCalledWith("access-token", {
      jwksUrl: "http://127.0.0.1:3000/jwks",
      verifyOptions: {
        audience: [
          "https://auth.example.com",
          "sheet-ingress",
          "sheet-ingress/admin",
          "sheet-apis",
          "sheet-workflows",
          "sheet-bot",
        ],
        issuer: "https://auth.example.com",
      },
      resourceMetadataMappings: {
        "sheet-ingress":
          "https://auth.example.com/.well-known/oauth-protected-resource/sheet-ingress",
        "sheet-ingress/admin":
          "https://auth.example.com/.well-known/oauth-protected-resource/sheet-ingress%2Fadmin",
        "sheet-apis": "https://auth.example.com/.well-known/oauth-protected-resource/sheet-apis",
        "sheet-workflows":
          "https://auth.example.com/.well-known/oauth-protected-resource/sheet-workflows",
        "sheet-bot": "https://auth.example.com/.well-known/oauth-protected-resource/sheet-bot",
      },
    });
  });
});
