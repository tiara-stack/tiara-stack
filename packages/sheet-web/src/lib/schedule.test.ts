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
  playerNames: ["Theerie"],
  playerAccountIds: ["account-theerie"],
  monitorName: null,
} satisfies (typeof SchedulesLoadWorkspaceSuccess.Type)["populatedSchedules"][number];

describe("schedule time projection", () => {
  it("treats hour 49 as 48 hours after the event start regardless of sheet day", () => {
    const start = scheduleStart(eventStart, 49);

    expect(DateTime.toEpochMillis(start)).toBe(Date.UTC(2026, 0, 3));
  });

  it("keeps schedule identity for current-player highlighting", () => {
    const projected = scheduleFromSummary(eventStart, summary);

    expect(Predicate.isTagged("PopulatedSchedule")(projected)).toBe(true);
    if (!Predicate.isTagged("PopulatedSchedule")(projected)) return;

    const player = Option.getOrThrow(projected.fills[0]!);
    expect(Predicate.isTagged("Player")(player.player)).toBe(true);
    if (!Predicate.isTagged("Player")(player.player)) return;

    expect(player.player.id).toBe("account-theerie");
    expect(DateTime.toEpochMillis(Option.getOrThrow(projected.hourWindow).start)).toBe(
      Date.UTC(2026, 0, 3),
    );
  });
});
