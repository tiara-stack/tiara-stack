import { describe, expect, it } from "@effect/vitest";
import { selectAutonomousTriggerSelection } from "./autonomousTriggerLayer";

describe("selectAutonomousTriggerSelection", () => {
  it("selects no layer when there are no trigger names", () => {
    expect(selectAutonomousTriggerSelection([])).toBe("none");
  });

  it("selects only the auto-checkin layer when requested", () => {
    expect(selectAutonomousTriggerSelection(["autoCheckin"])).toBe("autoCheckin");
  });

  it("selects only the auto-role-cleanup layer when requested", () => {
    expect(selectAutonomousTriggerSelection(["autoRoleCleanup"])).toBe("autoRoleCleanup");
  });

  it("selects the merged layer when both trigger names are requested", () => {
    expect(selectAutonomousTriggerSelection(["autoCheckin", "autoRoleCleanup"])).toBe("all");
  });
});
