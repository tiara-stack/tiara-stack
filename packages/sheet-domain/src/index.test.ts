import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { scheduleHourOrigin, TeamSubmissionStatus } from "./index";
import type { TeamSubmissionStatus as TeamSubmissionStatusType } from "./index";

describe("sheet-domain", () => {
  it("uses the earliest populated schedule hour as the event-time origin", () => {
    expect(scheduleHourOrigin([null, 49, 50, 77])).toBe(49);
    expect(scheduleHourOrigin([])).toBe(1);
  });

  it("defines the canonical team submission statuses", () => {
    expect(Schema.decodeUnknownSync(TeamSubmissionStatus)("pending")).toBe("pending");
    expect(Schema.decodeUnknownSync(TeamSubmissionStatus)("registered")).toBe("registered");
    expect(Schema.decodeUnknownSync(TeamSubmissionStatus)("applying")).toBe("applying");
    expect(Schema.decodeUnknownSync(TeamSubmissionStatus)("reverting")).toBe("reverting");
    expect(Schema.decodeUnknownSync(TeamSubmissionStatus)("rollbackFailed")).toBe("rollbackFailed");
    expect(() => Schema.decodeUnknownSync(TeamSubmissionStatus)("unknown")).toThrow();
    expectTypeOf<TeamSubmissionStatusType>().toEqualTypeOf<
      | "pending"
      | "registered"
      | "updated"
      | "empty"
      | "failed"
      | "applying"
      | "reverting"
      | "confirmed"
      | "rejected"
      | "rollbackFailed"
    >();
  });
});
