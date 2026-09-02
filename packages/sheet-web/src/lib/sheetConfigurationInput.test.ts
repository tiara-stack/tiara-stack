import { describe, expect, it } from "vitest";
import { formatRunnerHours, parseRunnerHoursInput } from "./sheetConfigurationInput";

describe("parseRunnerHoursInput", () => {
  it("accepts comma-separated inclusive intervals", () => {
    expect(parseRunnerHoursInput("8-10, 12 - 14")).toEqual({
      hours: [
        { start: 8, end: 10 },
        { start: 12, end: 14 },
      ],
    });
  });

  it("preserves a partial interval as an error instead of dropping it", () => {
    expect(parseRunnerHoursInput("8-")).toEqual({
      hours: [],
      error: "Use comma-separated intervals like 8-10, 12-14.",
    });
  });

  it("accepts an intentionally empty interval list", () => {
    expect(parseRunnerHoursInput("   ")).toEqual({ hours: [] });
  });

  it("reports reversed intervals", () => {
    expect(parseRunnerHoursInput("12-8")).toEqual({
      hours: [],
      error: "12-8 must end at or after its start.",
    });
  });

  it("reports a trailing comma without discarding completed intervals", () => {
    expect(parseRunnerHoursInput("8-10,")).toEqual({
      hours: [{ start: 8, end: 10 }],
      error: "Finish the last interval, for example 12-14.",
    });
  });

  it("reports an empty interval between commas", () => {
    expect(parseRunnerHoursInput("8-10,,12-14")).toEqual({
      hours: [{ start: 8, end: 10 }],
      error: "Remove the empty interval between commas.",
    });
  });

  it("rejects bounds that cannot be represented safely", () => {
    expect(parseRunnerHoursInput("9007199254740992-9007199254740992")).toEqual({
      hours: [],
      error: "9007199254740992-9007199254740992 must use safe whole-hour numbers.",
    });
  });
});

describe("formatRunnerHours", () => {
  it("formats runner intervals for the editor", () => {
    expect(
      formatRunnerHours([
        { start: 8, end: 10 },
        { start: 12, end: 14 },
      ]),
    ).toBe("8-10, 12-14");
  });
});
