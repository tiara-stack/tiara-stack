import { Effect, Option, Redacted } from "effect";
import { HttpClient, HttpClientResponse, Headers } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import {
  assertPreviewSessionAuthorityConfiguration,
  makeHttpPreviewSessionAuthority,
} from "./preview-session";

describe("preview session authority HTTP client", () => {
  it("rejects partially configured controller authority", () => {
    expect(() => assertPreviewSessionAuthorityConfiguration(false, false)).not.toThrow();
    expect(() => assertPreviewSessionAuthorityConfiguration(true, true)).not.toThrow();
    expect(() => assertPreviewSessionAuthorityConfiguration(true, true, true)).not.toThrow();
    expect(() => assertPreviewSessionAuthorityConfiguration(true, false)).toThrow(
      "must be configured together",
    );
    expect(() => assertPreviewSessionAuthorityConfiguration(false, true)).toThrow(
      "must be configured together",
    );
    expect(() => assertPreviewSessionAuthorityConfiguration(false, false, true)).toThrow(
      "must be configured when token-exchange binding is required",
    );
  });

  it("uses the HTTPS RPC and sends the exact controller binding", async () => {
    const client = HttpClient.make((request) => {
      expect(request.url).toBe("https://preview-controller.dev/_internal/preview/v1/authorize");
      expect(Option.getOrUndefined(Headers.get(request.headers, "authorization"))).toBe(
        "Bearer auth-authority-only-token",
      );
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ authorized: true }), {
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
    });
    const authority = makeHttpPreviewSessionAuthority({
      controllerUrl: "https://preview-controller.dev/base/",
      authorityToken: Redacted.make("auth-authority-only-token"),
      httpClient: client,
    });
    await expect(
      authority.authorize({
        binding: {
          sessionId: "session-a",
          generation: 2,
          role: "sheet-workflows-runner",
        },
        clientId: "runner-client-a",
      }),
    ).resolves.toBe(true);
  });

  it("refuses plaintext controller URLs and fails closed on rejected authority checks", async () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 401 }))),
    );
    expect(() =>
      makeHttpPreviewSessionAuthority({
        controllerUrl: "http://preview-controller.dev",
        authorityToken: Redacted.make("secret"),
        httpClient: client,
      }),
    ).toThrow("HTTPS");
    const authority = makeHttpPreviewSessionAuthority({
      controllerUrl: "https://preview-controller.dev",
      authorityToken: Redacted.make("secret"),
      httpClient: client,
    });
    await expect(
      authority.authorize({
        binding: { sessionId: "session-a", generation: 2, role: "sheet-web" },
        clientId: "web-client-a",
      }),
    ).resolves.toBe(false);
  });

  it("rejects an empty authority credential", () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 401 }))),
    );
    expect(() =>
      makeHttpPreviewSessionAuthority({
        controllerUrl: "https://preview-controller.dev",
        authorityToken: Redacted.make(""),
        httpClient: client,
      }),
    ).toThrow("authority token must be configured");
  });

  it("sends the controller field name when checking whether a binding is required", async () => {
    let observedRequest:
      | {
          readonly url: string;
          readonly authorization: string | undefined;
          readonly body: Record<string, unknown>;
        }
      | undefined;
    const client = HttpClient.make((request) => {
      const body = request.body;
      const bytes = body._tag === "Uint8Array" ? body.body : undefined;
      observedRequest = {
        url: request.url,
        authorization: Option.getOrUndefined(Headers.get(request.headers, "authorization")),
        body:
          bytes instanceof Uint8Array
            ? (JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>)
            : {},
      };
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ required: false }), {
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
    });
    const authority = makeHttpPreviewSessionAuthority({
      controllerUrl: "https://preview-controller.dev",
      authorityToken: Redacted.make("authority-token"),
      httpClient: client,
    });
    await expect(authority.requiresBinding("preview-client-a")).resolves.toBe(false);
    expect(observedRequest).toEqual({
      url: "https://preview-controller.dev/_internal/preview/v1/client-requires-binding",
      authorization: "Bearer authority-token",
      body: { oauthClientId: "preview-client-a" },
    });
  });

  it("allows ordinary clients when the controller says a binding is not required", async () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ required: false }), {
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );
    const authority = makeHttpPreviewSessionAuthority({
      controllerUrl: "https://preview-controller.dev",
      authorityToken: Redacted.make("authority-token"),
      httpClient: client,
    });
    await expect(authority.requiresBinding("ordinary-client-a")).resolves.toBe(false);
  });

  it.live(
    "fails closed when either controller authorization request times out",
    () =>
      Effect.gen(function* () {
        const client = HttpClient.make(() => Effect.never);
        const authority = makeHttpPreviewSessionAuthority({
          controllerUrl: "https://preview-controller.dev",
          authorityToken: Redacted.make("authority-token"),
          httpClient: client,
        });
        const [bindingRequired, authorized] = yield* Effect.promise(() =>
          Promise.all([
            authority.requiresBinding("preview-client-a"),
            authority.authorize({
              binding: { sessionId: "session-a", generation: 1, role: "sheet-web" },
              clientId: "preview-client-a",
            }),
          ]),
        );
        expect(bindingRequired).toBe(true);
        expect(authorized).toBe(false);
      }),
    10_000,
  );
});
