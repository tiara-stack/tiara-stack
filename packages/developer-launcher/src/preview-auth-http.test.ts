import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Cookies, HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { expect } from "vitest";
import { PreviewAuthError, type PreviewAuthApi, type PreviewAuthBinding } from "./preview-auth";
import { PreviewAuthHttpRoutes } from "./preview-auth-http";

it.effect("uses Secure host-only HttpOnly cookies and exact Origin on the browser boundary", () =>
  Effect.gen(function* () {
    const binding: PreviewAuthBinding = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      generation: 1,
      role: "sheet-web",
      endpoint: "https://p-session-sheet-web.dev.example.test",
    };
    let protectedResponseStatus = 200;
    let protectedRequestCalls = 0;
    let requestFailureReason: PreviewAuthError["reason"] | undefined;
    const auth: PreviewAuthApi = {
      configured: true,
      provision: () => Effect.die("unused"),
      start: () =>
        Effect.succeed({
          authorizationUrl: "https://auth.dev.example.test/authorize",
          stateCookie: "one-time-state",
        }),
      callback: () =>
        Effect.succeed({
          credential: "preview-secret",
          principal: {
            userId: "user",
            accountId: "account",
            scopes: ["sheet.read"],
            issuer: "https://auth.dev.example.test",
            audience: "sheet-zero",
            actorProvenance: "client:web",
          },
          returnUrl: `${binding.endpoint}/_preview/app/`,
        }),
      request: () => {
        protectedRequestCalls += 1;
        if (requestFailureReason !== undefined)
          return Effect.fail(new PreviewAuthError({ reason: requestFailureReason }));
        return Effect.succeed({
          status: protectedResponseStatus,
          headers: { "content-type": "text/plain", "set-cookie": "shared=bad" },
          body: "ok",
        });
      },
      cleanupSession: () => Effect.void,
    };
    const callbackPath = "/_preview/auth/complete";
    const routes = PreviewAuthHttpRoutes(
      auth,
      () => Effect.succeed({ binding, returnUrl: `${binding.endpoint}/_preview/app/` }),
      callbackPath,
    ).pipe(Layer.provide(HttpRouter.layer));
    const handler = yield* HttpRouter.toHttpEffect(routes);
    const invokeRequest = (request: Request) =>
      handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request),
        ),
      );
    const invoke = (path: string, headers: Record<string, string> = {}, method = "GET") =>
      invokeRequest(
        new Request(`${binding.endpoint}${path}`, {
          method,
          headers: { host: new URL(binding.endpoint).host, ...headers },
        }),
      );
    const started = yield* invoke("/_preview/auth/start");
    expect(started.status).toBe(302);
    expect(started.headers.location).toBe("https://auth.dev.example.test/authorize");
    const stateCookie = Cookies.toSetCookieHeaders(started.cookies).find((cookie) =>
      cookie.startsWith("__Host-preview-oauth-state="),
    );
    expect(stateCookie).toContain("Secure");
    expect(stateCookie).toContain("HttpOnly");
    expect(stateCookie).toContain("Max-Age=300");
    expect(stateCookie).not.toContain("Domain=");
    const callback = yield* invoke(`${callbackPath}?code=code&state=state`, {
      cookie: "__Host-preview-oauth-state=one-time-state",
    });
    expect(callback.status).toBe(302);
    const previewCookie = Cookies.toSetCookieHeaders(callback.cookies).find((cookie) =>
      cookie.startsWith("__Host-preview-session="),
    );
    expect(previewCookie).toContain("Secure");
    expect(previewCookie).toContain("HttpOnly");
    expect(previewCookie).toContain("Max-Age=900");
    expect(previewCookie).not.toContain("Domain=");
    const malformedStateCookie = yield* invoke(`${callbackPath}?code=code&state=state`, {
      cookie: "__Host-preview-oauth-state=%",
    });
    expect(malformedStateCookie.status).toBe(400);
    const denied = yield* invoke("/_preview/app/zero/query", {
      origin: "https://other.dev.example.test",
      cookie: "__Host-preview-session=preview-secret",
    });
    expect(denied.status).toBe(403);
    const missingMutationOrigin = yield* invoke(
      "/_preview/app/zero/mutate",
      { cookie: "__Host-preview-session=preview-secret" },
      "POST",
    );
    expect(missingMutationOrigin.status).toBe(403);
    const allowed = yield* invoke("/_preview/app/zero/query", {
      origin: binding.endpoint,
      cookie: "__Host-preview-session=preview-secret; sheet_auth.session_token=shared-secret",
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers["set-cookie"]).toBeUndefined();
    expect(allowed.headers["cache-control"]).toBe("no-store");
    const callsBeforeFetchSiteChecks = protectedRequestCalls;
    const crossSiteGet = yield* invoke("/_preview/app/zero/query", {
      cookie: "__Host-preview-session=preview-secret",
      "sec-fetch-site": "cross-site",
    });
    expect(crossSiteGet.status).toBe(403);
    const sameSiteGet = yield* invoke("/_preview/app/zero/query", {
      cookie: "__Host-preview-session=preview-secret",
      "sec-fetch-site": "same-site",
    });
    expect(sameSiteGet.status).toBe(403);
    expect(protectedRequestCalls).toBe(callsBeforeFetchSiteChecks);
    const legacyGet = yield* invoke("/_preview/app/zero/query", {
      cookie: "__Host-preview-session=preview-secret",
    });
    expect(legacyGet.status).toBe(200);
    const sameOriginGet = yield* invoke("/_preview/app/zero/query", {
      cookie: "__Host-preview-session=preview-secret",
      "sec-fetch-site": "same-origin",
    });
    expect(sameOriginGet.status).toBe(200);
    const navigationGet = yield* invoke("/_preview/app/zero/query", {
      cookie: "__Host-preview-session=preview-secret",
      "sec-fetch-site": "none",
    });
    expect(navigationGet.status).toBe(200);
    protectedResponseStatus = 204;
    const noContent = yield* invoke("/_preview/app/zero/query", {
      origin: binding.endpoint,
      cookie: "__Host-preview-session=preview-secret",
    });
    expect(noContent.status).toBe(204);
    expect(noContent.body).toMatchObject({ _tag: "Empty" });
    const requestCount = protectedRequestCalls;
    const chunkedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000));
        controller.enqueue(new Uint8Array(600_000));
        controller.close();
      },
    });
    const oversizedRequest = new Request(`${binding.endpoint}/_preview/app/zero/mutate`, {
      method: "POST",
      headers: {
        host: new URL(binding.endpoint).host,
        origin: binding.endpoint,
        cookie: "__Host-preview-session=preview-secret",
      },
      body: chunkedBody,
      duplex: "half",
    });
    expect(oversizedRequest.headers.get("content-length")).toBeNull();
    const oversizedResponse = yield* invokeRequest(oversizedRequest);
    expect(oversizedResponse.status).toBe(413);
    expect(protectedRequestCalls).toBe(requestCount);
    requestFailureReason = "stale-session";
    const staleSession = yield* invoke("/_preview/app/zero/query", {
      origin: binding.endpoint,
      cookie: "__Host-preview-session=preview-secret",
    });
    expect(staleSession.status).toBe(403);
    requestFailureReason = "invalid-request";
    const invalidRequest = yield* invoke("/_preview/app/zero/query", {
      origin: binding.endpoint,
      cookie: "__Host-preview-session=preview-secret",
    });
    expect(invalidRequest.status).toBe(400);
  }),
);
