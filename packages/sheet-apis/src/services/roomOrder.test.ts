import { describe, expect, it } from "@effect/vitest";
import { DateTime, Match } from "effect";
import { buildRoomOrderContent } from "./roomOrder";

const expectTimestampPart = (part: unknown, epochMs: number) =>
  Match.value(part).pipe(
    Match.when({ type: "timestamp", epochMs }, (timestamp) => {
      expect(timestamp).not.toHaveProperty("style");
    }),
    Match.orElse(() => {
      throw new Error(`Expected timestamp part for ${epochMs}`);
    }),
  );

describe("RoomOrderService buildRoomOrderContent", () => {
  it("leaves both hourly range endpoints in Discord date/time style", () => {
    const start = DateTime.makeUnsafe("2026-03-26T12:00:00.000Z");
    const end = DateTime.makeUnsafe("2026-03-26T13:00:00.000Z");
    const content = buildRoomOrderContent(1, start, end, null, [], [], []);

    expectTimestampPart(content[2], DateTime.toEpochMillis(start));
    expectTimestampPart(content[4], DateTime.toEpochMillis(end));
  });
});
