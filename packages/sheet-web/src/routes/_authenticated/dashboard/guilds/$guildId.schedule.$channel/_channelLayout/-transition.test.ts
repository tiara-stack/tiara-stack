import { describe, expect, it } from "@effect/vitest";
import { isCalendarInteractionLocked } from "./-transition";

describe("calendar interaction during schedule transitions", () => {
  it("locks only while the calendar is leaving for daily view", () => {
    expect(isCalendarInteractionLocked("to-daily")).toBe(true);
    expect(isCalendarInteractionLocked("to-calendar")).toBe(false);
    expect(isCalendarInteractionLocked(undefined)).toBe(false);
  });
});
