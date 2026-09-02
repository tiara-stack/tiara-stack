export type RunnerHourInterval = {
  readonly start: number;
  readonly end: number;
};

export type RunnerHoursInputResult = {
  readonly hours: ReadonlyArray<RunnerHourInterval>;
  readonly error?: string;
};

const runnerHourIntervalPattern = /^(\d+)\s*-\s*(\d+)$/u;

/** Parses editable Runner hours without destroying partially typed input. */
export const parseRunnerHoursInput = (value: string): RunnerHoursInputResult => {
  if (value.trim().length === 0) return { hours: [] };
  const hours: Array<RunnerHourInterval> = [];
  const parts = value.split(",");
  for (const [index, part] of parts.entries()) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      return {
        hours,
        error:
          index === parts.length - 1
            ? "Finish the last interval, for example 12-14."
            : "Remove the empty interval between commas.",
      };
    }
    const match = runnerHourIntervalPattern.exec(trimmed);
    if (match === null) {
      return { hours, error: "Use comma-separated intervals like 8-10, 12-14." };
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      return { hours, error: `${trimmed} must use safe whole-hour numbers.` };
    }
    if (start > end) {
      return { hours, error: `${trimmed} must end at or after its start.` };
    }
    hours.push({ start, end });
  }
  return { hours };
};

export const formatRunnerHours = (hours: ReadonlyArray<RunnerHourInterval>): string =>
  hours.map(({ start, end }) => `${start}-${end}`).join(", ");
