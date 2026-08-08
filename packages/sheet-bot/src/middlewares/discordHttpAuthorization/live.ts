import { Effect, Layer, Match, Predicate } from "effect";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { makeOAuthResourceTokenAuthorizer } from "sheet-auth/oauth-resource-authorization";
import type { VerifiedOAuthResourceToken } from "sheet-auth/oauth-resource-authorization";
import { effectivePrincipalFromVerifiedOAuthClaims } from "sheet-auth/identity/server";
import { BotAdmissionDenied, BotUnauthenticated } from "sheet-bot-api/errors";
import { config } from "@/config";

const makeSheetBotAuthorizer = Effect.gen(function* () {
  const audience = yield* config.sheetAuthOAuthAudience;
  const sheetAuthIssuer = yield* config.sheetAuthIssuer;
  return yield* makeOAuthResourceTokenAuthorizer({
    issuer: sheetAuthIssuer,
    audience,
    requiredScopes: [],
    headerName: "authorization",
    makeUnauthorized: ({ message }) => new BotUnauthenticated({ message }),
  });
});

export type SheetBotAdmission = "legacy" | "cache" | "delivery" | "denied";

export const sheetBotAdmissionForPath = (pathname: string): SheetBotAdmission => {
  let decodedPath: string;
  try {
    decodedPath = decodeURI(pathname);
  } catch {
    return pathname.startsWith("/internal/bot/") ? "denied" : "legacy";
  }

  if (decodedPath.startsWith("/internal/bot/clients/")) return "cache";
  if (decodedPath.startsWith("/internal/bot/delivery/")) return "delivery";
  if (decodedPath.startsWith("/internal/bot/")) return "denied";
  return "legacy";
};

const requiredScope = {
  legacy: "ingress.forward",
  cache: "bot.cache.read",
  delivery: "bot.delivery.write",
} as const satisfies Readonly<Record<Exclude<SheetBotAdmission, "denied">, string>>;

const isServicePrincipal = (token: VerifiedOAuthResourceToken) => {
  try {
    return effectivePrincipalFromVerifiedOAuthClaims(token).kind === "service";
  } catch {
    return false;
  }
};

export const authorizeSheetBotAdmission = (
  admission: SheetBotAdmission,
  token: VerifiedOAuthResourceToken,
) =>
  Effect.gen(function* () {
    if (admission === "denied") {
      return yield* new BotAdmissionDenied({ message: "Unsupported internal sheet-bot route" });
    }

    const scope = requiredScope[admission];
    if (!token.scopes.has(scope)) {
      return yield* new BotAdmissionDenied({
        message: `Missing sheet-bot capability scope: ${scope}`,
      });
    }

    if (admission !== "legacy" && !isServicePrincipal(token)) {
      return yield* new BotAdmissionDenied({
        message: "Sheet-bot capability routes require a Service Principal",
      });
    }
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
    const authorizer = yield* makeSheetBotAuthorizer;

    return HttpRouter.middleware(
      HttpMiddleware.make((httpEffect) =>
        Effect.gen(function* () {
          const authorization = Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (!isHealthProbeRequest(request)) {
              const pathname = new URL(request.url, "http://localhost").pathname;
              const token = yield* authorizer.requireAuthorizedHeaders(request.headers);
              yield* authorizeSheetBotAdmission(sheetBotAdmissionForPath(pathname), token);
            }
          });

          return yield* Effect.matchEffect(authorization, {
            onFailure: (error) => {
              const response = Match.value(error).pipe(
                Match.tagsExhaustive({
                  BotUnauthenticated: () => ({
                    logMessage: "Unauthenticated sheet-bot HTTP request",
                    status: 401,
                  }),
                  BotAdmissionDenied: () => ({
                    logMessage: "Denied sheet-bot HTTP request",
                    status: 403,
                  }),
                }),
              );
              return Effect.logWarning(response.logMessage, error).pipe(
                Effect.flatMap(() =>
                  HttpServerResponse.json(
                    { _tag: error._tag, message: error.message },
                    { status: response.status },
                  ),
                ),
              );
            },
            onSuccess: () => httpEffect,
          });
        }),
      ),
      { global: true },
    );
  }),
);
