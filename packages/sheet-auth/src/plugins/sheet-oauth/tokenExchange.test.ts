import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InternalAdapter } from "better-auth";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  createJwtSubjectTokenResolver,
  resolveUserByDiscordId,
  sheetOAuthJwksUrl,
  verifyKubernetesServiceAccountToken,
} from ".";

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
    createUser: async (user: unknown) => {
      const createdUser = {
        id: "created-user",
        ...(typeof user === "object" && user !== null ? user : {}),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      };
      createdUsers.push(createdUser);
      return createdUser;
    },
    createAccount: async (account: unknown) => {
      createdAccounts.push(account);
      return {
        id: "created-account",
        ...(typeof account === "object" && account !== null ? account : {}),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
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
      ctx: {},
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
        ctx: {},
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
});

describe("verifyKubernetesServiceAccountToken", () => {
  it("accepts TokenReview responses for an allowed service account and audience", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sheet-auth-token-review-"));
    const reviewerTokenPath = join(tempDir, "reviewer-token");
    await writeFile(reviewerTokenPath, "reviewer-token\n");

    let requestBody: unknown;
    let authorizationHeader: string | undefined;
    const server = createServer((request, response) => {
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
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server address");
    }

    try {
      const result = await verifyKubernetesServiceAccountToken("caller-token", {
        tokenReviewUrl: `http://127.0.0.1:${address.port}/tokenreviews`,
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
    } finally {
      server.close();
    }
  });

  it("rejects TokenReview responses for a different service account", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sheet-auth-token-review-"));
    const reviewerTokenPath = join(tempDir, "reviewer-token");
    await writeFile(reviewerTokenPath, "reviewer-token\n");

    const server = createServer((_request, response) => {
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
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server address");
    }

    try {
      await expect(
        verifyKubernetesServiceAccountToken("caller-token", {
          tokenReviewUrl: `http://127.0.0.1:${address.port}/tokenreviews`,
          reviewerTokenPath,
          audience: "sheet-auth-subject-token",
          allowedServiceAccounts: ["tiara-prod/sheet-bot"],
        }),
      ).rejects.toThrow("Invalid Kubernetes service account token");
    } finally {
      server.close();
    }
  });
});
