import { DateTime, Predicate } from "effect";
import {
  makeChapterStartReference,
  makeEventStartReference,
  scheduleTimeReferenceMetadataFrom,
  type ScheduleTimeReference,
  type ScheduleTimeReferenceMetadata,
} from "./scheduleTime";

/**
 * Decodes the pre-reference timestamp plus schedule-hour representation.
 *
 * This module is the only compatibility adapter for that representation. New callers should
 * receive a Schedule Time Reference from their owning workflow or configuration source.
 */
const scheduleTimeReferenceFromLegacyFirstHour = (
  referenceInstantEpochMs: number,
  firstEventHour: number,
): ScheduleTimeReference | undefined => {
  if (
    !Number.isSafeInteger(referenceInstantEpochMs) ||
    !Number.isSafeInteger(firstEventHour) ||
    firstEventHour < 1
  ) {
    return undefined;
  }
  const instant = DateTime.makeUnsafe(referenceInstantEpochMs);
  return firstEventHour === 1
    ? makeEventStartReference(instant)
    : makeChapterStartReference(instant, firstEventHour);
};

const populatedLegacyHours = (hours: ReadonlyArray<number | null>): ReadonlyArray<number> =>
  hours.filter(Predicate.isNotNull);

const firstEventHourFromLegacy = (hours: ReadonlyArray<number | null>): number => {
  const populatedHours = populatedLegacyHours(hours);
  return populatedHours.length === 0
    ? 1
    : populatedHours.reduce((minimum, hour) => Math.min(minimum, hour), Number.POSITIVE_INFINITY);
};

/** Resolves complete legacy schedule evidence without allowing a filtered view to redefine time. */
export const scheduleTimeReferenceFromLegacy = (
  referenceInstantEpochMs: number,
  hours: ReadonlyArray<number | null>,
): ScheduleTimeReference | undefined => {
  const populatedHours = populatedLegacyHours(hours);
  return populatedHours.length === 0
    ? undefined
    : scheduleTimeReferenceFromLegacyFirstHour(
        referenceInstantEpochMs,
        firstEventHourFromLegacy(populatedHours),
      );
};

/** Converts complete legacy schedule evidence into the JSON-safe compatibility projection. */
export const scheduleTimeReferenceMetadataFromLegacy = (
  referenceInstantEpochMs: number,
  hours: ReadonlyArray<number | null>,
): ScheduleTimeReferenceMetadata | undefined => {
  const reference = scheduleTimeReferenceFromLegacy(referenceInstantEpochMs, hours);
  return reference === undefined ? undefined : scheduleTimeReferenceMetadataFrom(reference);
};
