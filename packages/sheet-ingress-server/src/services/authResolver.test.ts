import { describe, expect, it } from "@effect/vitest";
import { sheetAuthOAuthScopeSetFromIterable } from "./authResolver";

describe("auth resolver", () => {
  it("filters public OAuth scopes out of forwarded sheet-auth scopes", () => {
    const scopes = sheetAuthOAuthScopeSetFromIterable([
      "openid",
      "profile",
      "sheet.read",
      "offline_access",
      "workflow.dispatch",
      "service",
    ]);

    expect(Array.from(scopes)).toEqual(["sheet.read", "workflow.dispatch", "service"]);
  });
});
