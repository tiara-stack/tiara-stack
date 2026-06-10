import { Effect, Layer, Option, Redacted } from "effect";
import { Headers } from "effect/unstable/http";
import { Unauthorized } from "typhoon-core/error";
import { introspectOAuthAccessToken } from "sheet-auth/client";
import { decodeForwardedSheetAuthUser } from "sheet-ingress-api/middlewares/forwardedAuthHeaders";
import { SheetApisRpcAuthorization } from "sheet-ingress-api/middlewares/sheetApisRpcAuthorization/tag";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { config } from "@/config";

// Some internal calls, such as service/anonymous requests, do not carry a
// user-scoped sheet-auth session token.
const forwardedSessionTokenUnavailable = Redacted.make("SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE");

const getBearerToken = (authorization: string | undefined) => {
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token.length === 0 ? undefined : token;
};

type SheetApisRpcAuthorizationMiddleware = Parameters<typeof SheetApisRpcAuthorization.of>[0];

export const SheetAuthTokenAuthorizationLive = Layer.effect(
  SheetApisRpcAuthorization,
  Effect.gen(function* () {
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
      "SheetAuthTokenAuthorization.make.requireAuthorizedHeaders",
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
        return yield* Effect.fail(
          makeUnauthorized({ message: "OAuth ingress token is not active" }),
        );
      }

      return claims;
    });

    const middleware: SheetApisRpcAuthorizationMiddleware = Effect.fn("SheetApisRpcAuthorization")(
      function* (rpcEffect, options) {
        const headers = options.headers;
        yield* requireAuthorizedHeaders(headers).pipe(
          Effect.mapError((cause) =>
            makeUnauthorized({
              message: "Sheet auth token authorization failed",
              cause,
            }),
          ),
        );

        const user = yield* Effect.suspend(() =>
          decodeForwardedSheetAuthUser(headers, {
            unavailableToken: forwardedSessionTokenUnavailable,
          }),
        ).pipe(
          Effect.mapError((cause) =>
            makeUnauthorized({
              message: "Invalid forwarded sheet-auth headers",
              cause,
            }),
          ),
        );
        const provided = rpcEffect.pipe(Effect.provideService(SheetAuthUser, user));

        return yield* provided;
      },
    );

    return SheetApisRpcAuthorization.of(middleware);
  }),
);
