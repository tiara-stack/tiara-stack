import { DateTime, Duration, Match, Predicate, Schema } from "effect";

/** A one-based event-wide schedule hour. */
export const ScheduleHour = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export type ScheduleHour = Schema.Schema.Type<typeof ScheduleHour>;

const ChapterStartHour = ScheduleHour.check(Schema.isGreaterThan(1));

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
    hour: ChapterStartHour,
  }),
]);
export type ScheduleTimeReference = Schema.Schema.Type<typeof ScheduleTimeReference>;

/**
 * The JSON-safe form of a Schedule Time Reference used by persisted configuration and APIs.
 *
 * Keep this separate from `ScheduleTimeReference`: Effect DateTime values are useful at runtime,
 * while epoch milliseconds keep configuration revisions stable and JSON-compatible.
 */
export const ScheduleTimeReferenceMetadata = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("event-start"),
    instantEpochMs: Schema.Int,
    hour: Schema.Literal(1),
  }),
  Schema.Struct({
    kind: Schema.Literal("chapter-start"),
    instantEpochMs: Schema.Int,
    hour: ChapterStartHour,
  }),
]);
export type ScheduleTimeReferenceMetadata = Schema.Schema.Type<
  typeof ScheduleTimeReferenceMetadata
>;

/** The event fields used when retaining or deriving a Schedule Time Reference. */
export type ScheduleTimeReferenceEvent = {
  readonly startTimeEpochMs: number;
  readonly scheduleTimeReference?: ScheduleTimeReferenceMetadata | undefined;
};

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
  firstEventHour: typeof ChapterStartHour.Type,
): ScheduleTimeReference => ({
  kind: "chapter-start",
  instant,
  hour: firstEventHour,
});

export const scheduleTimeReferenceFromMetadata = (
  metadata: ScheduleTimeReferenceMetadata,
): ScheduleTimeReference => {
  return Match.value(metadata).pipe(
    Match.when({ kind: "event-start" }, ({ instantEpochMs }) =>
      makeEventStartReference(DateTime.makeUnsafe(instantEpochMs)),
    ),
    Match.when({ kind: "chapter-start" }, ({ instantEpochMs, hour }) =>
      makeChapterStartReference(DateTime.makeUnsafe(instantEpochMs), hour),
    ),
    Match.exhaustive,
  );
};

export const scheduleTimeReferenceMetadataFrom = (
  reference: ScheduleTimeReference,
): ScheduleTimeReferenceMetadata =>
  Match.value(reference).pipe(
    Match.when({ kind: "event-start" }, ({ instant }) => ({
      kind: "event-start" as const,
      instantEpochMs: DateTime.toEpochMillis(instant),
      hour: 1 as const,
    })),
    Match.when({ kind: "chapter-start" }, ({ instant, hour }) => ({
      kind: "chapter-start" as const,
      instantEpochMs: DateTime.toEpochMillis(instant),
      hour,
    })),
    Match.exhaustive,
  );

/**
 * Converts the old timestamp-plus-first-hour pair into one explicit reference.
 * A missing or invalid first hour is unresolved rather than being guessed as hour 1.
 */
export const scheduleTimeReferenceFromLegacyFirstHour = (
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

/** Returns the first populated legacy Schedule Hour, preserving the old empty-input default. */
export const firstEventHourFromLegacy = (hours: ReadonlyArray<number | null>): number => {
  const populatedHours = hours.filter(Predicate.isNotNull);
  return populatedHours.length === 0
    ? 1
    : populatedHours.reduce((minimum, hour) => Math.min(minimum, hour), Number.POSITIVE_INFINITY);
};

/**
 * Resolves an old configuration with the complete workspace schedule-hour evidence.
 * Callers must collect rows before narrowing to a conversation or visible subset.
 */
export const scheduleTimeReferenceFromLegacy = (
  referenceInstantEpochMs: number,
  hours: ReadonlyArray<number | null>,
): ScheduleTimeReference | undefined => {
  const populatedHours = hours.filter(Predicate.isNotNull);
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

/**
 * Returns an explicit reference for an event configuration while keeping the stored timestamp
 * available as an identity input. A matching current reference is retained across an unrelated
 * configuration revision; a changed timestamp starts a new event-start reference.
 */
export const scheduleTimeReferenceMetadataForEvent = (
  event: ScheduleTimeReferenceEvent,
  currentReference?: ScheduleTimeReferenceMetadata,
): ScheduleTimeReferenceMetadata => {
  const explicitReference = event.scheduleTimeReference;
  const matchingCurrentReference =
    currentReference?.instantEpochMs === event.startTimeEpochMs ? currentReference : undefined;
  if (matchingCurrentReference !== undefined) return matchingCurrentReference;
  return explicitReference !== undefined &&
    explicitReference.instantEpochMs === event.startTimeEpochMs
    ? explicitReference
    : {
        kind: "event-start" as const,
        instantEpochMs: event.startTimeEpochMs,
        hour: 1 as const,
      };
};

/** Returns a stored event reference only when it is explicit or still anchored to the timestamp. */
export const scheduleTimeReferenceMetadataForEventIfAnchored = (
  event: ScheduleTimeReferenceEvent,
  currentReference?: ScheduleTimeReferenceMetadata,
): ScheduleTimeReferenceMetadata | undefined =>
  (currentReference?.instantEpochMs === event.startTimeEpochMs ? currentReference : undefined) ??
  (event.scheduleTimeReference?.instantEpochMs === event.startTimeEpochMs
    ? event.scheduleTimeReference
    : undefined);

/** Resolves an event reference while preserving the selected Configuration Source's anchor. */
export const scheduleTimeReferenceMetadataForEventFromSource = (
  event: ScheduleTimeReferenceEvent,
  sourceReference?: ScheduleTimeReferenceMetadata,
): ScheduleTimeReferenceMetadata | undefined =>
  scheduleTimeReferenceMetadataForEventIfAnchored(event, sourceReference) ??
  (sourceReference === undefined
    ? undefined
    : scheduleTimeReferenceMetadataForEvent(event, sourceReference));

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
