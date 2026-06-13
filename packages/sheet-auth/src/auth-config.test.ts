import { describe, expect, it } from "vitest";
import { oauthAudiences } from "./auth-config";

describe("oauthAudiences", () => {
  it("defaults to the issuer and internal resource audiences", () => {
    expect(oauthAudiences("https://auth.example.com", undefined)).toEqual([
      "https://auth.example.com",
      "sheet-ingress",
      "sheet-apis",
      "sheet-workflows",
      "sheet-bot",
    ]);
  });

  it("oauthAudiences defaults when configured audiences are empty", () => {
    expect(oauthAudiences("https://auth.example.com", [])).toEqual([
      "https://auth.example.com",
      "sheet-ingress",
      "sheet-apis",
      "sheet-workflows",
      "sheet-bot",
    ]);
  });

  it("uses explicitly configured audiences when provided", () => {
    expect(oauthAudiences("https://auth.example.com", ["custom-audience"])).toEqual([
      "custom-audience",
    ]);
  });
});
