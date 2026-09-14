import { DateTime, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  ScheduleTimeReference,
  makeChapterStartReference,
  makeEventStartReference,
  normalizeScheduleTimeReference,
  scheduleHourAt,
  scheduleHourInterval,
} from "./scheduleTime";

const eventStart = DateTime.makeUnsafe("2026-09-07T03:00:00.000Z");
const chapterStart = DateTime.makeUnsafe("2026-09-09T03:00:00.000Z");

describe("schedule time", () => {
  it("normalizes an event or chapter reference to the full event start", () => {
    const normalizedEvent = normalizeScheduleTimeReference(makeEventStartReference(eventStart));
    const normalizedChapter = normalizeScheduleTimeReference(
      makeChapterStartReference(chapterStart, 49),
    );

    expect(normalizedEvent.kind).toBe("event-start");
    expect(normalizedEvent.hour).toBe(1);
    expect(DateTime.toEpochMillis(normalizedEvent.instant)).toBe(
      DateTime.toEpochMillis(eventStart),
    );
    expect(normalizedChapter.kind).toBe("event-start");
    expect(normalizedChapter.hour).toBe(1);
    expect(DateTime.toEpochMillis(normalizedChapter.instant)).toBe(
      DateTime.toEpochMillis(eventStart),
    );
  });

  it("calculates adjacent intervals and converts their boundaries back to hours", () => {
    const reference = makeEventStartReference(eventStart);
    const hourOne = scheduleHourInterval(reference, 1);
    const hourTwo = scheduleHourInterval(reference, 2);
    const hourFortyNine = scheduleHourInterval(reference, 49);
    const hourOneNinetyThree = scheduleHourInterval(reference, 193);

    expect(DateTime.toEpochMillis(hourOne.start)).toBe(Date.UTC(2026, 8, 7, 3));
    expect(DateTime.toEpochMillis(hourOne.end)).toBe(DateTime.toEpochMillis(hourTwo.start));
    expect(DateTime.toEpochMillis(hourFortyNine.start)).toBe(Date.UTC(2026, 8, 9, 3));
    expect(DateTime.toEpochMillis(hourOneNinetyThree.start)).toBe(Date.UTC(2026, 8, 15, 3));

    expect(scheduleHourAt(reference, hourOne.start)).toBe(1);
    expect(scheduleHourAt(reference, hourOne.end)).toBe(2);
    expect(scheduleHourAt(reference, hourFortyNine.start)).toBe(49);
    expect(scheduleHourAt(reference, hourOneNinetyThree.start)).toBe(193);
  });

  it("keeps elapsed-hour boundaries when the event starts between civil-clock hours", () => {
    const reference = makeEventStartReference(DateTime.makeUnsafe("2026-09-07T03:37:00.000Z"));
    const hourOne = scheduleHourInterval(reference, 1);
    const hourTwo = scheduleHourInterval(reference, 2);

    expect(DateTime.toEpochMillis(hourOne.end)).toBe(Date.UTC(2026, 8, 7, 4, 37));
    expect(DateTime.toEpochMillis(hourTwo.start)).toBe(Date.UTC(2026, 8, 7, 4, 37));
    expect(scheduleHourAt(reference, DateTime.makeUnsafe("2026-09-07T04:36:59.999Z"))).toBe(1);
    expect(scheduleHourAt(reference, hourTwo.start)).toBe(2);
  });

  it("validates event and chapter references", () => {
    expect(
      Schema.decodeUnknownSync(ScheduleTimeReference)({
        kind: "event-start",
        instant: eventStart,
        hour: 1,
      }),
    ).toEqual(makeEventStartReference(eventStart));
    expect(
      Schema.decodeUnknownSync(ScheduleTimeReference)({
        kind: "chapter-start",
        instant: chapterStart,
        hour: 49,
      }),
    ).toEqual(makeChapterStartReference(chapterStart, 49));
    expect(() =>
      Schema.decodeUnknownSync(ScheduleTimeReference)({
        kind: "event-start",
        instant: eventStart,
        hour: 2,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ScheduleTimeReference)({
        kind: "chapter-start",
        instant: chapterStart,
        hour: 0,
      }),
    ).toThrow();
  });
});
