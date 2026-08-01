import { describe, expect, it } from "@effect/vitest";
import { shouldRefreshWorkflowZeroAuth } from "./workflowZeroClient";

describe("workflow Zero OAuth refresh", () => {
  it("refreshes for explicit authentication failures", () => {
    expect(
      shouldRefreshWorkflowZeroAuth({
        name: "needs-auth",
        reason: { type: "query", status: 401 },
      }),
    ).toBe(true);
    expect(
      shouldRefreshWorkflowZeroAuth({
        name: "error",
        reason: "Fetch from API server returned non-OK status 500",
      }),
    ).toBe(true);
  });

  it("does not refresh for unrelated connection states", () => {
    expect(shouldRefreshWorkflowZeroAuth({ name: "error", reason: "Zero cache crashed" })).toBe(
      false,
    );
    expect(shouldRefreshWorkflowZeroAuth({ name: "connected" })).toBe(false);
  });
});
