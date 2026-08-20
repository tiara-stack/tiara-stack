import { describe, expect, it } from "@effect/vitest";
import { makeStatusResponseReferenceInput } from "./status";

describe("status command workflow input", () => {
  it("keeps the provider token in the bot-owned capability record", () => {
    const input = makeStatusResponseReferenceInput({
      applicationId: "application-1",
      clientId: "client-1",
      interactionId: "123456789012345678",
      interactionToken: "provider-token",
    });

    expect(input).toEqual({
      applicationId: "application-1",
      client: { platform: "discord", clientId: "client-1" },
      interactionToken: "provider-token",
      permittedOperations: ["respond"],
      expiresAt: 1449505662216,
    });
  });
});
