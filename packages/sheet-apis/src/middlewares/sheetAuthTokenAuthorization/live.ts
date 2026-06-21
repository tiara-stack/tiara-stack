// fallow-ignore-file code-duplication
import { Effect, Layer, Redacted } from "effect";
import { makeOAuthResourceTokenAuthorizer } from "sheet-auth/oauth-resource-authorization";
import { requireWorkflowScopePolicy } from "sheet-ingress-api/auth/scopePolicy";
import { decodeForwardedSheetAuthUser } from "sheet-ingress-api/middlewares/forwardedAuthHeaders";
import { SheetApisRpcAuthorization } from "sheet-ingress-api/middlewares/sheetApisRpcAuthorization/tag";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { config } from "@/config";
import { SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE } from "@/services/discordAccessToken";

// Some internal calls, such as service/anonymous requests, do not carry a
// user-scoped sheet-auth session token.
const forwardedSessionTokenUnavailable = Redacted.make(SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE);

type SheetApisRpcAuthorizationMiddleware = Parameters<typeof SheetApisRpcAuthorization.of>[0];

export const SheetAuthTokenAuthorizationLive = Layer.effect(
  SheetApisRpcAuthorization,
  Effect.gen(function* () {
    const audience = yield* config.sheetAuthOAuthAudience;
    const sheetAuthIssuer = yield* config.sheetAuthIssuer;
    const oauthAuthorizer = yield* makeOAuthResourceTokenAuthorizer({
      issuer: sheetAuthIssuer,
      audience,
      requiredScopes: ["ingress.forward"],
    });

    const middleware: SheetApisRpcAuthorizationMiddleware = Effect.fn("SheetApisRpcAuthorization")(
      function* (rpcEffect, options) {
        const headers = options.headers;
        yield* oauthAuthorizer.requireAuthorizedHeaders(headers);

        const user = yield* Effect.suspend(() =>
          decodeForwardedSheetAuthUser(headers, {
            unavailableToken: forwardedSessionTokenUnavailable,
          }),
        );
        yield* requireWorkflowScopePolicy(options.rpc, user, {
          missingRpcTagMessage: "Missing sheet API RPC tag",
          fallbackLogMessage: "Using fallback sheet API RPC tag source",
        });
        const provided = rpcEffect.pipe(Effect.provideService(SheetAuthUser, user));

        return yield* provided;
      },
    );

    return SheetApisRpcAuthorization.of(middleware);
  }),
);
