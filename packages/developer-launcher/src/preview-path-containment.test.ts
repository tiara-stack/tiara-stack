import { it } from "@effect/vitest";
import path from "node:path";
import { expect } from "vitest";
import { isPreviewPathWithin } from "./preview-path-containment";

it("accepts the same directory and descendants but rejects sibling traversal", () => {
  expect(isPreviewPathWithin("/checkout", "/checkout")).toBe(true);
  expect(isPreviewPathWithin("/checkout", "/checkout/packages/app")).toBe(true);
  expect(isPreviewPathWithin("/checkout", "/checkout-escape/file")).toBe(false);
  expect(isPreviewPathWithin("/checkout", "/other/file")).toBe(false);
});

it("rejects a cross-volume absolute relative path using Win32 path semantics", () => {
  expect(isPreviewPathWithin("C:\\checkout", "D:\\outside\\package", path.win32)).toBe(false);
  expect(isPreviewPathWithin("C:\\checkout", "C:\\checkout\\packages\\app", path.win32)).toBe(true);
});
