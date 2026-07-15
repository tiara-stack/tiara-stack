import { describe, expect, it } from "vitest";
import { TokenExchangeGrantType } from "../../oauth";
import { subjectTokenBody, tokenExchangeBody, trustedDiscordSessionBody } from "./schemas";

describe("trustedDiscordSessionBody", () => {
  it("accepts numeric Discord user IDs", async () => {
    const result = await trustedDiscordSessionBody["~standard"].validate({
      discordUserId: "123456789012345678",
    });

    expect(result.issues).toBeUndefined();
  });

  it.each(["", "not-a-discord-id"])("rejects invalid Discord user ID %j", async (discordUserId) => {
    const result = await trustedDiscordSessionBody["~standard"].validate({ discordUserId });

    expect(result.issues).not.toBeUndefined();
  });
});

describe("subjectTokenBody", () => {
  it("rejects empty subjects", async () => {
    const result = await subjectTokenBody["~standard"].validate({ subject: "" });

    expect(result.issues).not.toBeUndefined();
  });

  it("accepts positive whole-number lifetimes", async () => {
    const result = await subjectTokenBody["~standard"].validate({
      subject: "discord:123",
      expiresIn: 60,
    });

    expect(result.issues).toBeUndefined();
  });

  it.each([0, -1, 1.5, 301])("rejects invalid lifetime %s", async (expiresIn) => {
    const result = await subjectTokenBody["~standard"].validate({
      subject: "discord:123",
      expiresIn,
    });

    expect(result.issues).not.toBeUndefined();
  });
});

describe("tokenExchangeBody", () => {
  const validBody = {
    grant_type: TokenExchangeGrantType,
    subject_token: "subject-token",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  };

  it("accepts required and optional token exchange fields", async () => {
    const result = await tokenExchangeBody["~standard"].validate({
      ...validBody,
      actor_token: "actor-token",
      actor_token_type: "urn:ietf:params:oauth:token-type:access_token",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      audience: "sheet-api",
      resource: "https://sheet.example.test",
      scope: "sheet.read",
    });

    expect(result.issues).toBeUndefined();
  });

  it.each(["grant_type", "subject_token", "subject_token_type"] as const)(
    "rejects a missing %s",
    async (field) => {
      const body: Partial<typeof validBody> = { ...validBody };
      delete body[field];

      const result = await tokenExchangeBody["~standard"].validate(body);

      expect(result.issues).not.toBeUndefined();
    },
  );

  it("rejects an invalid grant type", async () => {
    const result = await tokenExchangeBody["~standard"].validate({
      ...validBody,
      grant_type: "authorization_code",
    });

    expect(result.issues).not.toBeUndefined();
  });
});
