import { DateTime, Duration, Schema } from "effect";

/** A one-based event-wide schedule hour. */
export const ScheduleHour = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export type ScheduleHour = Schema.Schema.Type<typeof ScheduleHour>;

/** The timestamp and event-wide hour used to resolve the full event clock. */
export const ScheduleTimeReference = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("event-start"),
    instant: Schema.DateTimeUtc,
    hour: Schema.Literal(1),
  }),
  Schema.Struct({
    kind: Schema.Literal("chapter-start"),
    instant: Schema.DateTimeUtc,
    hour: ScheduleHour,
  }),
]);
export type ScheduleTimeReference = Schema.Schema.Type<typeof ScheduleTimeReference>;

/** A half-open UTC interval for one Schedule Hour. */
export const ScheduleHourInterval = Schema.Struct({
  start: Schema.DateTimeUtc,
  end: Schema.DateTimeUtc,
});
export type ScheduleHourInterval = Schema.Schema.Type<typeof ScheduleHourInterval>;

export const makeEventStartReference = (instant: DateTime.Utc): ScheduleTimeReference => ({
  kind: "event-start",
  instant,
  hour: 1,
});

export const makeChapterStartReference = (
  instant: DateTime.Utc,
  firstEventHour: ScheduleHour,
): ScheduleTimeReference => ({
  kind: "chapter-start",
  instant,
  hour: firstEventHour,
});

/** Resolves any reference to the canonical Event Start Instant and Schedule Hour 1. */
export const normalizeScheduleTimeReference = (
  reference: ScheduleTimeReference,
): ScheduleTimeReference =>
  makeEventStartReference(
    DateTime.subtractDuration(reference.instant, Duration.hours(reference.hour - 1)),
  );

/** Returns the half-open interval occupied by one event-wide Schedule Hour. */
export const scheduleHourInterval = (
  reference: ScheduleTimeReference,
  hour: ScheduleHour,
): ScheduleHourInterval => {
  const eventStart = normalizeScheduleTimeReference(reference).instant;
  const start = DateTime.addDuration(eventStart, Duration.hours(hour - 1));
  return {
    start,
    end: DateTime.addDuration(start, Duration.hours(1)),
  };
};

/** Returns the event-wide Schedule Hour containing an instant. */
export const scheduleHourAt = (reference: ScheduleTimeReference, instant: DateTime.Utc): number => {
  const eventStart = normalizeScheduleTimeReference(reference).instant;
  return Math.floor(Duration.toHours(DateTime.distance(eventStart, instant))) + 1;
};
