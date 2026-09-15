import { DateTime, Option, Predicate } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  makeChapterStartReference,
  makeEventStartReference,
  scheduleTimeReferenceMetadataFrom,
} from "sheet-domain";
import { SchedulesLoadWorkspaceSuccess } from "sheet-workflow-contracts";
import {
  computeScheduleHour,
  scheduleFromSummary,
  scheduleStart,
  scheduleTimeReferenceForResponse,
} from "./schedule";

const eventStart = DateTime.makeUnsafe("2026-09-07T03:00:00.000Z");
const chapterStart = DateTime.makeUnsafe("2026-09-09T03:00:00.000Z");
const chapterReference = makeChapterStartReference(chapterStart, 49);
const capturedServerSchedule = {
  serverId: "1486098790409568390",
  eventStart,
  chapterStart,
  chapterReference,
  hours: [193, 49, 82],
} as const;

const summary = (
  hour: number,
): (typeof SchedulesLoadWorkspaceSuccess.Type)["populatedSchedules"][number] => ({
  conversationName: "raid",
  day: 3,
  visible: true,
  hour,
  break: false,
  playerNames: ["Theerie"],
  playerAccountIds: ["account-theerie"],
  monitorName: null,
});

describe("schedule time projection", () => {
  it("uses an established chapter reference for event-wide hour windows", () => {
    const start = scheduleStart(chapterReference, 49);
    const next = scheduleStart(chapterReference, 50);

    expect(DateTime.toEpochMillis(start)).toBe(Date.UTC(2026, 8, 9, 3));
    expect(DateTime.toEpochMillis(next)).toBe(Date.UTC(2026, 8, 9, 4));
  });

  it(`projects captured server ${capturedServerSchedule.serverId} before filtering rows`, () => {
    const reference = scheduleTimeReferenceForResponse({
      startTimeEpochMs: DateTime.toEpochMillis(capturedServerSchedule.chapterStart),
      scheduleTimeReference: scheduleTimeReferenceMetadataFrom(
        capturedServerSchedule.chapterReference,
      ),
    });

    expect(reference).toEqual(capturedServerSchedule.chapterReference);

    const chapterProjection = scheduleFromSummary(reference, summary(82));
    const fullEventProjection = scheduleFromSummary(
      makeEventStartReference(capturedServerSchedule.eventStart),
      summary(82),
    );

    expect(chapterProjection.hourWindow).toEqual(fullEventProjection.hourWindow);
    expect(DateTime.toEpochMillis(Option.getOrThrow(chapterProjection.hourWindow).start)).toBe(
      Date.UTC(2026, 8, 10, 12),
    );
    expect(
      DateTime.toEpochMillis(
        Option.getOrThrow(scheduleFromSummary(reference, summary(193)).hourWindow).start,
      ),
    ).toBe(Date.UTC(2026, 8, 15, 3));
  });

  it("does not infer a reference from an incomplete response projection", () => {
    const reference = scheduleTimeReferenceForResponse({
      startTimeEpochMs: DateTime.toEpochMillis(chapterStart),
    });

    expect(reference).toBeUndefined();
  });

  it("uses the explicit response reference without schedule rows", () => {
    const reference = scheduleTimeReferenceForResponse({
      startTimeEpochMs: DateTime.toEpochMillis(chapterStart),
      scheduleTimeReference: scheduleTimeReferenceMetadataFrom(makeEventStartReference(eventStart)),
    });

    expect(reference).toEqual(makeEventStartReference(eventStart));
  });

  it("uses the resolved reference for date-to-hour navigation", () => {
    expect(
      Option.getOrThrow(
        computeScheduleHour(chapterReference, DateTime.makeUnsafe("2026-09-09T03:00:00.000Z"), 193),
      ),
    ).toBe(49);
    expect(
      Option.getOrThrow(
        computeScheduleHour(chapterReference, DateTime.makeUnsafe("2026-09-10T12:00:00.000Z"), 193),
      ),
    ).toBe(82);
    expect(
      computeScheduleHour(chapterReference, DateTime.makeUnsafe("2026-09-09T02:59:59.999Z"), 193),
    ).toEqual(Option.none());
  });

  it("keeps schedule identity for current-player highlighting", () => {
    const projected = scheduleFromSummary(chapterReference, summary(49));

    expect(Predicate.isTagged("PopulatedSchedule")(projected)).toBe(true);
    if (!Predicate.isTagged("PopulatedSchedule")(projected)) return;

    const player = Option.getOrThrow(projected.fills[0]!);
    expect(Predicate.isTagged("Player")(player.player)).toBe(true);
    if (!Predicate.isTagged("Player")(player.player)) return;

    expect(player.player.id).toBe("account-theerie");
    expect(DateTime.toEpochMillis(Option.getOrThrow(projected.hourWindow).start)).toBe(
      Date.UTC(2026, 8, 9, 3),
    );
  });

  it("preserves numeric-hour break rows as breaks", () => {
    const projected = scheduleFromSummary(chapterReference, { ...summary(49), break: true });

    expect(Predicate.isTagged("PopulatedBreakSchedule")(projected)).toBe(true);
    if (!Predicate.isTagged("PopulatedBreakSchedule")(projected)) return;

    expect(Option.getOrThrow(projected.hour)).toBe(49);
    expect(DateTime.toEpochMillis(Option.getOrThrow(projected.hourWindow).start)).toBe(
      Date.UTC(2026, 8, 9, 3),
    );
  });
});
