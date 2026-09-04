import { Predicate, Schema } from "effect";

export * from "./configuration";

export const TeamSubmissionStatus = Schema.Literals([
  "registered",
  "updated",
  "empty",
  "failed",
  "applying",
  "reverting",
  "confirmed",
  "rejected",
  "rollbackFailed",
]);
export type TeamSubmissionStatus = Schema.Schema.Type<typeof TeamSubmissionStatus>;

/**
 * Returns the sheet hour label that represents the event start.
 *
 * Legacy sheets may begin their labels at an offset (for example, hour 49). Empty
 * schedule rows do not participate in determining that origin.
 */
export const scheduleHourOrigin = (hours: ReadonlyArray<number | null>): number => {
  const populatedHours = hours.filter(Predicate.isNotNull);
  return populatedHours.length === 0 ? 1 : Math.min(...populatedHours);
};
