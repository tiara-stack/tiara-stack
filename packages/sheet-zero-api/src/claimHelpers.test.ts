import { describe, expect, it } from "vitest";
import { hasStaleUntrackedSendClaim, isActiveSendClaim } from "./claimHelpers";

const claimStaleMs = 10 * 60 * 1_000;

describe("claim helpers", () => {
  it("expires claims with excessive past or future clock skew", () => {
    const now = 1_700_000_000_000;

    expect(isActiveSendClaim("claim-1", now - claimStaleMs, now)).toBe(true);
    expect(isActiveSendClaim("claim-1", new Date(now + claimStaleMs), now)).toBe(true);
    expect(isActiveSendClaim("claim-1", now - claimStaleMs - 1, now)).toBe(false);
    expect(isActiveSendClaim("claim-1", now + claimStaleMs + 1, now)).toBe(false);
  });

  it("treats nullish sent-message identifiers as untracked", () => {
    const now = 1_700_000_000_000;

    expect(
      hasStaleUntrackedSendClaim(
        {
          sendClaimId: "claim-1",
          sendClaimedAt: now - claimStaleMs - 1,
        },
        now,
      ),
    ).toBe(true);
  });
});
