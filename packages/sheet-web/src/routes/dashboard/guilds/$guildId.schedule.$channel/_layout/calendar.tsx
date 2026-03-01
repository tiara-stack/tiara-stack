import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, Suspense } from "react";
import { DateTime, HashSet, Effect, Array } from "effect";
import { Registry } from "@effect-atom/atom-react";
import { useScheduledDays, scheduledDaysAtom, formatDayKey } from "#/lib/schedule";
import { getServerTimeZone, useTimeZone } from "#/hooks/useTimeZone";
import { makeZoned, useZoned } from "#/lib/date";

export const Route = createFileRoute(
  "/dashboard/guilds/$guildId/schedule/$channel/_layout/calendar",
)({
  component: CalendarPage,
  ssr: "data-only", // Prevent component SSR to avoid timezone-based content flash
  loaderDeps: ({ search }) => ({ timestamp: search.timestamp }),
  loader: async ({ context, params, deps }) => {
    const timeZone = getServerTimeZone(); // Match useTimeZone behavior during SSR
    const currentDate = await Effect.runPromise(makeZoned(timeZone, deps.timestamp));

    const monthStartZoned = DateTime.startOf(currentDate, "month");
    const monthEndZoned = DateTime.endOf(currentDate, "month");
    const calendarStart = DateTime.startOf(monthStartZoned, "week", { weekStartsOn: 0 });
    const calendarEnd = DateTime.endOf(monthEndZoned, "week", { weekStartsOn: 0 });

    await Effect.runPromise(
      Registry.getResult(
        context.atomRegistry,
        scheduledDaysAtom({
          guildId: params.guildId,
          channel: params.channel,
          timeZone,
          rangeStart: calendarStart,
          rangeEnd: calendarEnd,
        }),
      ).pipe(Effect.catchAll(() => Effect.succeed(HashSet.empty<string>()))),
    );
  },
});

// Helper to get all days in a calendar grid (including padding days from prev/next month)
function getCalendarDays(dateTime: DateTime.Zoned) {
  const monthStart = DateTime.startOf(dateTime, "month");
  const monthEnd = DateTime.endOf(dateTime, "month");
  const calendarStart = DateTime.startOf(monthStart, "week", { weekStartsOn: 0 });
  // calendarEnd is the last moment of the day (e.g., 23:59:59.999), while current
  // starts at midnight (00:00:00) each day. This ensures the last day is included
  // regardless of whether DateTime.between is inclusive or exclusive on the maximum.
  const calendarEnd = DateTime.endOf(monthEnd, "week", { weekStartsOn: 0 });

  const days: DateTime.Zoned[] = [];
  let current = calendarStart;

  while (DateTime.between(current, { minimum: calendarStart, maximum: calendarEnd })) {
    days.push(current);
    current = DateTime.add(current, { days: 1 });
  }
  return days as [DateTime.Zoned, ...DateTime.Zoned[]];
}

// Format month/year for display (e.g., "FEBRUARY 2026")
function formatMonthYear(dateTime: DateTime.Zoned): string {
  const parts = DateTime.toParts(dateTime);
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
function formatDayOfMonth(dateTime: DateTime.Zoned): string {
  const parts = DateTime.toParts(dateTime);
  return String(parts.day);
}

// Check if two dates are in the same month
function isSameMonth(a: DateTime.Zoned, b: DateTime.Zoned): boolean {
  const partsA = DateTime.toParts(a);
  const partsB = DateTime.toParts(b);
  return partsA.year === partsB.year && partsA.month === partsB.month;
}

function CalendarPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <div className="text-white/60 font-medium tracking-wide">LOADING CALENDAR...</div>
        </div>
      }
    >
      <CalendarView />
    </Suspense>
  );
}

function CalendarView() {
  const { guildId, channel } = Route.useParams();
  const search = Route.useSearch();

  const timeZone = useTimeZone();
  const navigate = useNavigate();

  // Use timestamp to determine the month to display
  const currentDate = useZoned(timeZone, search.timestamp);

  const calendarDays = useMemo(() => {
    return getCalendarDays(currentDate);
  }, [currentDate]);

  // Get the date range for the calendar view in milliseconds
  const rangeStart = useMemo(() => Array.headNonEmpty(calendarDays), [calendarDays]);

  const rangeEnd = useMemo(
    () => DateTime.endOf(Array.lastNonEmpty(calendarDays), "day"),
    [calendarDays],
  );

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
    const prevMonthZoned = DateTime.subtract(currentDate, { months: 1 });
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
    const nextMonthZoned = DateTime.add(currentDate, { months: 1 });
    const nextMonthStartZoned = DateTime.startOf(nextMonthZoned, "month");
    navigate({
      to: ".",
      params: { guildId, channel },
      search: {
        timestamp: DateTime.toEpochMillis(nextMonthStartZoned),
      },
    });
  };

  const handleDayClick = (day: DateTime.Zoned) => {
    const dayTimestamp = DateTime.toEpochMillis(DateTime.startOf(day, "day"));
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
        <h3 className="text-lg font-black tracking-tight">{formatMonthYear(currentDate)}</h3>
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
        {calendarDays.map((day) => {
          const isCurrentMonth = isSameMonth(day, currentDate);
          const dayKey = formatDayKey(day);
          const hasSchedule = HashSet.has(scheduledDays, dayKey);

          return (
            <button
              key={DateTime.toEpochMillis(day)}
              onClick={() => handleDayClick(day)}
              className={`
                aspect-square p-2 flex flex-col items-center justify-center
                border-r border-b border-[#33ccbb]/10 last:border-r-0
                transition-colors
                ${isCurrentMonth ? "text-white hover:bg-[#33ccbb]/10" : "text-white/30"}
                ${hasSchedule ? "bg-[#33ccbb]/5" : ""}
              `}
            >
              <span className="text-sm font-medium">{formatDayOfMonth(day)}</span>
              {hasSchedule && <div className="mt-1 w-1.5 h-1.5 rounded-full bg-[#33ccbb]" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
