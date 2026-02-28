import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, Suspense } from "react";
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameMonth,
  addMonths,
  subMonths,
  parseISO,
} from "date-fns";
import { toZonedTime } from "date-fns-tz";
import { useGuildSchedule, filterSchedulesByDate } from "#/lib/schedule";
import { useEventConfig } from "#/lib/sheet";
import { useTimeZone } from "#/hooks/useTimeZone";

export const Route = createFileRoute(
  "/dashboard/guilds/$guildId/schedule/$channel/_layout/calendar",
)({
  component: CalendarPage,
});

// Helper to get days in month grid (including padding days)
function getCalendarDays(date: Date, timeZone: string): Date[] {
  const zonedDate = toZonedTime(date, timeZone);
  const monthStart = startOfMonth(zonedDate);
  const monthEnd = endOfMonth(zonedDate);
  const calendarStart = startOfWeek(monthStart, { weekStartsOn: 0 });
  const calendarEnd = endOfWeek(monthEnd, { weekStartsOn: 0 });

  return eachDayOfInterval({ start: calendarStart, end: calendarEnd });
}

function CalendarPage() {
  const { guildId } = Route.useParams();
  const timeZone = useTimeZone();
  const navigate = useNavigate();

  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <div className="text-white/60 font-medium tracking-wide">LOADING CALENDAR...</div>
        </div>
      }
    >
      <CalendarView guildId={guildId} timeZone={timeZone} navigate={navigate} />
    </Suspense>
  );
}

function CalendarView({
  guildId,
  timeZone,
  navigate,
}: {
  guildId: string;
  timeZone: string;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const { channel } = Route.useParams();
  const search = Route.useSearch();

  // Parse month with fallback to current month if invalid
  const currentDate = useMemo(() => {
    try {
      const parsed = parseISO(`${search.month}-01`);
      return isNaN(parsed.getTime()) ? new Date() : parsed;
    } catch {
      return new Date();
    }
  }, [search.month]);

  const scheduleData = useGuildSchedule(guildId);
  const eventConfig = useEventConfig(guildId);

  const calendarDays = useMemo(() => {
    return getCalendarDays(currentDate, timeZone);
  }, [currentDate, timeZone]);

  // Build set of days that have schedules for the selected channel
  const scheduledDays = useMemo(() => {
    const days = new Set<string>();

    calendarDays.forEach((day) => {
      // Get schedules for this day
      const daySchedules = filterSchedulesByDate(
        scheduleData,
        eventConfig.startTime,
        day,
        timeZone,
      );

      // Check if any schedule belongs to the selected channel
      const hasChannelSchedule = daySchedules.some(
        (schedule) =>
          schedule._tag === "PopulatedSchedule" && schedule.channel === channel && schedule.visible,
      );

      if (hasChannelSchedule) {
        const zonedDay = toZonedTime(day, timeZone);
        days.add(format(zonedDay, "yyyy-MM-dd"));
      }
    });

    return days;
  }, [scheduleData, eventConfig.startTime, calendarDays, timeZone, channel]);

  const weekDays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

  const handlePrevMonth = () => {
    const prevMonth = subMonths(currentDate, 1);
    navigate({
      to: ".",
      params: { guildId, channel },
      search: {
        month: format(prevMonth, "yyyy-MM"),
        day: search.day,
      },
    });
  };

  const handleNextMonth = () => {
    const nextMonth = addMonths(currentDate, 1);
    navigate({
      to: ".",
      params: { guildId, channel },
      search: {
        month: format(nextMonth, "yyyy-MM"),
        day: search.day,
      },
    });
  };

  const handleDayClick = (day: Date) => {
    const zonedDay = toZonedTime(day, timeZone);
    const dayStr = format(zonedDay, "yyyy-MM-dd");
    navigate({
      to: "/dashboard/guilds/$guildId/schedule/$channel/daily",
      params: { guildId, channel },
      search: { month: format(zonedDay, "yyyy-MM"), day: dayStr },
    });
  };

  return (
    <div className="border border-[#33ccbb]/20 bg-[#0f1615]">
      {/* Calendar Header */}
      <div className="flex items-center justify-between p-4 border-b border-[#33ccbb]/20">
        <button
          onClick={handlePrevMonth}
          className="p-2 hover:bg-[#33ccbb]/10 transition-colors text-[#33ccbb]"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <h3 className="text-lg font-black tracking-tight">
          {format(currentDate, "MMMM yyyy").toUpperCase()}
        </h3>
        <button
          onClick={handleNextMonth}
          className="p-2 hover:bg-[#33ccbb]/10 transition-colors text-[#33ccbb]"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>

      {/* Weekday Headers */}
      <div className="grid grid-cols-7 border-b border-[#33ccbb]/20">
        {weekDays.map((day) => (
          <div
            key={day}
            className="p-3 text-center text-xs font-bold text-[#33ccbb]/60 tracking-wider"
          >
            {day}
          </div>
        ))}
      </div>

      {/* Calendar Grid */}
      <div className="grid grid-cols-7">
        {calendarDays.map((day, index) => {
          const isCurrentMonth = isSameMonth(day, currentDate);
          // Get the day of month in the target timezone
          const zonedDay = toZonedTime(day, timeZone);
          const dayKey = format(zonedDay, "yyyy-MM-dd");
          const hasSchedule = scheduledDays.has(dayKey);

          return (
            <button
              key={index}
              onClick={() => handleDayClick(day)}
              className={`
                aspect-square p-2 flex flex-col items-center justify-center
                border-r border-b border-[#33ccbb]/10 last:border-r-0
                transition-colors
                ${isCurrentMonth ? "text-white hover:bg-[#33ccbb]/10" : "text-white/30"}
                ${hasSchedule ? "bg-[#33ccbb]/5" : ""}
              `}
            >
              <span className="text-sm font-medium">{format(zonedDay, "d")}</span>
              {hasSchedule && <div className="mt-1 w-1.5 h-1.5 rounded-full bg-[#33ccbb]" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
