import { HashSet, Schema } from "effect";
import type { PermissionSet } from "../permissions";
import { BreakSchedule, Schedule } from "./schedule";
import { PopulatedScheduleResult } from "./populatedSchedule";

export const ScheduleView = Schema.Literals(["filler", "monitor"]);

export type ScheduleView = Schema.Schema.Type<typeof ScheduleView>;

export const ScheduleResponse = Schema.Struct({
  view: ScheduleView,
  schedules: Schema.Array(Schema.Union([BreakSchedule, Schedule])),
});

export type ScheduleResponse = Schema.Schema.Type<typeof ScheduleResponse>;

export const PopulatedScheduleResponse = Schema.Struct({
  view: ScheduleView,
  schedules: Schema.Array(PopulatedScheduleResult),
});

export type PopulatedScheduleResponse = Schema.Schema.Type<typeof PopulatedScheduleResponse>;

export const PlayerDayScheduleSummary = Schema.Struct({
  fillHours: Schema.Array(Schema.Number),
  overfillHours: Schema.Array(Schema.Number),
  standbyHours: Schema.Array(Schema.Number),
  invisible: Schema.Boolean,
});

export type PlayerDayScheduleSummary = Schema.Schema.Type<typeof PlayerDayScheduleSummary>;

export const PlayerDayScheduleResponse = Schema.Struct({
  view: ScheduleView,
  schedule: PlayerDayScheduleSummary,
});

export type PlayerDayScheduleResponse = Schema.Schema.Type<typeof PlayerDayScheduleResponse>;

export const getMaximumScheduleView = (permissions: PermissionSet, guildId: string): ScheduleView =>
  HashSet.has(permissions, "service") ||
  HashSet.has(permissions, "app_owner") ||
  HashSet.has(permissions, `monitor_workspace:${guildId}`)
    ? "monitor"
    : "filler";

export const getEffectiveScheduleView = (
  maximumView: ScheduleView,
  requestedView?: ScheduleView,
): ScheduleView => {
  const normalizedRequestedView = requestedView ?? maximumView;
  return normalizedRequestedView === "monitor" && maximumView === "monitor" ? "monitor" : "filler";
};
