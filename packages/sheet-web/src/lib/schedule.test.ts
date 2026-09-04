import { DateTime, Option, Predicate } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { SchedulesLoadWorkspaceSuccess } from "sheet-workflow-contracts";
import { scheduleFromSummary, scheduleStart } from "./schedule";

const eventStart = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

const summary = {
  conversationName: "raid",
  day: 3,
  visible: true,
  hour: 49,
  break: false,
  playerNames: ["Theerie"],
  playerAccountIds: ["account-theerie"],
  monitorName: null,
} satisfies (typeof SchedulesLoadWorkspaceSuccess.Type)["populatedSchedules"][number];

describe("schedule time projection", () => {
  it("treats the first populated sheet hour as the event start", () => {
    const start = scheduleStart(eventStart, 49, 49);
    const next = scheduleStart(eventStart, 50, 49);

    expect(DateTime.toEpochMillis(start)).toBe(Date.UTC(2026, 0, 1));
    expect(DateTime.toEpochMillis(next)).toBe(Date.UTC(2026, 0, 1, 1));
  });

  it("keeps schedule identity for current-player highlighting", () => {
    const projected = scheduleFromSummary(eventStart, 49, summary);

    expect(Predicate.isTagged("PopulatedSchedule")(projected)).toBe(true);
    if (!Predicate.isTagged("PopulatedSchedule")(projected)) return;

    const player = Option.getOrThrow(projected.fills[0]!);
    expect(Predicate.isTagged("Player")(player.player)).toBe(true);
    if (!Predicate.isTagged("Player")(player.player)) return;

    expect(player.player.id).toBe("account-theerie");
    expect(DateTime.toEpochMillis(Option.getOrThrow(projected.hourWindow).start)).toBe(
      Date.UTC(2026, 0, 1),
    );
  });

  it("preserves numeric-hour break rows as breaks", () => {
    const projected = scheduleFromSummary(eventStart, 49, { ...summary, break: true });

    expect(Predicate.isTagged("PopulatedBreakSchedule")(projected)).toBe(true);
    if (!Predicate.isTagged("PopulatedBreakSchedule")(projected)) return;

    expect(Option.getOrThrow(projected.hour)).toBe(49);
    expect(DateTime.toEpochMillis(Option.getOrThrow(projected.hourWindow).start)).toBe(
      Date.UTC(2026, 0, 1),
    );
  });
});
