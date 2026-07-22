import { describe, expect, it } from "@effect/vitest";
import { TEAM_SUBMISSION_FEATURE_FLAG, isTeamSubmissionEnabled } from "./teamSubmission";

describe("isTeamSubmissionEnabled", () => {
  it("matches only the team submission feature flag", () => {
    expect(isTeamSubmissionEnabled([])).toBe(false);
    expect(isTeamSubmissionEnabled([{ flagName: "another-feature" }])).toBe(false);
    expect(
      isTeamSubmissionEnabled([
        { flagName: "another-feature" },
        { flagName: TEAM_SUBMISSION_FEATURE_FLAG },
      ]),
    ).toBe(true);
  });
});
