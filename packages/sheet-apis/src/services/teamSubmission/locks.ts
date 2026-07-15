import { Effect, Semaphore } from "effect";
import { type SubmissionLockEntry, type SubmissionLockPayload, submissionLockKey } from "./pure";

export const makeSubmissionLocks = () => {
  const submissionLocks = new Map<string, SubmissionLockEntry>();

  const submissionLockFor = (payload: SubmissionLockPayload) =>
    Effect.sync(() => {
      const key = submissionLockKey(payload);
      const existingEntry = submissionLocks.get(key);
      if (existingEntry) {
        existingEntry.active += 1;
        return { key, entry: existingEntry };
      }

      // Effect v4 exposes immediate construction on Semaphore; this lock registry owns the entry.
      const entry = { semaphore: Semaphore.makeUnsafe(1), active: 1 };
      submissionLocks.set(key, entry);
      return { key, entry };
    });

  const releaseSubmissionLock = (key: string, entry: SubmissionLockEntry) =>
    Effect.sync(() => {
      entry.active -= 1;
      if (entry.active === 0 && submissionLocks.get(key) === entry) {
        submissionLocks.delete(key);
      }
    });

  const withSubmissionLock = <A, E, R>(
    payload: SubmissionLockPayload,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      submissionLockFor(payload),
      ({ entry }) => Semaphore.withPermit(entry.semaphore, effect),
      ({ entry, key }) => releaseSubmissionLock(key, entry),
    );

  return { withSubmissionLock };
};

export type SubmissionLocks = ReturnType<typeof makeSubmissionLocks>;
