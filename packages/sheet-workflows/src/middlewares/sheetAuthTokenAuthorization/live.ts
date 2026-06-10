// fallow-ignore-next-line code-duplication
import { Effect, Layer, Redacted } from "effect";
import { Unauthorized } from "typhoon-core/error";
import { createRequireAuthorizedHeaders } from "sheet-auth/client";
import { decodeForwardedSheetAuthUser } from "sheet-ingress-api/middlewares/forwardedAuthHeaders";
import { SheetApisRpcAuthorization } from "sheet-ingress-api/middlewares/sheetApisRpcAuthorization/tag";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { config } from "@/config";

// Some internal calls, such as service/anonymous requests, do not carry a
// user-scoped sheet-auth session token.
// fallow-ignore-next-line code-duplication
const forwardedSessionTokenUnavailable = Redacted.make("SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE");

type SheetApisRpcAuthorizationMiddleware = Parameters<typeof SheetApisRpcAuthorization.of>[0];

export const SheetAuthTokenAuthorizationLive = Layer.effect(
  SheetApisRpcAuthorization,
  // fallow-ignore-next-line code-duplication
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

    const requireAuthorizedHeaders = createRequireAuthorizedHeaders({
      issuer,
      introspectionClientId,
      introspectionClientSecret,
      makeUnauthorized,
    });

    const middleware: SheetApisRpcAuthorizationMiddleware = Effect.fn("SheetApisRpcAuthorization")(
      function* (rpcEffect, options) {
        const headers = options.headers;
        yield* requireAuthorizedHeaders(headers);

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
