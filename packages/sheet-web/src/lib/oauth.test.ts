import { describe, expect, it } from "vitest";
import { authorizationCodeRequestBody, isJwtAccessToken, refreshTokenRequestBody } from "./oauth";

describe("OAuth token request bodies", () => {
  it("requests the sheet-ingress resource for authorization code tokens", () => {
    const body = authorizationCodeRequestBody(
      {
        appBaseUrl: new URL("https://app.example.com"),
        authBaseUrl: new URL("https://auth.example.com"),
        clientId: "sheet-web",
        redirectPath: "/auth/oauth/callback",
        scopes: "sheet.read offline_access",
      },
      {
        code: "auth-code",
        codeVerifier: "code-verifier",
      },
    );

    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("resource")).toBe("sheet-ingress");
  });

  it("requests the sheet-ingress resource for refreshed tokens", () => {
    const body = refreshTokenRequestBody(
      {
        accessToken: "opaque-token",
        expiresAt: 1_800_000_000,
        refreshToken: "refresh-token",
        scope: "sheet.read offline_access",
        tokenType: "Bearer",
      },
      "sheet-web",
    );

    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("resource")).toBe("sheet-ingress");
  });
});

describe("isJwtAccessToken", () => {
  it("requires three non-empty compact token parts", () => {
    expect(isJwtAccessToken("header.payload.signature")).toBe(true);
    expect(isJwtAccessToken("opaque-token")).toBe(false);
    expect(isJwtAccessToken("..")).toBe(false);
    expect(isJwtAccessToken("header..signature")).toBe(false);
    expect(isJwtAccessToken(".payload.signature")).toBe(false);
    expect(isJwtAccessToken("header.payload.")).toBe(false);
  });
});
