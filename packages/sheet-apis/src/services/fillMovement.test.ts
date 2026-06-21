// fallow-ignore-file code-duplication
import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { PopulatedBreakSchedule } from "sheet-ingress-api/schemas/sheet";
import { diffFillParticipants, getScheduleFills, toFillParticipant } from "./fillMovement";
import { makePartialFill, makeResolvedFill, makeSchedule } from "./testHelpers";

describe("fillMovement", () => {
  it("returns populated fills and ignores break schedules", () => {
    const resolved = makeResolvedFill("1", "Alice");
    const partial = makePartialFill("Bob");
    const schedule = makeSchedule([resolved, partial]);
    const breakSchedule = new PopulatedBreakSchedule({
      channel: "room-1",
      day: 1,
      visible: true,
      hour: Option.some(1),
      hourWindow: Option.none(),
    });

    expect(getScheduleFills(schedule)).toEqual([resolved, partial]);
    expect(getScheduleFills(breakSchedule)).toEqual([]);
    expect(getScheduleFills(undefined)).toEqual([]);
  });

  it("diffs mixed out, stay, and in participants", () => {
    const alice = makeResolvedFill("1", "Alice");
    const bob = makeResolvedFill("2", "Bob");
    const carol = makePartialFill("Carol");
    const dave = makePartialFill("Dave");
    const movement = diffFillParticipants(
      [alice, bob, carol].map(toFillParticipant),
      [bob, dave, carol].map(toFillParticipant),
    );

    expect(movement.out.map(({ name }) => name)).toEqual(["Alice"]);
    expect(movement.stay.map(({ name }) => name)).toEqual(["Bob", "Carol"]);
    expect(movement.in.map(({ name }) => name)).toEqual(["Dave"]);
  });

  it("keeps all current participants in stay when both hours match", () => {
    const alice = makeResolvedFill("1", "Alice");
    const bob = makePartialFill("Bob");
    const movement = diffFillParticipants(
      [alice, bob].map(toFillParticipant),
      [alice, bob].map(toFillParticipant),
    );

    expect(movement.out).toEqual([]);
    expect(movement.stay.map(({ name }) => name)).toEqual(["Alice", "Bob"]);
    expect(movement.in).toEqual([]);
  });

  it("marks all current participants as in when there is no previous hour", () => {
    const alice = makeResolvedFill("1", "Alice");
    const bob = makePartialFill("Bob");
    const movement = diffFillParticipants([], [alice, bob].map(toFillParticipant));

    expect(movement.out).toEqual([]);
    expect(movement.stay).toEqual([]);
    expect(movement.in.map(({ name }) => name)).toEqual(["Alice", "Bob"]);
  });

  it("marks all previous participants as out when the current hour is empty", () => {
    const alice = makeResolvedFill("1", "Alice");
    const bob = makePartialFill("Bob");
    const movement = diffFillParticipants([alice, bob].map(toFillParticipant), []);

    expect(movement.out.map(({ name }) => name)).toEqual(["Alice", "Bob"]);
    expect(movement.stay).toEqual([]);
    expect(movement.in).toEqual([]);
  });

  it("deduplicates duplicate participants by stable key", () => {
    const alice = makeResolvedFill("1", "Alice");
    const carol = makePartialFill("Carol");
    const movement = diffFillParticipants(
      [alice, alice, carol].map(toFillParticipant),
      [alice, carol, carol].map(toFillParticipant),
    );

    expect(movement.out).toEqual([]);
    expect(movement.stay.map(({ name }) => name)).toEqual(["Alice", "Carol"]);
    expect(movement.in).toEqual([]);
  });

  it("compares resolved players by Discord ID", () => {
    const previous = makeResolvedFill("1", "Alice");
    const current = makeResolvedFill("1", "Alicia");
    const movement = diffFillParticipants(
      [previous].map(toFillParticipant),
      [current].map(toFillParticipant),
    );

    expect(movement.out).toEqual([]);
    expect(movement.stay.map(({ name, userId }) => ({ name, userId }))).toEqual([
      { name: "Alicia", userId: "1" },
    ]);
    expect(movement.in).toEqual([]);
  });

  it("compares partial-name players by the stored name", () => {
    const movement = diffFillParticipants(
      [makePartialFill("Alice")].map(toFillParticipant),
      [makePartialFill("alice")].map(toFillParticipant),
    );

    expect(movement.out.map(({ name }) => name)).toEqual(["Alice"]);
    expect(movement.stay).toEqual([]);
    expect(movement.in.map(({ name }) => name)).toEqual(["alice"]);
  });
});
