import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  AutoCheckinSweepWorkflow,
  AutoRoleCleanupSweepWorkflow,
  canonicalScheduledHourBucket,
} from "./autoCheckinContract";

describe("autonomous trigger workflows", () => {
  it.effect("converge duplicate timer firings to one sweep execution", () =>
    Effect.gen(function* () {
      const bucket = Date.UTC(2026, 3, 1, 13);
      const first = yield* AutoCheckinSweepWorkflow.executionId({
        scheduledHourBucketEpochMs: bucket + 45 * 60_000,
      });
      const duplicate = yield* AutoCheckinSweepWorkflow.executionId({
        scheduledHourBucketEpochMs: bucket + 59 * 60_000,
      });
      const roleCleanup = yield* AutoRoleCleanupSweepWorkflow.executionId({
        scheduledHourBucketEpochMs: bucket,
      });
      const roleCleanupDuplicate = yield* AutoRoleCleanupSweepWorkflow.executionId({
        scheduledHourBucketEpochMs: bucket + 59 * 60_000,
      });
      const nextHour = yield* AutoCheckinSweepWorkflow.executionId({
        scheduledHourBucketEpochMs: bucket + 60 * 60_000,
      });
      const roleCleanupNextHour = yield* AutoRoleCleanupSweepWorkflow.executionId({
        scheduledHourBucketEpochMs: bucket + 60 * 60_000,
      });

      expect(canonicalScheduledHourBucket(bucket + 59 * 60_000)).toBe(bucket);
      expect(duplicate).toBe(first);
      expect(nextHour).not.toBe(first);
      expect(roleCleanup).not.toBe(first);
      expect(roleCleanupDuplicate).toBe(roleCleanup);
      expect(roleCleanupNextHour).not.toBe(roleCleanup);
    }),
  );
});
