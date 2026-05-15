import { describe, expect, it } from "vitest";
import { checkSignature, signContent } from "./signature";

describe("signature", () => {
  it("detects valid and modified content", () => {
    const signed = signContent("export const value = 1;\n");
    expect(checkSignature(signed)).toBe("valid");
    expect(checkSignature(signed.replace("1", "2"))).toBe("modified");
    expect(checkSignature("export const value = 1;\n")).toBe("no-signature");
  });

  it("handles edge cases", () => {
    expect(checkSignature("")).toBe("no-signature");
    expect(checkSignature("export const value = 1;")).toBe("no-signature");
    expect(checkSignature(signContent(""))).toBe("valid");
  });
});
