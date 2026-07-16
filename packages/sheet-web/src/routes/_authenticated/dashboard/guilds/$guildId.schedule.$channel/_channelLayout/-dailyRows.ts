import { Predicate } from "effect";
import { Sheet } from "sheet-ingress-api/schemas";

const isPopulatedSchedule = (
  schedule: Sheet.PopulatedScheduleResult,
): schedule is Sheet.PopulatedSchedule => Predicate.isTagged("PopulatedSchedule")(schedule);

export const classifyDailyHourSchedules = (
  schedules: readonly Sheet.PopulatedScheduleResult[],
): "break" | "schedule" => (schedules.some(isPopulatedSchedule) ? "schedule" : "break");

export const getDailyHourSchedules = (
  schedules: readonly Sheet.PopulatedScheduleResult[],
): readonly Sheet.PopulatedSchedule[] => schedules.filter(isPopulatedSchedule);
