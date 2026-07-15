import { describe, expect, it } from "vitest";
import { allowedOriginMatchers } from "./cors";

const isAllowedBy = (allowedOrigins: ReadonlyArray<string>, origin: string) =>
  allowedOriginMatchers(allowedOrigins).some((matches) => matches(origin));

describe("allowedOriginMatchers", () => {
  it("matches exact origins only", () => {
    const allowedOrigins = ["https://example.com"];

    expect(isAllowedBy(allowedOrigins, "https://example.com")).toBe(true);
    expect(isAllowedBy(allowedOrigins, "https://www.example.com")).toBe(false);
    expect(isAllowedBy(allowedOrigins, "http://example.com")).toBe(false);
  });

  it("matches a wildcard within one hostname segment", () => {
    const allowedOrigins = ["https://*.example.com"];

    expect(isAllowedBy(allowedOrigins, "https://a.example.com")).toBe(true);
    expect(isAllowedBy(allowedOrigins, "https://a.b.example.com")).toBe(false);
    expect(isAllowedBy(allowedOrigins, "https://evilexample.com")).toBe(false);
    expect(isAllowedBy(allowedOrigins, "https://example.com")).toBe(false);
  });
});
