import { DateTime } from "effect";
import {
  scheduleHourAt,
  scheduleHourInterval,
  type ScheduleHour,
  type ScheduleTimeReference,
} from "sheet-domain";
import { scheduleTimeReferenceFromLegacy } from "sheet-domain/compatibility";

/**
 * Uses an established source reference when one exists and otherwise adapts the complete legacy
 * schedule-hour observation. The legacy hours must be collected before selecting a conversation.
 */
export const scheduleTimeReferenceFor = (options: {
  readonly referenceInstantEpochMs: number;
  readonly establishedReference?: ScheduleTimeReference;
  readonly legacyHours: ReadonlyArray<number | null>;
}): ScheduleTimeReference | undefined =>
  options.establishedReference ??
  scheduleTimeReferenceFromLegacy(options.referenceInstantEpochMs, options.legacyHours);

export const scheduleHourForInstant = (
  reference: ScheduleTimeReference,
  instant: DateTime.Utc,
): number => scheduleHourAt(reference, instant);

export const scheduleHourWindowFor = (reference: ScheduleTimeReference, hour: ScheduleHour) =>
  scheduleHourInterval(reference, hour);
