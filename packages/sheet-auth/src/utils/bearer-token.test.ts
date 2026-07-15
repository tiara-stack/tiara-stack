import { describe, expect, it } from "vitest";
import { getBearerToken } from "./bearer-token";

describe("getBearerToken", () => {
  it.each(["Bearer token", "bearer token", "BEARER token"])(
    "accepts the authorization scheme case-insensitively: %s",
    (authorization) => {
      expect(getBearerToken(authorization)).toBe("token");
    },
  );

  it("rejects empty bearer credentials", () => {
    expect(getBearerToken("Bearer   ")).toBeUndefined();
  });

  it("rejects a missing authorization header", () => {
    expect(getBearerToken(null)).toBeUndefined();
    expect(getBearerToken(undefined)).toBeUndefined();
  });
});
