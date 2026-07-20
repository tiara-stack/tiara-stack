import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime, Metric, Option, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";
import {
  authorizationCodeRequestBody,
  handleOAuthRefreshError,
  isExpectedOAuthFailure,
  isJwtAccessToken,
  oauthRefreshErrorMetric,
  oauthTokenRequestMetric,
  refreshTokenRequestBody,
  runOAuthTokenRequest,
  SheetWebOAuthCompletionInput,
} from "./oauth";

const counterValue = (metric: Metric.Counter<number>) =>
  Metric.value(metric).pipe(Effect.map((state) => state.count));

const startOAuthServer = (handler: RequestListener) =>
  new Promise<{ readonly authBaseUrl: URL; readonly close: () => Promise<void> }>(
    (resolve, reject) => {
      const server = createServer(handler);
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          authBaseUrl: new URL(`http://127.0.0.1:${port}`),
          close: () =>
            new Promise<void>((resolveClose, rejectClose) => {
              server.close((error) => (error ? rejectClose(error) : resolveClose()));
            }),
        });
      });
    },
  );

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

describe("OAuth boundary validation", () => {
  it("rejects malformed completion input", () => {
    expect(() =>
      Schema.decodeUnknownSync(SheetWebOAuthCompletionInput)({ code: 42, state: "state" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SheetWebOAuthCompletionInput)({ code: "", state: "state" }),
    ).toThrow();
  });
});

describe("OAuth token request observability", () => {
  it.live("times out the Effect HTTP client and emits the timeout metric", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const timeoutMetric = oauthTokenRequestMetric("authorization_code", "timeout");
        const before = yield* counterValue(timeoutMetric);
        const runtime = yield* Effect.acquireRelease(
          Effect.sync(() =>
            ManagedRuntime.make(
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.never),
              ),
            ),
          ),
          (runtime) => runtime.disposeEffect,
        );

        const error = yield* Effect.tryPromise({
          try: () =>
            runOAuthTokenRequest(
              "authorization_code",
              new URL("https://auth.example.com"),
              new URLSearchParams(),
              "1 millis",
              runtime,
            ),
          catch: (error) => error,
        }).pipe(Effect.flip);

        expect(isExpectedOAuthFailure(error)).toBe(true);
        expect(yield* counterValue(timeoutMetric)).toBe(before + 1);
      }),
    ),
  );

  it.live("surfaces refresh authorization errors from the Promise boundary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startOAuthServer((_request, response) => {
              response.writeHead(401).end();
            }),
          ),
          ({ close }) => Effect.promise(close),
        );
        const refreshErrorMetric = oauthRefreshErrorMetric("authorization");
        const requestFailureMetric = oauthTokenRequestMetric("refresh", "failure");
        const refreshErrorBefore = yield* counterValue(refreshErrorMetric);
        const requestFailureBefore = yield* counterValue(requestFailureMetric);
        let cookieCleared = false;

        const error = yield* Effect.tryPromise({
          try: () => runOAuthTokenRequest("refresh", server.authBaseUrl, new URLSearchParams()),
          catch: (error) => error,
        }).pipe(Effect.flip);
        expect(isExpectedOAuthFailure(error)).toBe(true);

        const result = yield* Effect.promise(() =>
          handleOAuthRefreshError(error, async () => {
            cookieCleared = true;
          }),
        );

        expect(Option.isNone(result)).toBe(true);
        expect(cookieCleared).toBe(true);
        expect(yield* counterValue(requestFailureMetric)).toBe(requestFailureBefore + 1);
        expect(yield* counterValue(refreshErrorMetric)).toBe(refreshErrorBefore + 1);
      }),
    ),
  );

  it.effect("classifies missing refresh tokens", () =>
    Effect.gen(function* () {
      const missingTokenMetric = oauthRefreshErrorMetric("missing_refresh_token");
      const missingTokenBefore = yield* counterValue(missingTokenMetric);

      yield* Effect.promise(() =>
        handleOAuthRefreshError({ _tag: "OAuthMissingRefreshTokenError" }, async () => {}),
      );

      expect(yield* counterValue(missingTokenMetric)).toBe(missingTokenBefore + 1);
    }),
  );

  it.live("classifies invalid responses from the Promise boundary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startOAuthServer((_request, response) => {
              response.setHeader("content-type", "application/json");
              response.end("{}");
            }),
          ),
          ({ close }) => Effect.promise(close),
        );
        const invalidResponseMetric = oauthRefreshErrorMetric("invalid_response");
        const requestFailureMetric = oauthTokenRequestMetric("refresh", "failure");
        const invalidResponseBefore = yield* counterValue(invalidResponseMetric);
        const requestFailureBefore = yield* counterValue(requestFailureMetric);
        let cookieCleared = false;

        const error = yield* Effect.tryPromise({
          try: () => runOAuthTokenRequest("refresh", server.authBaseUrl, new URLSearchParams()),
          catch: (error) => error,
        }).pipe(Effect.flip);
        expect(isExpectedOAuthFailure(error)).toBe(true);

        yield* Effect.promise(() =>
          handleOAuthRefreshError(error, async () => {
            cookieCleared = true;
          }),
        );

        expect(cookieCleared).toBe(false);
        expect(yield* counterValue(requestFailureMetric)).toBe(requestFailureBefore + 1);
        expect(yield* counterValue(invalidResponseMetric)).toBe(invalidResponseBefore + 1);
      }),
    ),
  );
});
