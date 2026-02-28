import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, Suspense } from "react";
import { DateTime, HashSet, Option } from "effect";
import { useScheduledDays, formatDayKey } from "#/lib/schedule";
import { useTimeZone } from "#/hooks/useTimeZone";

export const Route = createFileRoute(
  "/dashboard/guilds/$guildId/schedule/$channel/_layout/calendar",
)({
  component: CalendarPage,
  ssr: "data-only", // Prevent component SSR to avoid timezone-based content flash
});

// Helper to get all days in a calendar grid (including padding days from prev/next month)
function getCalendarDays(dateTime: DateTime.Utc, timeZone: string): DateTime.Utc[] {
  // Work with UTC dates but use the zoned date to determine month boundaries
  const zoned = DateTime.unsafeSetZoneNamed(dateTime, timeZone);
  const monthStartZoned = DateTime.startOf(zoned, "month");
  const monthEndZoned = DateTime.endOf(zoned, "month");
  const calendarStartZoned = DateTime.startOf(monthStartZoned, "week", { weekStartsOn: 0 });
  const calendarEndZoned = DateTime.endOf(monthEndZoned, "week", { weekStartsOn: 0 });

  // Convert back to UTC for the array
  const calendarStart = DateTime.toUtc(calendarStartZoned);
  const calendarEnd = DateTime.toUtc(calendarEndZoned);

  const days: DateTime.Utc[] = [];
  let current = calendarStart;
  const endMillis = DateTime.toEpochMillis(calendarEnd);

  while (DateTime.toEpochMillis(current) <= endMillis) {
    days.push(current);
    current = DateTime.add(current, { days: 1 });
  }

  return days;
}

// Format month/year for display (e.g., "FEBRUARY 2026")
function formatMonthYear(dateTime: DateTime.Utc, timeZone: string): string {
  const zoned = DateTime.unsafeSetZoneNamed(dateTime, timeZone);
  const parts = DateTime.toParts(zoned);
  const monthNames = [
    "JANUARY",
    "FEBRUARY",
    "MARCH",
    "APRIL",
    "MAY",
    "JUNE",
    "JULY",
    "AUGUST",
    "SEPTEMBER",
    "OCTOBER",
    "NOVEMBER",
    "DECEMBER",
  ];
  return `${monthNames[parts.month - 1]} ${parts.year}`;
}

// Format day of month for display
function formatDayOfMonth(dateTime: DateTime.Utc, timeZone: string): string {
  const zoned = DateTime.unsafeSetZoneNamed(dateTime, timeZone);
  const parts = DateTime.toParts(zoned);
  return String(parts.day);
}

// Check if two dates are in the same month
function isSameMonth(a: DateTime.Utc, b: DateTime.Utc, timeZone: string): boolean {
  const zonedA = DateTime.unsafeSetZoneNamed(a, timeZone);
  const zonedB = DateTime.unsafeSetZoneNamed(b, timeZone);
  const partsA = DateTime.toParts(zonedA);
  const partsB = DateTime.toParts(zonedB);
  return partsA.year === partsB.year && partsA.month === partsB.month;
}

function CalendarPage() {
  const { guildId } = Route.useParams();

  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <div className="text-white/60 font-medium tracking-wide">LOADING CALENDAR...</div>
        </div>
      }
    >
      <CalendarView guildId={guildId} />
    </Suspense>
  );
}

function CalendarView({ guildId }: { guildId: string }) {
  const { channel } = Route.useParams();
  const search = Route.useSearch();

  const timeZone = useTimeZone();
  const navigate = useNavigate();

  // Use timestamp to determine the month to display
  const currentDate = useMemo(() => {
    const maybeDateTime = DateTime.make(search.timestamp);
    return Option.isSome(maybeDateTime) ? maybeDateTime.value : DateTime.unsafeNow();
  }, [search.timestamp]);

  const calendarDays = useMemo(() => {
    return getCalendarDays(currentDate, timeZone);
  }, [currentDate, timeZone]);

  // Get the date range for the calendar view in milliseconds
  const rangeStart = useMemo(() => {
    const firstDay = calendarDays[0];
    return firstDay ? DateTime.toEpochMillis(firstDay) : 0;
  }, [calendarDays]);

  const rangeEnd = useMemo(() => {
    const lastDay = calendarDays[calendarDays.length - 1];
    return lastDay ? DateTime.toEpochMillis(lastDay) + 24 * 60 * 60 * 1000 : 0;
  }, [calendarDays]);

  // Use derived atom to get scheduled days for the calendar view
  const scheduledDays = useScheduledDays({
    guildId,
    channel,
    timeZone,
    rangeStart,
    rangeEnd,
  });

  const weekDays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

  const handlePrevMonth = () => {
    const zoned = DateTime.unsafeSetZoneNamed(currentDate, timeZone);
    const prevMonthZoned = DateTime.subtract(zoned, { months: 1 });
    const prevMonthStartZoned = DateTime.startOf(prevMonthZoned, "month");
    navigate({
      to: ".",
      params: { guildId, channel },
      search: {
        timestamp: DateTime.toEpochMillis(prevMonthStartZoned),
      },
    });
  };

  const handleNextMonth = () => {
    const zoned = DateTime.unsafeSetZoneNamed(currentDate, timeZone);
    const nextMonthZoned = DateTime.add(zoned, { months: 1 });
    const nextMonthStartZoned = DateTime.startOf(nextMonthZoned, "month");
    navigate({
      to: ".",
      params: { guildId, channel },
      search: {
        timestamp: DateTime.toEpochMillis(nextMonthStartZoned),
      },
    });
  };

  const handleDayClick = (day: DateTime.Utc) => {
    const zoned = DateTime.unsafeSetZoneNamed(day, timeZone);
    const dayTimestamp = DateTime.toEpochMillis(DateTime.startOf(zoned, "day"));
    navigate({
      to: "/dashboard/guilds/$guildId/schedule/$channel/daily",
      params: { guildId, channel },
      search: { timestamp: dayTimestamp },
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
          {formatMonthYear(currentDate, timeZone)}
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
          const isCurrentMonth = isSameMonth(day, currentDate, timeZone);
          const dayKey = formatDayKey(day, timeZone);
          const hasSchedule = HashSet.has(scheduledDays, dayKey);

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
              <span className="text-sm font-medium">{formatDayOfMonth(day, timeZone)}</span>
              {hasSchedule && <div className="mt-1 w-1.5 h-1.5 rounded-full bg-[#33ccbb]" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
