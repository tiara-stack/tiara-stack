import { Effect, Layer, Redacted } from "effect";
import { makeKubernetesServiceAccountTokenAuthorizer } from "sheet-auth/plugins/kubernetes-oauth/rpc-authorization";
import { decodeForwardedSheetAuthUser } from "sheet-ingress-api/middlewares/forwardedAuthHeaders";
import { SheetApisRpcAuthorization } from "sheet-ingress-api/middlewares/sheetApisRpcAuthorization/tag";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { config } from "@/config";

// Some internal calls, such as service/anonymous requests, do not carry a
// user-scoped sheet-auth session token.
const forwardedSessionTokenUnavailable = Redacted.make("SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE");

type SheetApisRpcAuthorizationMiddleware = Parameters<typeof SheetApisRpcAuthorization.of>[0];

export const SheetAuthTokenAuthorizationLive = Layer.effect(
  SheetApisRpcAuthorization,
  Effect.gen(function* () {
    const podNamespace = yield* config.podNamespace;
    const audience = yield* config.sheetIngressKubernetesAudience;
    const authorizer = yield* makeKubernetesServiceAccountTokenAuthorizer({
      audience,
      expectedNamespace: podNamespace,
      expectedServiceAccountName: "sheet-ingress-server",
    });

    const middleware: SheetApisRpcAuthorizationMiddleware = Effect.fn("SheetApisRpcAuthorization")(
      function* (rpcEffect, options) {
        const headers = options.headers;
        yield* authorizer.requireAuthorizedHeaders(headers);

        const user = yield* Effect.suspend(() =>
          decodeForwardedSheetAuthUser(headers, {
            unavailableToken: forwardedSessionTokenUnavailable,
          }),
        );
        const provided = rpcEffect.pipe(Effect.provideService(SheetAuthUser, user));

        return yield* provided;
      },
    );

    return SheetApisRpcAuthorization.of(middleware);
  }),
);
