import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { describe, expect, it, vi } from "vitest";
import { createForwarder } from "./web-forwarder";

describe("createForwarder", () => {
  it("returns the web handler response body", async () => {
    const request = HttpServerRequest.fromWeb(
      new Request("https://auth.example.com/oauth2/token", {
        method: "POST",
        body: "grant_type=client_credentials&client_id=sheet-bot&client_secret=client-secret",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }),
    );
    const forward = createForwarder(async (webRequest) => {
      expect(webRequest.url).toBe("https://auth.example.com/oauth2/token");
      expect(webRequest.method).toBe("POST");
      expect(webRequest.headers.get("Content-Type")).toContain("application/x-www-form-urlencoded");

      const body = new URLSearchParams(await webRequest.text());
      expect(body.get("grant_type")).toBe("client_credentials");
      expect(body.get("client_id")).toBe("sheet-bot");
      expect(body.get("client_secret")).toBe("client-secret");

      return new Response(
        JSON.stringify({
          access_token: "access-token-1",
          token_type: "Bearer",
        }),
        {
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    });

    const effectResponse = await Effect.runPromise(forward({ request }));
    const webResponse = HttpServerResponse.toWeb(effectResponse);

    expect(webResponse.status).toBe(200);
    expect(webResponse.headers.get("Content-Type")).toBe("application/json");
    expect(await webResponse.json()).toEqual({
      access_token: "access-token-1",
      token_type: "Bearer",
    });
  });

  it("returns a 500 response when the web handler rejects", async () => {
    const request = HttpServerRequest.fromWeb(new Request("https://auth.example.com/oauth2/token"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const forward = createForwarder(async () => {
      throw new Error("handler failed");
    });

    const effectResponse = await Effect.runPromise(forward({ request }));
    const webResponse = HttpServerResponse.toWeb(effectResponse);

    expect(webResponse.status).toBe(500);
    expect(await webResponse.text()).toBe("Internal Server Error");
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0]?.[1]).toBeInstanceOf(Error);

    consoleError.mockRestore();
  });

  it("returns a mapped response when request conversion fails", async () => {
    const handler = vi.fn(async () => new Response(null, { status: 204 }));
    const request = {
      source: {},
      url: "http://[invalid",
      method: "GET",
      headers: {
        host: "[invalid",
      },
    } as unknown as HttpServerRequest.HttpServerRequest;
    const forward = createForwarder(handler);

    const effectResponse = await Effect.runPromise(forward({ request }));
    const webResponse = HttpServerResponse.toWeb(effectResponse);

    expect(webResponse.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });
});
