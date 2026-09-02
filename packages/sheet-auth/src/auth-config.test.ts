import { describe, expect, it } from "vitest";
import { oauthAudiences, selectDiscordAccountId } from "./auth-config";

describe("oauthAudiences", () => {
  it("defaults to the issuer and internal resource audiences", () => {
    expect(oauthAudiences("https://auth.example.com", undefined)).toEqual([
      "https://auth.example.com",
      "sheet-workflows",
      "sheet-db-server",
      "sheet-zero",
      "sheet-workflows-http",
      "sheet-bot",
      "sheet-auth",
    ]);
  });

  it("oauthAudiences defaults when configured audiences are empty", () => {
    expect(oauthAudiences("https://auth.example.com", [])).toEqual([
      "https://auth.example.com",
      "sheet-workflows",
      "sheet-db-server",
      "sheet-zero",
      "sheet-workflows-http",
      "sheet-bot",
      "sheet-auth",
    ]);
  });

  it("uses explicitly configured audiences when provided", () => {
    expect(oauthAudiences("https://auth.example.com", ["custom-audience"])).toEqual([
      "custom-audience",
    ]);
  });
});

describe("selectDiscordAccountId", () => {
  it("selects the same account from duplicate rows regardless of database order", () => {
    expect(
      selectDiscordAccountId([
        { accountId: "discord-z", providerId: "discord" },
        { accountId: "discord-a", providerId: "discord" },
      ]),
    ).toBe("discord-a");
    expect(
      selectDiscordAccountId([
        { accountId: "discord-a", providerId: "discord" },
        { accountId: "discord-z", providerId: "discord" },
      ]),
    ).toBe("discord-a");
  });

  it("keeps the preferred provider order when both Discord provider kinds exist", () => {
    expect(
      selectDiscordAccountId([
        { accountId: "kubernetes-discord", providerId: "kubernetes:discord" },
        { accountId: "discord", providerId: "discord" },
      ]),
    ).toBe("discord");
  });

  it("returns undefined when no Discord account exists", () => {
    expect(selectDiscordAccountId([])).toBeUndefined();
    expect(
      selectDiscordAccountId([{ accountId: "google-1", providerId: "google" }]),
    ).toBeUndefined();
  });
});
