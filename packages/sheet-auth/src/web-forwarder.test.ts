import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { vi } from "vitest";
import { createForwarder } from "./web-forwarder";

describe("createForwarder", () => {
  it.live("returns the web handler response body", () =>
    Effect.gen(function* () {
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
        expect(webRequest.headers.get("Content-Type")).toContain(
          "application/x-www-form-urlencoded",
        );

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

      const effectResponse = yield* forward({ request });
      const webResponse = HttpServerResponse.toWeb(effectResponse);

      expect(webResponse.status).toBe(200);
      expect(webResponse.headers.get("Content-Type")).toBe("application/json");
      expect(yield* Effect.promise(() => webResponse.json())).toEqual({
        access_token: "access-token-1",
        token_type: "Bearer",
      });
    }),
  );

  it.live("returns a 500 response when the web handler rejects", () =>
    Effect.gen(function* () {
      const request = HttpServerRequest.fromWeb(
        new Request("https://auth.example.com/oauth2/token"),
      );
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const forward = createForwarder(async () => {
          throw new Error("handler failed");
        });

        const effectResponse = yield* forward({ request });
        const webResponse = HttpServerResponse.toWeb(effectResponse);

        expect(webResponse.status).toBe(500);
        expect(yield* Effect.promise(() => webResponse.text())).toBe("Internal Server Error");
        expect(consoleError).toHaveBeenCalledOnce();
        expect(consoleError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
      } finally {
        consoleError.mockRestore();
      }
    }),
  );

  it.live("returns a mapped response when request conversion fails", () =>
    Effect.gen(function* () {
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

      const effectResponse = yield* forward({ request });
      const webResponse = HttpServerResponse.toWeb(effectResponse);

      expect(webResponse.status).toBe(400);
      expect(handler).not.toHaveBeenCalled();
    }),
  );
});
