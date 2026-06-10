import { Effect, Layer, Option, Redacted } from "effect";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { Headers } from "effect/unstable/http";
import { Unauthorized } from "typhoon-core/error";
import { introspectOAuthAccessToken } from "sheet-auth/client";
import { config } from "@/config";

const getBearerToken = (authorization: string | undefined) => {
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token.length === 0 ? undefined : token;
};

const makeSheetIngressAuthorizer = Effect.gen(function* () {
  const issuer = yield* config.sheetAuthIssuer;
  const introspectionClientId = yield* config.sheetAuthOAuthIntrospectionClientId;
  const introspectionClientSecret = yield* config.sheetAuthOAuthIntrospectionClientSecret;

  const makeUnauthorized = ({
    message,
    cause,
  }: {
    readonly message: string;
    readonly cause?: unknown;
  }) => new Unauthorized({ message, cause });

  const requireAuthorizedHeaders = Effect.fn(
    "DiscordHttpAuthorization.make.requireAuthorizedHeaders",
  )(function* (headers: Headers.Headers) {
    const token = getBearerToken(
      Option.getOrUndefined(Headers.get(headers, "x-sheet-ingress-auth")),
    );
    if (!token) {
      return yield* Effect.fail(makeUnauthorized({ message: "Missing ingress authorization" }));
    }

    if (Option.isNone(introspectionClientId) || Option.isNone(introspectionClientSecret)) {
      return yield* Effect.fail(
        makeUnauthorized({ message: "OAuth introspection credentials are not configured" }),
      );
    }

    const claims = yield* introspectOAuthAccessToken(
      issuer,
      introspectionClientId.value,
      introspectionClientSecret.value,
      Redacted.make(token),
    );

    if (claims.active !== true) {
      return yield* Effect.fail(makeUnauthorized({ message: "OAuth ingress token is not active" }));
    }

    return claims;
  });

  return { requireAuthorizedHeaders };
});

const isHealthProbePath = (pathname: string) => pathname === "/live" || pathname === "/ready";

export const sheetBotHttpAuthorizationLayer = Layer.unwrap(
  Effect.gen(function* () {
    const authorizer = yield* makeSheetIngressAuthorizer;

    return HttpRouter.middleware(
      HttpMiddleware.make((httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (!isHealthProbePath(new URL(request.url, "http://localhost").pathname)) {
            yield* authorizer.requireAuthorizedHeaders(request.headers);
          }
          return yield* httpEffect;
        }).pipe(
          Effect.catchTag("Unauthorized", (error) =>
            Effect.logWarning("Unauthorized sheet-bot HTTP request", error).pipe(
              Effect.flatMap(() =>
                HttpServerResponse.json(
                  { _tag: "Unauthorized", message: "Unauthorized" },
                  { status: 401 },
                ),
              ),
            ),
          ),
        ),
      ),
      { global: true },
    );
  }),
);
