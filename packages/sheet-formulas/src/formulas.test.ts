import { describe, expect, it } from "@effect/vitest";
import { TZLONGSTAMPS, TZSHORTSTAMPS } from "./formulas";

describe("legacy schedule timestamp formulas", () => {
  it("uses the event-start reference even for a later-only hour", () => {
    const eventStartSeconds = Date.UTC(2026, 9, 29, 0) / 1_000;
    const timeZones = [["America/New_York"]];
    const hours = [[1], [82]];

    expect(TZSHORTSTAMPS(eventStartSeconds, timeZones, hours)).toEqual([["20:00"], ["04:00"]]);
    expect(TZLONGSTAMPS(eventStartSeconds, timeZones, hours)).toEqual([
      ["20:00 - 21:00"],
      ["04:00 - 05:00"],
    ]);
  });
});
