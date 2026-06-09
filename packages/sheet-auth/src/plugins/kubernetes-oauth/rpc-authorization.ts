import { Cache, Clock, Duration, Effect, Exit, Option } from "effect";
import { Headers } from "effect/unstable/http";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { Unauthorized } from "typhoon-core/error";
import { verifyKubernetesToken } from "./index";

const defaultHeaderName = "x-sheet-ingress-auth";

const getString = (value: unknown) => (typeof value === "string" ? value : undefined);
const getNumber = (value: unknown) => (typeof value === "number" ? value : undefined);

const getKubernetesTokenDiagnostics = (
  token: string,
  expectedAudience: string,
  expectedSubject: string,
) => {
  const tokenParts = token.split(".").length;
  const header = (() => {
    try {
      return decodeProtectedHeader(token);
    } catch {
      return undefined;
    }
  })();
  const payload = (() => {
    try {
      return decodeJwt(token);
    } catch {
      return undefined;
    }
  })();

  return {
    expectedAudience,
    expectedSubject,
    tokenParts,
    headerAlg: getString(header?.alg),
    headerKid: getString(header?.kid),
    payloadAud: payload?.aud,
    payloadExp: getNumber(payload?.exp),
    payloadIss: getString(payload?.iss),
    payloadSub: getString(payload?.sub),
  };
};

export interface KubernetesServiceAccountTokenAuthorizerOptions<E = Unauthorized> {
  readonly audience: string;
  readonly expectedNamespace: string;
  readonly expectedServiceAccountName: string;
  readonly headerName?: string;
  readonly makeUnauthorized?: (input: { readonly message: string; readonly cause?: unknown }) => E;
  readonly verifyToken?: typeof verifyKubernetesToken;
  readonly cacheCapacity?: number;
  readonly successfulTokenTtlCap?: Duration.Duration;
  readonly failedTokenTtl?: Duration.Duration;
}

export interface VerifiedKubernetesServiceAccountToken {
  readonly exp: number | undefined;
  readonly sub: string;
}

interface CachedKubernetesServiceAccountToken extends VerifiedKubernetesServiceAccountToken {
  readonly ttl: Duration.Duration;
}

// fallow-ignore-next-line code-duplication
export const getBearerToken = (authorization: string | undefined) => {
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token.length === 0 ? undefined : token;
};

export const makeKubernetesServiceAccountTokenAuthorizer = <E = Unauthorized>(
  options: KubernetesServiceAccountTokenAuthorizerOptions<E>,
) =>
  Effect.gen(function* () {
    const {
      audience,
      expectedNamespace,
      expectedServiceAccountName,
      headerName = defaultHeaderName,
      verifyToken = verifyKubernetesToken,
      cacheCapacity = 100,
      successfulTokenTtlCap = Duration.minutes(5),
      failedTokenTtl = Duration.seconds(1),
    } = options;
    const makeUnauthorized =
      options.makeUnauthorized ??
      (({ message, cause }: { readonly message: string; readonly cause?: unknown }) =>
        new Unauthorized({ message, cause }) as E);
    const expectedSubject = `system:serviceaccount:${expectedNamespace}:${expectedServiceAccountName}`;

    const toCachedVerifiedToken = ({
      exp,
      sub,
    }: {
      readonly exp: number | undefined;
      readonly sub: string;
    }): Effect.Effect<CachedKubernetesServiceAccountToken, E> => {
      if (sub !== expectedSubject) {
        return Effect.fail(
          makeUnauthorized({
            message: `Invalid ingress Kubernetes token subject: ${sub}`,
          }),
        );
      }

      return Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        if (typeof exp === "number") {
          const millisUntilExpiration = exp * 1000 - now;
          if (millisUntilExpiration <= 0) {
            return yield* Effect.fail(
              makeUnauthorized({ message: "Expired ingress Kubernetes token" }),
            );
          }

          const cachedToken: CachedKubernetesServiceAccountToken = {
            exp,
            sub,
            ttl: Duration.min(successfulTokenTtlCap, Duration.millis(millisUntilExpiration)),
          };
          return cachedToken;
        }

        const cachedToken: CachedKubernetesServiceAccountToken = {
          exp,
          sub,
          ttl: successfulTokenTtlCap,
        };
        return cachedToken;
      });
    };

    const requireUnexpiredVerifiedToken = ({ exp }: { readonly exp: number | undefined }) =>
      typeof exp === "number"
        ? Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              now < exp * 1000
                ? Effect.void
                : Effect.fail(makeUnauthorized({ message: "Expired ingress Kubernetes token" })),
            ),
          )
        : Effect.void;

    const tokenCache = yield* Cache.makeWith(
      (token: string) =>
        Effect.tryPromise({
          try: () => verifyToken(token, audience),
          catch: (cause) => cause,
        }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Failed to verify ingress Kubernetes token", {
              cause,
              token: getKubernetesTokenDiagnostics(token, audience, expectedSubject),
            }),
          ),
          Effect.mapError((cause) =>
            makeUnauthorized({ message: "Invalid ingress Kubernetes token", cause }),
          ),
          Effect.flatMap(toCachedVerifiedToken),
        ),
      {
        capacity: cacheCapacity,
        timeToLive: Exit.match({
          onFailure: () => failedTokenTtl,
          onSuccess: ({ ttl }: CachedKubernetesServiceAccountToken) => ttl,
        }),
      },
    );

    const requireAuthorizedBearerToken = Effect.fn(
      "KubernetesServiceAccountTokenAuthorizer.requireAuthorizedBearerToken",
    )(function* (token: string | undefined) {
      if (!token) {
        return yield* Effect.fail(makeUnauthorized({ message: "Missing ingress authorization" }));
      }

      const { ttl: _ttl, ...verifiedToken } = yield* Cache.get(tokenCache, token);
      yield* requireUnexpiredVerifiedToken(verifiedToken);
      return verifiedToken;
    });

    return {
      requireAuthorizedHeaders: Effect.fn(
        "KubernetesServiceAccountTokenAuthorizer.requireAuthorizedHeaders",
      )(function* (headers: Headers.Headers) {
        return yield* requireAuthorizedBearerToken(
          getBearerToken(Option.getOrUndefined(Headers.get(headers, headerName))),
        );
      }),
      requireAuthorizedBearerToken,
    };
  });
