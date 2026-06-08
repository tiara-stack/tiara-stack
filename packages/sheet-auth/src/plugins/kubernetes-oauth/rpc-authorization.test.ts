import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Duration, Effect } from "effect";
import { Headers } from "effect/unstable/http";
import { Unauthorized } from "typhoon-core/error";
import {
  makeKubernetesServiceAccountTokenAuthorizer,
  type KubernetesServiceAccountTokenAuthorizerOptions,
} from "./rpc-authorization";

class TestUnauthorized {
  readonly _tag = "TestUnauthorized";

  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

const futureExp = () => Math.floor(Date.now() / 1000) + 60;
const pastExp = () => Math.floor(Date.now() / 1000) - 60;

const makeHeaders = (headers: Record<string, string>) =>
  Object.entries(headers).reduce(
    (acc, [key, value]) => Headers.set(acc, key, value),
    Headers.empty,
  );

const makeOptions = (
  options: Partial<KubernetesServiceAccountTokenAuthorizerOptions<TestUnauthorized>> = {},
): KubernetesServiceAccountTokenAuthorizerOptions<TestUnauthorized> => ({
  audience: "sheet-apis",
  expectedNamespace: "default",
  expectedServiceAccountName: "sheet-ingress-server",
  makeUnauthorized: ({ message, cause }) => new TestUnauthorized(message, cause),
  verifyToken: vi.fn(async () => ({
    exp: futureExp(),
    sub: "system:serviceaccount:default:sheet-ingress-server",
  })),
  ...options,
});

const runAuthorized = (
  options: Partial<KubernetesServiceAccountTokenAuthorizerOptions<TestUnauthorized>>,
  headers: Headers.Headers,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const authorizer = yield* makeKubernetesServiceAccountTokenAuthorizer(makeOptions(options));
        return yield* authorizer.requireAuthorizedHeaders(headers);
      }),
    ),
  );

const runUnauthorized = (
  options: Partial<KubernetesServiceAccountTokenAuthorizerOptions<TestUnauthorized>>,
  headers: Headers.Headers,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const authorizer = yield* makeKubernetesServiceAccountTokenAuthorizer(makeOptions(options));
        return yield* authorizer.requireAuthorizedHeaders(headers).pipe(Effect.flip);
      }),
    ),
  );

describe("makeKubernetesServiceAccountTokenAuthorizer", () => {
  it("accepts a valid token", async () => {
    const verifyToken = vi.fn(async () => ({
      exp: futureExp(),
      sub: "system:serviceaccount:default:sheet-ingress-server",
    }));

    const verified = await runAuthorized(
      { verifyToken },
      makeHeaders({ "x-sheet-ingress-auth": "Bearer valid-token" }),
    );

    expect(verified.sub).toBe("system:serviceaccount:default:sheet-ingress-server");
    expect(verified).not.toHaveProperty("ttl");
    expect(verifyToken).toHaveBeenCalledWith("valid-token", "sheet-apis");
  });

  it("rejects missing authorization", async () => {
    const unauthorized = await runUnauthorized({}, Headers.empty);

    expect(unauthorized.message).toBe("Missing ingress authorization");
  });

  it("rejects blank bearer token", async () => {
    const unauthorized = await runUnauthorized(
      {},
      makeHeaders({ "x-sheet-ingress-auth": "Bearer   " }),
    );

    expect(unauthorized.message).toBe("Missing ingress authorization");
  });

  it("rejects invalid token and preserves the cause", async () => {
    const cause = new Error("jwks failed");
    const unauthorized = await runUnauthorized(
      {
        verifyToken: vi.fn(async () => {
          throw cause;
        }),
      },
      makeHeaders({ "x-sheet-ingress-auth": "Bearer invalid-token" }),
    );

    expect(unauthorized.message).toBe("Invalid ingress Kubernetes token");
    expect(unauthorized.cause).toBe(cause);
  });

  it("rejects wrong service account subject", async () => {
    const unauthorized = await runUnauthorized(
      {
        verifyToken: vi.fn(async () => ({
          exp: futureExp(),
          sub: "system:serviceaccount:default:sheet-web",
        })),
      },
      makeHeaders({ "x-sheet-ingress-auth": "Bearer wrong-subject-token" }),
    );

    expect(unauthorized.message).toBe(
      "Invalid ingress Kubernetes token subject: system:serviceaccount:default:sheet-web",
    );
  });

  it("rejects expired token", async () => {
    const unauthorized = await runUnauthorized(
      {
        verifyToken: vi.fn(async () => ({
          exp: pastExp(),
          sub: "system:serviceaccount:default:sheet-ingress-server",
        })),
      },
      makeHeaders({ "x-sheet-ingress-auth": "Bearer expired-token" }),
    );

    expect(unauthorized.message).toBe("Expired ingress Kubernetes token");
  });

  it("caches expired token failures for the configured failure ttl", async () => {
    const verifyToken = vi.fn(async () => ({
      exp: pastExp(),
      sub: "system:serviceaccount:default:sheet-ingress-server",
    }));
    const headers = makeHeaders({ "x-sheet-ingress-auth": "Bearer expired-token" });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const authorizer = yield* makeKubernetesServiceAccountTokenAuthorizer(
            makeOptions({
              failedTokenTtl: Duration.minutes(1),
              verifyToken,
            }),
          );

          yield* authorizer.requireAuthorizedHeaders(headers).pipe(Effect.flip);
          yield* authorizer.requireAuthorizedHeaders(headers).pipe(Effect.flip);
        }),
      ),
    );

    expect(verifyToken).toHaveBeenCalledOnce();
  });

  it("caches successful verification", async () => {
    const verifyToken = vi.fn(async () => ({
      exp: futureExp(),
      sub: "system:serviceaccount:default:sheet-ingress-server",
    }));
    const headers = makeHeaders({ "x-sheet-ingress-auth": "Bearer cached-token" });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const authorizer = yield* makeKubernetesServiceAccountTokenAuthorizer(
            makeOptions({ verifyToken }),
          );

          yield* authorizer.requireAuthorizedHeaders(headers);
          yield* authorizer.requireAuthorizedHeaders(headers);
        }),
      ),
    );

    expect(verifyToken).toHaveBeenCalledOnce();
  });

  it("does not cache failures longer than the configured failure ttl", async () => {
    const verifyToken = vi
      .fn()
      .mockRejectedValueOnce(new Error("first failure"))
      .mockResolvedValueOnce({
        exp: futureExp(),
        sub: "system:serviceaccount:default:sheet-ingress-server",
      });
    const headers = makeHeaders({ "x-sheet-ingress-auth": "Bearer retry-token" });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const authorizer = yield* makeKubernetesServiceAccountTokenAuthorizer(
            makeOptions({
              failedTokenTtl: Duration.zero,
              verifyToken,
            }),
          );

          yield* authorizer.requireAuthorizedHeaders(headers).pipe(Effect.flip);
          yield* authorizer.requireAuthorizedHeaders(headers);
        }),
      ),
    );

    expect(verifyToken).toHaveBeenCalledTimes(2);
  });

  it("uses the shared Unauthorized error by default", async () => {
    const cause = new Error("jwks failed");
    const unauthorized = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const authorizer = yield* makeKubernetesServiceAccountTokenAuthorizer({
            audience: "sheet-apis",
            expectedNamespace: "default",
            expectedServiceAccountName: "sheet-ingress-server",
            verifyToken: vi.fn(async () => {
              throw cause;
            }),
          });

          return yield* authorizer
            .requireAuthorizedHeaders(
              makeHeaders({ "x-sheet-ingress-auth": "Bearer invalid-token" }),
            )
            .pipe(Effect.flip);
        }),
      ),
    );

    expect(unauthorized).toBeInstanceOf(Unauthorized);
    expect(unauthorized.message).toBe("Invalid ingress Kubernetes token");
    expect(unauthorized.cause).toBe(cause);
  });
});
