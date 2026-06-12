import { Effect, Layer, Predicate } from "effect";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { makeOAuthResourceTokenAuthorizer } from "sheet-auth/oauth-resource-authorization";
import { config } from "@/config";

const makeSheetIngressAuthorizer = Effect.gen(function* () {
  const audience = yield* config.sheetAuthOAuthAudience;
  const sheetAuthIssuer = yield* config.sheetAuthIssuer;
  return yield* makeOAuthResourceTokenAuthorizer({
    issuer: sheetAuthIssuer,
    audience,
    requiredScopes: ["ingress.forward"],
  });
});

const isHealthProbePath = Predicate.or(
  (pathname: string) => pathname === "/live",
  (pathname: string) => pathname === "/ready",
);

export const isHealthProbeRequest = (request: HttpServerRequest.HttpServerRequest) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  return request.method === "GET" && isHealthProbePath(pathname);
};

export const sheetBotHttpAuthorizationLayer = Layer.unwrap(
  Effect.gen(function* () {
    const authorizer = yield* makeSheetIngressAuthorizer;

    return HttpRouter.middleware(
      HttpMiddleware.make((httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (!isHealthProbeRequest(request)) {
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
