import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { TeamSubmissionStatus } from "./index";
import type { TeamSubmissionStatus as TeamSubmissionStatusType } from "./index";

describe("sheet-models", () => {
  it("defines the canonical team submission statuses", () => {
    expect(Schema.decodeUnknownSync(TeamSubmissionStatus)("registered")).toBe("registered");
    expect(Schema.decodeUnknownSync(TeamSubmissionStatus)("applying")).toBe("applying");
    expect(Schema.decodeUnknownSync(TeamSubmissionStatus)("reverting")).toBe("reverting");
    expect(Schema.decodeUnknownSync(TeamSubmissionStatus)("rollbackFailed")).toBe("rollbackFailed");
    expect(() => Schema.decodeUnknownSync(TeamSubmissionStatus)("unknown")).toThrow();
    expectTypeOf<TeamSubmissionStatusType>().toEqualTypeOf<
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
