import { describe, expect, it } from "@effect/vitest";
import { DateTime } from "effect";
import { buildRoomOrderContent } from "sheet-message-content/roomOrderContent";

const roomOrderContentHeader = (start: DateTime.DateTime, end: DateTime.DateTime) =>
  buildRoomOrderContent(1, start, end, null, [], [], []).slice(0, 5);

const expectedHeader = (start: DateTime.DateTime, end: DateTime.DateTime) => [
  { type: "strong", parts: [{ type: "text", text: "Hour 1" }] },
  { type: "text", text: " " },
  { type: "timestamp", epochMs: DateTime.toEpochMillis(start) },
  { type: "text", text: " - " },
  {
    type: "timestamp",
    epochMs: DateTime.toEpochMillis(end),
  },
];

describe("buildRoomOrderContent", () => {
  it("renders hourly ranges with date/time on both ends", () => {
    const start = DateTime.makeUnsafe("2026-03-26T12:00:00.000Z");
    const end = DateTime.makeUnsafe("2026-03-26T13:00:00.000Z");
    const header = roomOrderContentHeader(start, end);

    expect(header).toEqual(expectedHeader(start, end));
  });

  it("does not decide cross-day display outside the Discord viewer timezone", () => {
    const start = DateTime.makeUnsafe("2026-03-26T23:00:00.000Z");
    const end = DateTime.makeUnsafe("2026-03-27T00:00:00.000Z");
    const header = roomOrderContentHeader(start, end);

    expect(header).toEqual(expectedHeader(start, end));
  });
});
