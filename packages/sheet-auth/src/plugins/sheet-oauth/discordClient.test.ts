import { describe, expect, it, vi } from "vitest";
import { maybeRefreshDiscordAccessToken, refreshDiscordAccessToken } from "./clients/discord";

const oauthTokenMocks = vi.hoisted(() => ({
  decryptOAuthToken: vi.fn(async (token: string) => token),
  setTokenUtil: vi.fn(async (token: string | undefined) => token),
}));

vi.mock("better-auth/oauth2", () => oauthTokenMocks);

const account = {
  id: "account-1",
  userId: "user-1",
  accountId: "123",
  providerId: "discord",
  accessToken: "old-access-token",
  accessTokenExpiresAt: new Date("2026-01-02T00:00:00.000Z"),
  refreshToken: "old-refresh-token",
  refreshTokenExpiresAt: new Date("2026-02-01T00:00:00.000Z"),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("refreshDiscordAccessToken", () => {
  it("maps provider refresh failures to a login-required error", async () => {
    const ctx = {
      context: {
        socialProviders: [
          {
            id: "discord",
            refreshAccessToken: vi.fn().mockRejectedValue(new Error("invalid_grant")),
          },
        ],
        internalAdapter: { updateAccount: vi.fn() },
      },
    };

    await expect(refreshDiscordAccessToken(ctx, account)).rejects.toThrow("Discord login required");
  });

  it("maps invalid provider refresh responses to a login-required error", async () => {
    const ctx = {
      context: {
        socialProviders: [
          {
            id: "discord",
            refreshAccessToken: vi.fn().mockResolvedValue({ refreshToken: "replacement" }),
          },
        ],
        internalAdapter: { updateAccount: vi.fn() },
      },
    };

    await expect(refreshDiscordAccessToken(ctx, account)).rejects.toThrow("Discord login required");
  });

  it("preserves stored refresh credentials when Discord omits replacements", async () => {
    const updateAccount = vi.fn();
    const ctx = {
      context: {
        socialProviders: [
          {
            id: "discord",
            refreshAccessToken: vi.fn().mockResolvedValue({
              accessToken: "new-access-token",
            }),
          },
        ],
        internalAdapter: { updateAccount },
      },
    };

    await expect(refreshDiscordAccessToken(ctx, account)).resolves.toBe("new-access-token");
    const updatedData = updateAccount.mock.calls[0]?.[1];
    expect(updatedData).toEqual(
      expect.objectContaining({
        accessTokenExpiresAt: expect.any(Date),
        refreshToken: "old-refresh-token",
        refreshTokenExpiresAt: account.refreshTokenExpiresAt,
      }),
    );
    expect(updatedData.accessTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("maybeRefreshDiscordAccessToken", () => {
  it("refreshes access tokens with an unknown expiry", async () => {
    const refreshAccessToken = vi.fn().mockResolvedValue({ accessToken: "new-access-token" });
    let latestAccount: Omit<typeof account, "accessTokenExpiresAt"> & {
      accessTokenExpiresAt: Date | undefined;
    } = {
      ...account,
      accessTokenExpiresAt: undefined,
    };
    const updateAccount = vi.fn(
      async (_accountId: string, updatedData: Partial<typeof latestAccount>) => {
        latestAccount = { ...latestAccount, ...updatedData };
      },
    );
    const ctx = {
      context: {
        socialProviders: [{ id: "discord", refreshAccessToken }],
        internalAdapter: {
          findAccounts: vi.fn(async () => [latestAccount]),
          updateAccount,
        },
      },
    };

    await expect(maybeRefreshDiscordAccessToken(ctx, latestAccount)).resolves.toBe(
      "new-access-token",
    );
    await expect(
      maybeRefreshDiscordAccessToken(ctx, { ...account, accessTokenExpiresAt: undefined }),
    ).resolves.toBe("new-access-token");
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(updateAccount).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent refreshes for the same account", async () => {
    const refreshAccessToken = vi.fn().mockResolvedValue({ accessToken: "new-access-token" });
    const expiredAccount = {
      ...account,
      accessTokenExpiresAt: new Date(0),
    };
    const ctx = {
      context: {
        socialProviders: [{ id: "discord", refreshAccessToken }],
        internalAdapter: {
          findAccounts: vi.fn().mockResolvedValue([expiredAccount]),
          updateAccount: vi.fn(),
        },
      },
    };

    await expect(
      Promise.all([
        maybeRefreshDiscordAccessToken(ctx, expiredAccount),
        maybeRefreshDiscordAccessToken(ctx, expiredAccount),
      ]),
    ).resolves.toEqual(["new-access-token", "new-access-token"]);
    expect(refreshAccessToken).toHaveBeenCalledOnce();
  });
});
