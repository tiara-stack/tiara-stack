import { Cache, Clock, Duration, Effect, Exit, Option } from "effect";
import { Headers } from "effect/unstable/http";
import type { JWTPayload } from "jose";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { Unauthorized } from "typhoon-core/error";
export { getBearerToken } from "./utils/bearer-token";
import { getBearerToken } from "./utils/bearer-token";

const defaultHeaderName = "x-sheet-ingress-auth";

export interface OAuthResourceTokenAuthorizerOptions<E = Unauthorized> {
  readonly issuer: string;
  readonly audience: string;
  readonly requiredScopes: readonly string[];
  readonly headerName?: string;
  readonly jwksUrl?: string;
  readonly makeUnauthorized?: (input: { readonly message: string; readonly cause?: unknown }) => E;
  readonly cacheCapacity?: number;
  readonly successfulTokenTtlCap?: Duration.Duration;
  readonly failedTokenTtl?: Duration.Duration;
}

export interface VerifiedOAuthResourceToken {
  readonly clientId: string | undefined;
  readonly exp: number | undefined;
  readonly scopes: ReadonlySet<string>;
  readonly sub: string | undefined;
}

interface CachedOAuthResourceToken extends VerifiedOAuthResourceToken {
  readonly ttl: Duration.Duration;
}

const splitScopeSet = (scope: unknown) =>
  new Set(typeof scope === "string" ? scope.split(" ").filter((value) => value.length > 0) : []);

const payloadClientId = (payload: JWTPayload) =>
  typeof payload.azp === "string"
    ? payload.azp
    : typeof payload.client_id === "string"
      ? payload.client_id
      : undefined;

const payloadExpiration = (payload: JWTPayload) =>
  typeof payload.exp === "number" ? payload.exp : undefined;

const tokenTtl = (exp: number | undefined, now: number, successfulTokenTtlCap: Duration.Duration) =>
  typeof exp === "number"
    ? Duration.min(successfulTokenTtlCap, Duration.millis(exp * 1000 - now))
    : successfulTokenTtlCap;

const resourceMetadataMappings = (issuer: string, audience: string) =>
  URL.canParse(audience)
    ? undefined
    : {
        [audience]: `${issuer.replace(/\/$/, "")}/.well-known/oauth-protected-resource/${audience}`,
      };

export const makeOAuthResourceTokenAuthorizer = <E = Unauthorized>(
  options: OAuthResourceTokenAuthorizerOptions<E>,
) =>
  Effect.gen(function* () {
    const {
      issuer,
      audience,
      requiredScopes,
      headerName = defaultHeaderName,
      jwksUrl = `${issuer.replace(/\/$/, "")}/jwks`,
      cacheCapacity = 100,
      successfulTokenTtlCap = Duration.minutes(5),
      failedTokenTtl = Duration.seconds(1),
    } = options;
    const makeUnauthorized =
      options.makeUnauthorized ??
      (({ message, cause }: { readonly message: string; readonly cause?: unknown }) =>
        new Unauthorized({ message, cause }) as E);
    const verifier = oauthProviderResourceClient().getActions().verifyAccessToken;

    const toCachedVerifiedToken = (
      payload: JWTPayload,
    ): Effect.Effect<CachedOAuthResourceToken, E> =>
      Effect.gen(function* () {
        const scopeSet = splitScopeSet(payload.scope);
        const missingScopes = requiredScopes.filter((scope) => !scopeSet.has(scope));
        if (missingScopes.length > 0) {
          return yield* Effect.fail(
            makeUnauthorized({
              message: `Missing OAuth resource token scope: ${missingScopes.join(", ")}`,
            }),
          );
        }

        const now = yield* Clock.currentTimeMillis;
        const exp = payloadExpiration(payload);
        if (typeof exp === "number" && exp * 1000 <= now) {
          return yield* Effect.fail(makeUnauthorized({ message: "Expired OAuth resource token" }));
        }

        return {
          clientId: payloadClientId(payload),
          exp,
          scopes: scopeSet,
          sub: typeof payload.sub === "string" ? payload.sub : undefined,
          ttl: tokenTtl(exp, now, successfulTokenTtlCap),
        };
      });

    const tokenCache = yield* Cache.makeWith(
      (token: string) =>
        Effect.tryPromise({
          try: () =>
            verifier(token, {
              jwksUrl,
              verifyOptions: {
                audience,
                issuer: issuer.replace(/\/$/, ""),
              },
              resourceMetadataMappings: resourceMetadataMappings(issuer, audience),
              scopes: [...requiredScopes],
            }),
          catch: (cause) => cause,
        }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Failed to verify OAuth resource token", {
              audience,
              cause,
              requiredScopes,
            }),
          ),
          Effect.mapError((cause) =>
            makeUnauthorized({ message: "Invalid OAuth resource token", cause }),
          ),
          Effect.flatMap(toCachedVerifiedToken),
        ),
      {
        capacity: cacheCapacity,
        timeToLive: Exit.match({
          onFailure: () => failedTokenTtl,
          onSuccess: ({ ttl }: CachedOAuthResourceToken) => ttl,
        }),
      },
    );

    const requireAuthorizedBearerToken = Effect.fn(
      "OAuthResourceTokenAuthorizer.requireAuthorizedBearerToken",
    )(function* (token: string | undefined) {
      if (!token) {
        return yield* Effect.fail(makeUnauthorized({ message: "Missing ingress authorization" }));
      }

      const { ttl: _ttl, ...verifiedToken } = yield* Cache.get(tokenCache, token);
      return verifiedToken;
    });

    return {
      requireAuthorizedHeaders: Effect.fn("OAuthResourceTokenAuthorizer.requireAuthorizedHeaders")(
        function* (headers: Headers.Headers) {
          return yield* requireAuthorizedBearerToken(
            getBearerToken(Option.getOrUndefined(Headers.get(headers, headerName))),
          );
        },
      ),
      requireAuthorizedBearerToken,
    };
  });
