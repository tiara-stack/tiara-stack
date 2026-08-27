import { Predicate } from "effect";
import * as Schedule from "#/lib/scheduleValues";

const isPopulatedSchedule = (
  schedule: Schedule.PopulatedScheduleResult,
): schedule is Schedule.PopulatedSchedule => Predicate.isTagged("PopulatedSchedule")(schedule);

export const classifyDailyHourSchedules = (
  schedules: readonly Schedule.PopulatedScheduleResult[],
): "break" | "schedule" => (schedules.some(isPopulatedSchedule) ? "schedule" : "break");

export const getDailyHourSchedules = (
  schedules: readonly Schedule.PopulatedScheduleResult[],
): readonly Schedule.PopulatedSchedule[] => schedules.filter(isPopulatedSchedule);
