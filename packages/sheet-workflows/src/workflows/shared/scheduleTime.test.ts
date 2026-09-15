import { DateTime } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { makeChapterStartReference, makeEventStartReference } from "sheet-domain";
import {
  scheduleHourForInstant,
  scheduleHourWindowFor,
  scheduleTimeReferenceFor,
} from "./scheduleTime";

const eventStart = DateTime.makeUnsafe("2026-09-07T03:00:00.000Z");
const chapterStart = DateTime.makeUnsafe("2026-09-09T03:00:00.000Z");
const target = DateTime.makeUnsafe("2026-09-10T12:00:00.000Z");

describe("workflow schedule timing", () => {
  it("keeps the captured chapter mapping workspace-wide", () => {
    const reference = scheduleTimeReferenceFor({
      referenceInstantEpochMs: DateTime.toEpochMillis(chapterStart),
      legacyHours: [193, null, 49],
    });

    expect(reference).toEqual(makeChapterStartReference(chapterStart, 49));
    expect(scheduleHourForInstant(reference!, target)).toBe(82);
  });

  it("gives equivalent chapter and full-event references the same hour", () => {
    const chapterReference = makeChapterStartReference(chapterStart, 49);
    const eventReference = makeEventStartReference(eventStart);

    expect(scheduleHourForInstant(chapterReference, target)).toBe(82);
    expect(scheduleHourForInstant(eventReference, target)).toBe(82);
    expect(scheduleHourWindowFor(chapterReference, 82)).toEqual(
      scheduleHourWindowFor(eventReference, 82),
    );
  });

  it("prefers an established source reference over new legacy row evidence", () => {
    const reference = scheduleTimeReferenceFor({
      referenceInstantEpochMs: DateTime.toEpochMillis(chapterStart),
      establishedReference: makeEventStartReference(eventStart),
      legacyHours: [193],
    });

    expect(reference).toEqual(makeEventStartReference(eventStart));
    expect(scheduleHourForInstant(reference!, target)).toBe(82);
  });
});
