import { describe, expect, it, vi } from "vitest";
import { handleOAuth2TokenRequest, isOAuth2TokenRequest } from "./oauth-token-handler";

describe("isOAuth2TokenRequest", () => {
  it("matches POST /oauth2/token requests", () => {
    expect(
      isOAuth2TokenRequest(
        new Request("https://auth.example.com/oauth2/token", {
          method: "POST",
        }),
      ),
    ).toBe(true);
    expect(isOAuth2TokenRequest(new Request("https://auth.example.com/oauth2/token"))).toBe(false);
  });
});

describe("handleOAuth2TokenRequest", () => {
  it("returns the generated oauth2Token response as JSON", async () => {
    const oauth2Token = vi.fn(async () => ({
      response: {
        access_token: "access-token-1",
        token_type: "Bearer",
        expires_in: 3600,
      },
      status: 200,
    }));
    const request = new Request("https://auth.example.com/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials&client_id=sheet-bot&client_secret=client-secret",
    });

    const response = await handleOAuth2TokenRequest({ api: { oauth2Token } }, request);

    expect(oauth2Token).toHaveBeenCalledWith({
      body: {
        grant_type: "client_credentials",
        client_id: "sheet-bot",
        client_secret: "client-secret",
      },
      headers: request.headers,
      request,
      asResponse: false,
      returnHeaders: true,
      returnStatus: true,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(await response.json()).toEqual({
      access_token: "access-token-1",
      token_type: "Bearer",
      expires_in: 3600,
    });
  });

  it("maps generated oauth2Token API errors to JSON", async () => {
    const error = Object.assign(new Error("missing client"), {
      statusCode: 400,
      body: {
        error: "invalid_client",
        error_description: "missing client",
      },
    });
    const oauth2Token = vi.fn(async () => {
      throw error;
    });
    const request = new Request("https://auth.example.com/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials&client_id=missing",
    });

    const response = await handleOAuth2TokenRequest({ api: { oauth2Token } }, request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_client",
      error_description: "missing client",
    });
  });
});
