import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InternalAdapter } from "better-auth";
import { Effect, Predicate } from "effect";
import { SignJWT } from "jose";
import { describe, expect, it } from "@effect/vitest";
import {
  createJwtSubjectTokenResolver,
  resolveUserByDiscordId,
  sheetOAuthJwksUrl,
  verifyKubernetesServiceAccountToken,
} from ".";
import { requestedTokenExchangeScopes } from "./tokens/token-exchange";

const grantType = "urn:ietf:params:oauth:grant-type:token-exchange";
const accessTokenType = "urn:ietf:params:oauth:token-type:access_token";
const jwtTokenType = "urn:ietf:params:oauth:token-type:jwt";

const signSubjectToken = ({
  secret,
  issuer = "sheet-bot",
  audience = "https://auth.example.com",
  subject = "discord:123",
}: {
  readonly secret: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string;
}) =>
  new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1m")
    .sign(new TextEncoder().encode(secret));

const actor = {
  tokenType: "oauth_access_token",
  userId: "service_user",
  accountId: "service_user",
  clientId: "sheet-bot",
  permissions: ["service"],
  scopes: ["token.exchange", "workflow.dispatch"],
} as const;

const makeTestUser = (id: string) => ({
  id,
  email: `${id}@example.com`,
  emailVerified: true,
  name: `User ${id}`,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const makeDiscordAccount = ({
  id,
  userId,
  providerId,
  accountId = "123",
}: {
  readonly id: string;
  readonly userId: string;
  readonly providerId: "discord" | "kubernetes:discord";
  readonly accountId?: string;
}) => ({
  id,
  userId,
  accountId,
  providerId,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const makeDiscordResolverAdapter = ({
  discordAccount,
  legacyAccount,
  users,
}: {
  readonly discordAccount?: ReturnType<typeof makeDiscordAccount> | undefined;
  readonly legacyAccount?: ReturnType<typeof makeDiscordAccount> | undefined;
  readonly users?: Record<string, ReturnType<typeof makeTestUser>> | undefined;
}) => {
  const createdAccounts: unknown[] = [];
  const createdUsers: unknown[] = [];
  const accountLookups: Array<{ readonly accountId: string; readonly providerId: string }> = [];

  const adapter = {
    findAccountByProviderId: async (accountId: string, providerId: string) => {
      accountLookups.push({ accountId, providerId });
      if (providerId === "discord" && discordAccount?.accountId === accountId) {
        return discordAccount;
      }
      if (providerId === "kubernetes:discord" && legacyAccount?.accountId === accountId) {
        return legacyAccount;
      }
      return null;
    },
    findUserById: async (userId: string) => users?.[userId] ?? null,
    createOAuthUser: async (user: unknown, account: unknown) => {
      const createdUser = {
        id: "created-user",
        ...(Predicate.isObject(user) ? user : {}),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      };
      createdUsers.push(createdUser);
      const accountInput = {
        userId: createdUser.id,
        ...(Predicate.isObject(account) ? account : {}),
      };
      const createdAccount = {
        id: "created-account",
        ...accountInput,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      };
      createdAccounts.push(accountInput);
      return {
        user: createdUser,
        account: createdAccount,
      };
    },
  } as unknown as InternalAdapter;

  return {
    accountLookups,
    adapter,
    createdAccounts,
    createdUsers,
  };
};

describe("sheetOAuthJwksUrl", () => {
  it("uses the configured JWKS URL when provided", () => {
    expect(
      sheetOAuthJwksUrl({
        issuer: "https://auth.example.com",
        jwksUrl: "http://127.0.0.1:3000/jwks",
      }),
    ).toBe("http://127.0.0.1:3000/jwks");
  });

  it("falls back to the issuer JWKS URL", () => {
    expect(sheetOAuthJwksUrl({ issuer: "https://auth.example.com/" })).toBe(
      "https://auth.example.com/jwks",
    );
  });
});

describe("createJwtSubjectTokenResolver", () => {
  it("verifies JWT subject tokens before resolving a subject", async () => {
    const subjectToken = await signSubjectToken({ secret: "secret-1" });
    const resolver = createJwtSubjectTokenResolver({
      secret: "secret-1",
      issuer: "sheet-bot",
      audience: "https://auth.example.com",
      resolveSubject: async ({ subject, payload }) => ({
        userId: `user:${subject}`,
        accountId: subject,
        claims: {
          verifiedIssuer: payload.iss,
        },
      }),
    });

    const subject = await resolver({
      ctx: { context: {} },
      actor,
      subjectToken,
      subjectTokenType: jwtTokenType,
      request: {
        grant_type: grantType,
        subject_token: subjectToken,
        subject_token_type: jwtTokenType,
        actor_token_type: accessTokenType,
      },
    });

    expect(subject).toEqual({
      userId: "user:discord:123",
      accountId: "discord:123",
      claims: {
        verifiedIssuer: "sheet-bot",
      },
    });
  });

  it("rejects JWT subject tokens with the wrong audience", async () => {
    const subjectToken = await signSubjectToken({
      secret: "secret-1",
      audience: "https://other-auth.example.com",
    });
    const resolver = createJwtSubjectTokenResolver({
      secret: "secret-1",
      issuer: "sheet-bot",
      audience: "https://auth.example.com",
      resolveSubject: async () => ({
        userId: "user-1",
      }),
    });

    await expect(
      resolver({
        ctx: { context: {} },
        actor,
        subjectToken,
        subjectTokenType: jwtTokenType,
        request: {
          grant_type: grantType,
          subject_token: subjectToken,
          subject_token_type: jwtTokenType,
          actor_token_type: accessTokenType,
        },
      }),
    ).rejects.toThrow("Invalid subject token");
  });

  it("rejects JWT subject tokens without an expiration", async () => {
    const subjectToken = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("sheet-bot")
      .setAudience("https://auth.example.com")
      .setSubject("discord:123")
      .sign(new TextEncoder().encode("secret-1"));
    const resolver = createJwtSubjectTokenResolver({
      secret: "secret-1",
      issuer: "sheet-bot",
      audience: "https://auth.example.com",
      resolveSubject: async () => ({ userId: "user-1" }),
    });

    await expect(
      resolver({
        ctx: { context: {} },
        actor,
        subjectToken,
        subjectTokenType: jwtTokenType,
        request: {
          grant_type: grantType,
          subject_token: subjectToken,
          subject_token_type: jwtTokenType,
          actor_token_type: accessTokenType,
        },
      }),
    ).rejects.toThrow("Invalid subject token");
  });
});

describe("resolveUserByDiscordId", () => {
  it("reuses an existing Discord provider account", async () => {
    const user = makeTestUser("user-1");
    const { adapter, accountLookups, createdAccounts } = makeDiscordResolverAdapter({
      discordAccount: makeDiscordAccount({
        id: "account-1",
        userId: user.id,
        providerId: "discord",
      }),
      users: {
        [user.id]: user,
      },
    });

    await expect(resolveUserByDiscordId(adapter, "123")).resolves.toEqual(user);
    expect(accountLookups).toEqual([{ accountId: "123", providerId: "discord" }]);
    expect(createdAccounts).toEqual([]);
  });

  it("falls back to an existing legacy Kubernetes Discord account", async () => {
    const user = makeTestUser("legacy-user");
    const { adapter, accountLookups, createdAccounts } = makeDiscordResolverAdapter({
      legacyAccount: makeDiscordAccount({
        id: "legacy-account",
        userId: user.id,
        providerId: "kubernetes:discord",
      }),
      users: {
        [user.id]: user,
      },
    });

    await expect(resolveUserByDiscordId(adapter, "123")).resolves.toEqual(user);
    expect(accountLookups).toEqual([
      { accountId: "123", providerId: "discord" },
      { accountId: "123", providerId: "kubernetes:discord" },
    ]);
    expect(createdAccounts).toEqual([]);
  });

  it("creates new placeholder users with a Discord provider account", async () => {
    const { adapter, createdAccounts, createdUsers } = makeDiscordResolverAdapter({});

    await expect(resolveUserByDiscordId(adapter, "123")).resolves.toMatchObject({
      id: "created-user",
      email: "discord_123@oauth.internal",
      emailVerified: true,
      name: "Discord User 123",
    });
    expect(createdUsers).toHaveLength(1);
    expect(createdAccounts).toEqual([
      {
        userId: "created-user",
        providerId: "discord",
        accountId: "123",
      },
    ]);
  });

  it("retries until a concurrently linked Discord account becomes visible", async () => {
    const user = makeTestUser("concurrent-user");
    const account = makeDiscordAccount({
      id: "concurrent-account",
      userId: user.id,
      providerId: "discord",
    });
    const conflict = Object.assign(new Error("duplicate key"), { code: "23505" });
    let discordAccountLookups = 0;
    const adapter = {
      findAccountByProviderId: async (accountId: string, providerId: string) => {
        if (providerId === "discord") {
          discordAccountLookups += 1;
          if (discordAccountLookups > 2) {
            return account;
          }
        }
        return null;
      },
      findUserById: async (userId: string) => (userId === user.id ? user : null),
      createOAuthUser: async () => {
        throw conflict;
      },
    } as unknown as InternalAdapter;

    await expect(resolveUserByDiscordId(adapter, "123")).resolves.toEqual(user);
    expect(discordAccountLookups).toBe(3);
  });

  it("preserves non-conflict placeholder creation errors", async () => {
    const failure = new Error("database unavailable");
    const adapter = {
      findAccountByProviderId: async () => null,
      createOAuthUser: async () => {
        throw failure;
      },
    } as unknown as InternalAdapter;

    await expect(resolveUserByDiscordId(adapter, "123")).rejects.toBe(failure);
  });
});

describe("requestedTokenExchangeScopes", () => {
  it("constrains explicit scopes by both the actor and subject", () => {
    expect(
      requestedTokenExchangeScopes(
        "workflow.dispatch token.exchange",
        {
          userId: "subject-user",
          scopes: ["workflow.dispatch"],
        },
        actor,
      ),
    ).toEqual(["workflow.dispatch"]);
  });

  it("rejects explicit scopes with no subject overlap", () => {
    expect(() =>
      requestedTokenExchangeScopes(
        "token.exchange",
        { userId: "subject-user", scopes: ["workflow.dispatch"] },
        actor,
      ),
    ).toThrow("No requested scopes are allowed");
  });

  it("rejects fallback scopes with no actor overlap", () => {
    expect(() =>
      requestedTokenExchangeScopes(
        undefined,
        { userId: "subject-user", scopes: ["sheet.read"] },
        actor,
      ),
    ).toThrow("No token exchange scopes are allowed");
  });
});

const withTokenReviewServer = <A>(
  requestListener: RequestListener,
  use: (input: {
    readonly reviewerTokenPath: string;
    readonly tokenReviewUrl: string;
  }) => Promise<A>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const tempDir = yield* Effect.acquireRelease(
        Effect.tryPromise(() => mkdtemp(join(tmpdir(), "sheet-auth-token-review-"))),
        (path) =>
          Effect.tryPromise(() => rm(path, { recursive: true, force: true })).pipe(Effect.orDie),
      );
      const reviewerTokenPath = join(tempDir, "reviewer-token");
      yield* Effect.tryPromise(() => writeFile(reviewerTokenPath, "reviewer-token\n"));

      const server = yield* Effect.acquireRelease(
        Effect.sync(() => createServer(requestListener)),
        (server) =>
          server.listening
            ? Effect.tryPromise(
                () =>
                  new Promise<void>((resolve, reject) =>
                    server.close((error) => (error ? reject(error) : resolve())),
                  ),
              ).pipe(Effect.orDie)
            : Effect.void,
      );
      yield* Effect.tryPromise(
        () =>
          new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => reject(error);
            server.once("error", onError);
            server.listen(0, "127.0.0.1", () => {
              server.off("error", onError);
              resolve();
            });
          }),
      );

      const address = server.address();
      if (!address || Predicate.isString(address)) {
        throw new Error("Expected HTTP server address");
      }

      return yield* Effect.tryPromise(() =>
        use({
          reviewerTokenPath,
          tokenReviewUrl: `http://127.0.0.1:${address.port}/tokenreviews`,
        }),
      );
    }),
  );

describe("verifyKubernetesServiceAccountToken", () => {
  it.live("accepts TokenReview responses for an allowed service account and audience", () => {
    let requestBody: unknown;
    let authorizationHeader: string | undefined;
    return withTokenReviewServer(
      (request, response) => {
        authorizationHeader = request.headers.authorization;
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              status: {
                authenticated: true,
                audiences: ["sheet-auth-subject-token"],
                user: {
                  username: "system:serviceaccount:tiara-prod:sheet-bot",
                },
              },
            }),
          );
        });
      },
      async ({ reviewerTokenPath, tokenReviewUrl }) => {
        const result = await verifyKubernetesServiceAccountToken("caller-token", {
          tokenReviewUrl,
          reviewerTokenPath,
          audience: "sheet-auth-subject-token",
          allowedServiceAccounts: ["tiara-prod/sheet-bot"],
        });

        expect(result.username).toBe("system:serviceaccount:tiara-prod:sheet-bot");
        expect(authorizationHeader).toBe("Bearer reviewer-token");
        expect(requestBody).toMatchObject({
          spec: {
            token: "caller-token",
            audiences: ["sheet-auth-subject-token"],
          },
        });
      },
    );
  });

  it.live("retries transient TokenReview responses", () => {
    let requestCount = 0;
    return withTokenReviewServer(
      (_request, response) => {
        requestCount += 1;
        response.setHeader("content-type", "application/json");
        if (requestCount < 3) {
          response.statusCode = 503;
          response.end(JSON.stringify({ status: undefined }));
          return;
        }
        response.end(
          JSON.stringify({
            status: {
              authenticated: true,
              audiences: ["sheet-auth-subject-token"],
              user: {
                username: "system:serviceaccount:tiara-prod:sheet-bot",
              },
            },
          }),
        );
      },
      async ({ reviewerTokenPath, tokenReviewUrl }) => {
        await expect(
          verifyKubernetesServiceAccountToken("caller-token", {
            tokenReviewUrl,
            reviewerTokenPath,
            audience: "sheet-auth-subject-token",
            allowedServiceAccounts: ["tiara-prod/sheet-bot"],
          }),
        ).resolves.toMatchObject({
          username: "system:serviceaccount:tiara-prod:sheet-bot",
        });
        expect(requestCount).toBe(3);
      },
    );
  });

  it.live("times out unresponsive TokenReview requests", () => {
    let requestCount = 0;
    return withTokenReviewServer(
      (_request, response) => {
        requestCount += 1;
        setTimeout(() => {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ status: undefined }));
        }, 1_500);
      },
      async ({ reviewerTokenPath, tokenReviewUrl }) => {
        await expect(
          verifyKubernetesServiceAccountToken("caller-token", {
            tokenReviewUrl,
            reviewerTokenPath,
            audience: "sheet-auth-subject-token",
            allowedServiceAccounts: ["tiara-prod/sheet-bot"],
          }),
        ).rejects.toThrow("Kubernetes token review unavailable");
        expect(requestCount).toBe(3);
      },
    );
  });

  it.live("rejects TokenReview responses for a different service account", () =>
    withTokenReviewServer(
      (_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            status: {
              authenticated: true,
              audiences: ["sheet-auth-subject-token"],
              user: {
                username: "system:serviceaccount:tiara-prod:other-service",
              },
            },
          }),
        );
      },
      async ({ reviewerTokenPath, tokenReviewUrl }) => {
        await expect(
          verifyKubernetesServiceAccountToken("caller-token", {
            tokenReviewUrl,
            reviewerTokenPath,
            audience: "sheet-auth-subject-token",
            allowedServiceAccounts: ["tiara-prod/sheet-bot"],
          }),
        ).rejects.toThrow("Invalid Kubernetes service account token");
      },
    ),
  );

  it.live("reports malformed TokenReview responses as unavailable", () =>
    withTokenReviewServer(
      (_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status: "invalid" }));
      },
      async ({ reviewerTokenPath, tokenReviewUrl }) => {
        await expect(
          verifyKubernetesServiceAccountToken("caller-token", {
            tokenReviewUrl,
            reviewerTokenPath,
            audience: "sheet-auth-subject-token",
            allowedServiceAccounts: ["tiara-prod/sheet-bot"],
          }),
        ).rejects.toThrow("Kubernetes token review unavailable");
      },
    ),
  );

  it.live("rejects malformed service-account allow-list entries", () =>
    withTokenReviewServer(
      (_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            status: {
              authenticated: true,
              audiences: ["sheet-auth-subject-token"],
              user: {
                username: "system:serviceaccount:tiara-prod:sheet-bot",
              },
            },
          }),
        );
      },
      async ({ reviewerTokenPath, tokenReviewUrl }) => {
        await expect(
          verifyKubernetesServiceAccountToken("caller-token", {
            tokenReviewUrl,
            reviewerTokenPath,
            audience: "sheet-auth-subject-token",
            allowedServiceAccounts: ["tiara-prod/sheet-bot/extra"],
          }),
        ).rejects.toThrow("Invalid Kubernetes service account token");
      },
    ),
  );
});
