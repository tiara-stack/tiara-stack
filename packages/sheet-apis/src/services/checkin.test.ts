import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { ScheduleConfig } from "sheet-ingress-api/schemas/sheetConfig";
import { getScheduleFillCount, hasCompleteScheduleConfigForChannel } from "./checkin";
import { makePartialFill, makeResolvedFill, makeSchedule } from "./testHelpers";

const makeScheduleConfig = (
  overrides: Partial<ConstructorParameters<typeof ScheduleConfig>[0]> = {},
) =>
  new ScheduleConfig({
    channel: Option.some("main"),
    day: Option.some(1),
    sheet: Option.some("Day 1"),
    hourRange: Option.some("A1:A5"),
    breakRange: Option.some("B1:B5"),
    monitorRange: Option.none(),
    encType: Option.some("none"),
    fillRange: Option.some("C1:G5"),
    overfillRange: Option.some("H1:H5"),
    standbyRange: Option.some("I1:I5"),
    screenshotRange: Option.none(),
    noteRange: Option.none(),
    visibleCell: Option.some("J1"),
    draft: Option.none(),
    ...overrides,
  });

describe("getScheduleFillCount", () => {
  it("counts all standard fills in the target hour", () => {
    const schedule = makeSchedule([
      makeResolvedFill("1", "Alice"),
      makeResolvedFill("2", "Bob"),
      makeResolvedFill("3", "Carol"),
      makeResolvedFill("4", "Dave"),
      makeResolvedFill("5", "Eve"),
    ]);

    expect(getScheduleFillCount(Option.some(schedule))).toBe(5);
  });

  it("counts both resolved and partial-name fills toward the threshold", () => {
    const schedule = makeSchedule([
      makeResolvedFill("1", "Alice"),
      makeResolvedFill("2", "Bob"),
      makePartialFill("Carol"),
      makePartialFill("Dave"),
    ]);

    expect(getScheduleFillCount(Option.some(schedule))).toBe(4);
  });
});

describe("hasCompleteScheduleConfigForChannel", () => {
  it("matches a complete config for the requested channel", () => {
    expect(hasCompleteScheduleConfigForChannel([makeScheduleConfig()], "main")).toBe(true);
  });

  it("does not match when the requested channel is missing from sheet config", () => {
    expect(hasCompleteScheduleConfigForChannel([makeScheduleConfig()], "spam")).toBe(false);
  });

  it("does not match incomplete configs for the requested channel", () => {
    expect(
      hasCompleteScheduleConfigForChannel(
        [
          makeScheduleConfig({
            channel: Option.some("spam"),
            fillRange: Option.none(),
          }),
        ],
        "spam",
      ),
    ).toBe(false);
  });

  it("matches when any config for the requested channel is complete", () => {
    expect(
      hasCompleteScheduleConfigForChannel(
        [
          makeScheduleConfig({
            channel: Option.some("spam"),
            fillRange: Option.none(),
          }),
          makeScheduleConfig({
            channel: Option.some("spam"),
          }),
        ],
        "spam",
      ),
    ).toBe(true);
  });

  it("matches channel names with leading and trailing whitespace", () => {
    expect(hasCompleteScheduleConfigForChannel([makeScheduleConfig()], " main ")).toBe(true);
  });
});
