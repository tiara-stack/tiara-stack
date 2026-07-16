import { Option } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { Sheet } from "sheet-ingress-api/schemas";
import { classifyDailyHourSchedules, getDailyHourSchedules } from "./-dailyRows";

const makeBreakSchedule = () =>
  new Sheet.PopulatedBreakSchedule({
    channel: "raid",
    day: 1,
    visible: true,
    hour: Option.some(1),
    hourWindow: Option.none(),
  });

const makeSchedule = (fills: readonly Option.Option<Sheet.PopulatedSchedulePlayer>[]) =>
  new Sheet.PopulatedSchedule({
    channel: "raid",
    day: 1,
    visible: true,
    hour: Option.some(1),
    hourWindow: Option.none(),
    fills,
    overfills: [],
    standbys: [],
    runners: [],
    monitor: Option.none(),
  });

const makePlayer = (name: string) =>
  new Sheet.PopulatedSchedulePlayer({
    player: new Sheet.PartialNamePlayer({ name }),
    enc: false,
  });

describe("classifyDailyHourSchedules", () => {
  it("treats missing schedule entries as break", () => {
    expect(classifyDailyHourSchedules([])).toBe("break");
  });

  it("treats explicit break schedules as break", () => {
    expect(classifyDailyHourSchedules([makeBreakSchedule()])).toBe("break");
  });

  it("treats populated schedules with fills as schedule", () => {
    expect(
      classifyDailyHourSchedules([
        makeSchedule([
          Option.some(makePlayer("Alice")),
          Option.none(),
          Option.none(),
          Option.none(),
          Option.none(),
        ]),
      ]),
    ).toBe("schedule");
  });

  it("treats populated schedules without fills as schedule", () => {
    expect(
      classifyDailyHourSchedules([
        makeSchedule([Option.none(), Option.none(), Option.none(), Option.none(), Option.none()]),
      ]),
    ).toBe("schedule");
  });

  it("prefers schedule when break and schedule entries are mixed", () => {
    expect(
      classifyDailyHourSchedules([
        makeBreakSchedule(),
        makeSchedule([Option.none(), Option.none(), Option.none(), Option.none(), Option.none()]),
      ]),
    ).toBe("schedule");
  });
});

describe("getDailyHourSchedules", () => {
  it("returns an empty array for missing schedule entries", () => {
    expect(getDailyHourSchedules([])).toEqual([]);
  });

  it("returns an empty array for break-only hours", () => {
    expect(getDailyHourSchedules([makeBreakSchedule()])).toEqual([]);
  });

  it("returns only populated schedules for a mixed hour", () => {
    const schedule = makeSchedule([
      Option.none(),
      Option.none(),
      Option.none(),
      Option.none(),
      Option.none(),
    ]);

    expect(getDailyHourSchedules([makeBreakSchedule(), schedule])).toEqual([schedule]);
  });
});
