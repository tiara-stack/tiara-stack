import { Duration, Schedule } from "effect";

const defaultShortRetrySchedule = Schedule.exponential(Duration.millis(100)).pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(2)),
);

export const messageEnableRetrySchedule = defaultShortRetrySchedule;

export const shortRoleRetrySchedule = messageEnableRetrySchedule;

export const claimRetrySchedule = defaultShortRetrySchedule;
