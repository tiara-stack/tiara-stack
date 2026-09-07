import { describe, expect, it } from "vitest";
import { DefaultTrustedOAuthClientScopes } from "./oauth";

describe("default trusted OAuth client scopes", () => {
  it("keeps the trusted client scope sets explicit", () => {
    expect(DefaultTrustedOAuthClientScopes).toEqual({
      sheetBot: [
        "service",
        "bot.impersonate",
        "token.exchange",
        "workflow.dispatch",
        "workflow.enqueue",
        "workflow.observe",
        "rollout.gate.evaluate",
      ],
      sheetWorkflows: ["service", "bot.cache.read", "bot.delivery.write", "rollout.gate.write"],
    });
  });
});
