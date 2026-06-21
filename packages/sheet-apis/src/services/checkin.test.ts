import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { ScheduleConfig } from "sheet-ingress-api/schemas/sheetConfig";
import {
  getScheduleFillCount,
  hasCompleteScheduleConfigForChannel,
  makeMonitorCheckinMessage,
} from "./checkin";
import { makePartialFill, makeResolvedFill, makeSchedule } from "./testHelpers";

const text = (value: string) => ({ type: "text" as const, text: value });
const userMention = (userId: string) => ({ type: "userMention" as const, userId });

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

describe("makeMonitorCheckinMessage", () => {
  it("shows the new no-change copy and empty slots for a partially filled row", () => {
    expect(
      makeMonitorCheckinMessage({
        initialMessage: null,
        empty: 2,
        emptySlotMessage: [text("+2 empty slots")],
        playerChangesMessage: [
          text("Out: None\nStay: "),
          userMention("1"),
          text(" "),
          userMention("2"),
          text("\nIn: "),
          userMention("3"),
        ],
        lookupFailedMessage: Option.none(),
      }),
    ).toEqual([
      text("No check-in message sent, no new players to check in"),
      text("\n"),
      text("+2 empty slots"),
    ]);
  });

  it("uses singular empty slot wording in the no-change branch", () => {
    expect(
      makeMonitorCheckinMessage({
        initialMessage: null,
        empty: 1,
        emptySlotMessage: [text("+1 empty slot")],
        playerChangesMessage: [
          text("Out: None\nStay: "),
          userMention("1"),
          text(" "),
          userMention("2"),
          text(" "),
          userMention("3"),
          text("\nIn: "),
          userMention("4"),
        ],
        lookupFailedMessage: Option.none(),
      }),
    ).toEqual([
      text("No check-in message sent, no new players to check in"),
      text("\n"),
      text("+1 empty slot"),
    ]);
  });

  it("omits empty slots in the no-change branch when the row is full", () => {
    expect(
      makeMonitorCheckinMessage({
        initialMessage: null,
        empty: 0,
        emptySlotMessage: [text("No empty slots")],
        playerChangesMessage: [
          text("Out: None\nStay: "),
          userMention("1"),
          text(" "),
          userMention("2"),
          text(" "),
          userMention("3"),
          text(" "),
          userMention("4"),
          text("\nIn: "),
          userMention("5"),
        ],
        lookupFailedMessage: Option.none(),
      }),
    ).toEqual([text("No check-in message sent, no new players to check in")]);
  });

  it("omits empty slots in the no-change branch for the fully empty fallback case", () => {
    expect(
      makeMonitorCheckinMessage({
        initialMessage: null,
        empty: 5,
        emptySlotMessage: [text("+5 empty slots")],
        playerChangesMessage: [text("Out: None\nStay: None\nIn: None")],
        lookupFailedMessage: Option.none(),
      }),
    ).toEqual([text("No check-in message sent, no new players to check in")]);
  });

  it("keeps the sent-message branch unchanged", () => {
    expect(
      makeMonitorCheckinMessage({
        initialMessage: [text("hello")],
        empty: 2,
        emptySlotMessage: [text("+2 empty slots")],
        playerChangesMessage: [
          text("Out: "),
          userMention("1"),
          text("\nStay: "),
          userMention("2"),
          text("\nIn: "),
          userMention("3"),
        ],
        lookupFailedMessage: Option.some("Cannot look up Discord ID for Alice."),
      }),
    ).toEqual([
      text("Check-in message sent!"),
      text("\n"),
      text("+2 empty slots"),
      text("\n"),
      text("Out: "),
      userMention("1"),
      text("\nStay: "),
      userMention("2"),
      text("\nIn: "),
      userMention("3"),
      text("\n"),
      text("Cannot look up Discord ID for Alice."),
    ]);
  });

  it("renders empty movement buckets as None when they have no players", () => {
    expect(
      makeMonitorCheckinMessage({
        initialMessage: [text("hello")],
        empty: 2,
        emptySlotMessage: [text("+2 empty slots")],
        playerChangesMessage: [
          text("Out: None\nStay: "),
          userMention("1"),
          text(" "),
          userMention("2"),
          text("\nIn: None"),
        ],
        lookupFailedMessage: Option.none(),
      }),
    ).toEqual([
      text("Check-in message sent!"),
      text("\n"),
      text("+2 empty slots"),
      text("\n"),
      text("Out: None\nStay: "),
      userMention("1"),
      text(" "),
      userMention("2"),
      text("\nIn: None"),
    ]);
  });
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
