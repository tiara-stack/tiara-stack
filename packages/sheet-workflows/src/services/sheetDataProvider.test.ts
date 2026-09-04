import { describe, expect, it } from "@effect/vitest";
import { resolveSchedulePlayerAccountIds } from "./sheetDataProvider";

describe("resolveSchedulePlayerAccountIds", () => {
  it("resolves known schedule names and leaves unknown names unlinked", () => {
    expect(
      resolveSchedulePlayerAccountIds(
        [{ accountId: "account-theerie", name: "Theerie" }],
        ["Theerie", "Missing"],
      ),
    ).toEqual(["account-theerie", null]);
  });

  it("does not guess when duplicate sheet names have different accounts", () => {
    expect(
      resolveSchedulePlayerAccountIds(
        [
          { accountId: "account-one", name: "Shared" },
          { accountId: "account-two", name: "Shared" },
        ],
        ["Shared"],
      ),
    ).toEqual([null]);
  });
});
