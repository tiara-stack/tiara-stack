import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { DateTime, HashSet, Effect, Array } from "effect";
import { AnimatePresence, motion, useIsPresent } from "motion/react";

import { ensureResultAtomData } from "#/lib/atomRegistry";
import { useScheduledDays, scheduledDaysAtom, formatDayKey } from "#/lib/schedule";
import { useCalendarDays, calendarDaysAtom } from "#/lib/calendar";
import { getServerTimeZone, useTimeZone } from "#/hooks/useTimeZone";
import { makeZoned, useZoned } from "#/hooks/useDateTimeZoned";
import {
  buildSharedDayLayoutId,
  calendarRestTransition,
  monthSlideTransition,
  morphLayoutTransition,
  useScheduleMonthDirection,
  useScheduleSelected,
  useScheduleTransitionStates,
} from "./-transition";
import { useLocked } from "#/hooks/useLocked";
import { makeDateTime, useDateTime } from "#/hooks/useDateTime";
import { cn } from "#/lib/utils";

export const Route = createFileRoute(
  "/_authenticated/dashboard/guilds/$guildId/schedule/$channel/_channelLayout/calendar",
)({
  component: CalendarPage,
  pendingComponent: CalendarPendingPage,
  ssr: "data-only", // Prevent component SSR to avoid timezone-based content flash
  loaderDeps: ({ search }) => ({ timestamp: search.timestamp }),
  loader: async ({ context, params, deps }) => {
    const timeZone = getServerTimeZone(); // Match useTimeZone behavior during SSR
    const currentDate = makeDateTime(deps.timestamp);
    const currentDateZoned = makeZoned(timeZone, currentDate);

    const calendarDays = await Effect.runPromise(
      ensureResultAtomData(context.atomRegistry, calendarDaysAtom(currentDateZoned)),
    );

    const rangeStart = Array.headNonEmpty(calendarDays).day;
    const rangeEnd = DateTime.endOf(Array.lastNonEmpty(calendarDays).day, "day");

    await Effect.runPromise(
      ensureResultAtomData(
        context.atomRegistry,
        scheduledDaysAtom({
          guildId: params.guildId,
          channel: params.channel,
          timeZone,
          rangeStart,
          rangeEnd,
        }),
      ).pipe(Effect.catch(() => Effect.succeed(HashSet.empty<string>()))),
    );
  },
});

function CalendarPendingPage() {
  const { guildId, channel } = Route.useParams();
  const timeZone = useTimeZone();
  const search = Route.useSearch();
  const selected = useScheduleSelected(search);
  const currentDate = useDateTime(search.timestamp);
  const currentDateZoned = useZoned(timeZone, currentDate);
  const currentMonth = DateTime.startOf(currentDateZoned, "month");
  const prevMonthTimestamp = DateTime.toEpochMillis(
    DateTime.startOf(DateTime.subtract(currentDateZoned, { months: 1 }), "month"),
  );
  const nextMonthTimestamp = DateTime.toEpochMillis(
    DateTime.startOf(DateTime.add(currentDateZoned, { months: 1 }), "month"),
  );
  const selectedLayoutId = selected
    ? buildSharedDayLayoutId(selected.day, selected.month)
    : undefined;

  return (
    <div className="relative overflow-hidden border border-[#33ccbb]/20 bg-[#0f1615]">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={calendarRestTransition}
      >
        <div className="grid grid-cols-[auto_1fr_auto] items-center border-b border-[#33ccbb]/20 p-4">
          <Link
            to="."
            params={{ guildId, channel }}
            search={{
              timestamp: prevMonthTimestamp,
              from: {
                view: "calendar",
                timestamp: DateTime.toEpochMillis(DateTime.startOf(currentDateZoned, "month")),
              },
            }}
            mask={{
              to: "/dashboard/guilds/$guildId/schedule/$channel/calendar",
              params: { guildId, channel },
              search: { timestamp: prevMonthTimestamp },
              unmaskOnReload: true,
            }}
            className="grid h-9 w-9 place-items-center text-[#33ccbb] transition-colors hover:bg-[#33ccbb]/10"
          >
            <ChevronLeft className="h-5 w-5" />
          </Link>
          <div className="mx-auto h-6 w-36 rounded bg-[#33ccbb]/10" />
          <Link
            to="."
            params={{ guildId, channel }}
            search={{
              timestamp: nextMonthTimestamp,
              from: {
                view: "calendar",
                timestamp: DateTime.toEpochMillis(DateTime.startOf(currentDateZoned, "month")),
              },
            }}
            mask={{
              to: "/dashboard/guilds/$guildId/schedule/$channel/calendar",
              params: { guildId, channel },
              search: { timestamp: nextMonthTimestamp },
              unmaskOnReload: true,
            }}
            className="justify-self-end grid h-9 w-9 place-items-center text-[#33ccbb] transition-colors hover:bg-[#33ccbb]/10"
          >
            <ChevronRight className="h-5 w-5" />
          </Link>
        </div>

        <div className="grid grid-cols-7 border-b border-[#33ccbb]/20">
          {["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((day) => (
            <div
              key={day}
              className="p-3 text-center text-xs font-bold tracking-wider text-[#33ccbb]/60"
            >
              {day}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7">
          {Array.makeBy(42, (index) => {
            const day = DateTime.add(DateTime.startOf(currentMonth, "week", { weekStartsOn: 0 }), {
              days: index,
            });
            const layoutId =
              selected &&
              DateTime.Equivalence(selected.day, DateTime.startOf(day, "day")) &&
              DateTime.Equivalence(selected.month, currentMonth)
                ? selectedLayoutId
                : undefined;

            return (
              <motion.div
                key={index}
                layoutId={layoutId}
                transition={{
                  layout: morphLayoutTransition,
                }}
                className="h-14 border-r border-b border-[#33ccbb]/10 last:border-r-0"
              >
                <Link
                  to="/dashboard/guilds/$guildId/schedule/$channel/daily"
                  params={{ guildId, channel }}
                  search={{
                    timestamp: DateTime.toEpochMillis(day),
                    from: { view: "calendar", timestamp: DateTime.toEpochMillis(currentMonth) },
                  }}
                  mask={{
                    to: "/dashboard/guilds/$guildId/schedule/$channel/daily",
                    params: { guildId, channel },
                    search: { timestamp: DateTime.toEpochMillis(day) },
                    unmaskOnReload: true,
                  }}
                  className={cn(
                    "flex h-full flex-col items-center justify-center gap-1 transition-colors",
                    layoutId !== undefined && selectedLayoutId === layoutId
                      ? "bg-[#33ccbb]/12"
                      : "",
                  )}
                >
                  <div className="h-4 w-4 rounded bg-[#33ccbb]/10" />
                  <div
                    className={cn(
                      "h-1.5 rounded-full bg-[#33ccbb]/20",
                      index % 5 === 0 ? "w-4" : "w-1.5",
                    )}
                  />
                </Link>
              </motion.div>
            );
          })}
        </div>
      </motion.div>
    </div>
  );
}

// Get month name and year separately for animated display
function getMonthYearParts(dateTime: DateTime.Zoned): { month: string; year: string } {
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
  return { month: monthNames[parts.month - 1], year: String(parts.year) };
}

// Format day of month for display
function formatDayOfMonth(dateTime: DateTime.Zoned): string {
  const parts = DateTime.toParts(dateTime);
  return String(parts.day);
}

// Inner component that handles positioning based on presence state
function SlidingTextInner({
  text,
  direction,
  className,
}: {
  text: string;
  direction: -1 | 0 | 1;
  className?: string;
}) {
  const isPresent = useIsPresent();
  const exitDirection = useLocked(direction);

  return (
    <motion.span
      initial={direction === 0 ? false : { y: direction > 0 ? "100%" : "-100%", opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={
        exitDirection === 0 ? undefined : { y: exitDirection > 0 ? "-100%" : "100%", opacity: 0 }
      }
      transition={monthSlideTransition}
      className={className}
      style={isPresent ? { display: "block" } : { position: "absolute", inset: 0 }}
    >
      {text}
    </motion.span>
  );
}

// Animated text that slides in/out when content changes
function SlidingText({
  text,
  direction,
  className,
}: {
  text: string;
  direction: -1 | 0 | 1;
  className?: string;
}) {
  return (
    <div className="relative h-[1lh] overflow-hidden">
      <AnimatePresence initial={false} mode="sync">
        <SlidingTextInner key={text} text={text} direction={direction} className={className} />
      </AnimatePresence>
    </div>
  );
}

function DayGridPresenceShell({
  children,
  direction,
  onEnterComplete,
}: {
  children: React.ReactNode;
  direction: -1 | 0 | 1;
  onEnterComplete?: () => void;
}) {
  const isPresent = useIsPresent();
  const exitDirection = useLocked(direction);

  return (
    <motion.div
      initial={
        direction === 0
          ? false
          : {
              y: direction > 0 ? "100%" : "-100%",
              opacity: 0,
            }
      }
      animate={{ y: 0, opacity: 1 }}
      exit={
        exitDirection === 0 ? undefined : { y: exitDirection > 0 ? "-100%" : "100%", opacity: 0 }
      }
      transition={monthSlideTransition}
      className={isPresent ? "relative w-full" : "absolute inset-0 w-full"}
      style={{ pointerEvents: isPresent ? undefined : "none" }}
      onAnimationComplete={() => {
        // Only fire onEnterComplete for enter animations (when isPresent is true)
        // Exit animations also trigger onAnimationComplete, which would cause double invocation
        if (isPresent && onEnterComplete) {
          onEnterComplete();
        }
      }}
    >
      {children}
    </motion.div>
  );
}

function CalendarPage() {
  const { guildId, channel } = Route.useParams();
  const timeZone = useTimeZone();
  const search = Route.useSearch();

  const selected = useScheduleSelected(search);
  const monthDirection = useScheduleMonthDirection(search);
  const {
    isTransitioningToDaily,
    isTransitioningToCalendar,
    isCalendarLocked,
    clearScheduleTransitionState,
  } = useScheduleTransitionStates(search, "calendar");
  // Use timestamp to determine the month to display
  const currentDate = useDateTime(search.timestamp);
  const currentDateZoned = useZoned(timeZone, currentDate);
  const currentMonthKey = formatDayKey(DateTime.startOf(currentDateZoned, "month"));

  // Pre-computed timestamps for prev/next month navigation
  const prevMonthTimestamp = useMemo(
    () =>
      DateTime.toEpochMillis(
        DateTime.startOf(DateTime.subtract(currentDateZoned, { months: 1 }), "month"),
      ),
    [currentDateZoned],
  );
  const nextMonthTimestamp = useMemo(
    () =>
      DateTime.toEpochMillis(
        DateTime.startOf(DateTime.add(currentDateZoned, { months: 1 }), "month"),
      ),
    [currentDateZoned],
  );

  const { month, year } = getMonthYearParts(currentDateZoned);
  const weekDays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

  return (
    <div className="relative overflow-hidden border border-[#33ccbb]/20 bg-[#0f1615]">
      {/* Month header: static buttons, only month/year text slides */}
      <motion.div
        initial={isTransitioningToCalendar ? { opacity: 0 } : false}
        animate={{ opacity: isTransitioningToDaily ? 0 : 1 }}
        transition={calendarRestTransition}
        style={{ pointerEvents: isCalendarLocked ? "none" : undefined }}
        className={`relative bg-[#0f1615] ${isTransitioningToDaily ? "z-0" : "z-10"}`}
      >
        <div className="grid grid-cols-[auto_1fr_auto] items-center border-b border-[#33ccbb]/20 p-4">
          <Link
            to="."
            params={{ guildId, channel }}
            search={{
              timestamp: prevMonthTimestamp,
              from: {
                view: "calendar",
                timestamp: DateTime.toEpochMillis(DateTime.startOf(currentDateZoned, "month")),
              },
            }}
            mask={{
              to: "/dashboard/guilds/$guildId/schedule/$channel/calendar",
              params: { guildId, channel },
              search: { timestamp: prevMonthTimestamp },
              unmaskOnReload: true,
            }}
            className="justify-self-start p-2 text-[#33ccbb] transition-colors hover:bg-[#33ccbb]/10"
          >
            <ChevronLeft className="h-5 w-5" />
          </Link>
          <h3 className="flex items-center justify-center gap-2 text-center text-lg font-black tracking-tight">
            <SlidingText text={month} direction={monthDirection} />
            <SlidingText text={year} direction={monthDirection} />
          </h3>
          <Link
            to="."
            params={{ guildId, channel }}
            search={{
              timestamp: nextMonthTimestamp,
              from: {
                view: "calendar",
                timestamp: DateTime.toEpochMillis(DateTime.startOf(currentDateZoned, "month")),
              },
            }}
            mask={{
              to: "/dashboard/guilds/$guildId/schedule/$channel/calendar",
              params: { guildId, channel },
              search: { timestamp: nextMonthTimestamp },
              unmaskOnReload: true,
            }}
            className="justify-self-end p-2 text-[#33ccbb] transition-colors hover:bg-[#33ccbb]/10"
          >
            <ChevronRight className="h-5 w-5" />
          </Link>
        </div>
      </motion.div>

      {/* Weekday header: fade only during daily nav, static during month slide */}
      <motion.div
        animate={{ opacity: isTransitioningToDaily ? 0 : 1 }}
        transition={calendarRestTransition}
        className={`relative grid grid-cols-7 border-b border-[#33ccbb]/20 bg-[#0f1615] ${isTransitioningToDaily ? "z-0" : "z-10"}`}
      >
        {weekDays.map((day) => (
          <div
            key={day}
            className="p-3 text-center text-xs font-bold tracking-wider text-[#33ccbb]/60"
          >
            {day}
          </div>
        ))}
      </motion.div>

      <div className={`relative ${isTransitioningToDaily ? "z-20" : "z-0"}`}>
        <AnimatePresence initial={false} mode="sync">
          {/* Day grid: slide up/down + cells handle morph + conditional fade */}
          <DayGridPresenceShell
            key={`grid-${currentMonthKey}`}
            direction={monthDirection}
            onEnterComplete={() => {
              // Clear from param after month slide completes
              if (monthDirection !== 0) {
                clearScheduleTransitionState();
              }
            }}
          >
            <CalendarGrid currentDateZoned={currentDateZoned} selected={selected} />
          </DayGridPresenceShell>
        </AnimatePresence>
      </div>
    </div>
  );
}

interface CalendarGridProps {
  currentDateZoned: DateTime.Zoned;
  selected: { readonly day: DateTime.Zoned; readonly month: DateTime.Zoned } | undefined;
}

function CalendarGrid({ currentDateZoned, selected }: CalendarGridProps) {
  const { guildId, channel } = Route.useParams();
  const timeZone = useTimeZone();
  const search = Route.useSearch();
  const {
    isTransitioningToDaily,
    isTransitioningToCalendar,
    isCalendarLocked,
    clearScheduleTransitionState,
  } = useScheduleTransitionStates(search, "calendar");

  const calendarDays = useCalendarDays(currentDateZoned);

  // Get the date range for the calendar view in milliseconds
  const rangeStart = useMemo(() => Array.headNonEmpty(calendarDays).day, [calendarDays]);

  const rangeEnd = useMemo(
    () => DateTime.endOf(Array.lastNonEmpty(calendarDays).day, "day"),
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

  const currentMonth = useMemo(
    () => DateTime.startOf(currentDateZoned, "month"),
    [currentDateZoned],
  );

  return (
    <div
      className="grid grid-cols-7"
      style={{ pointerEvents: isCalendarLocked ? "none" : undefined }}
    >
      {calendarDays.map(({ day, isInMonth }) => {
        const dayKey = formatDayKey(day);
        const hasSchedule = HashSet.has(scheduledDays, dayKey);
        const sharedLayoutId = buildSharedDayLayoutId(day, currentMonth);
        const isSelectedDay =
          selected &&
          DateTime.Equivalence(selected.day, DateTime.startOf(day, "day")) &&
          DateTime.Equivalence(selected.month, currentMonth);

        return (
          <motion.div
            key={sharedLayoutId}
            layoutId={sharedLayoutId}
            onLayoutAnimationComplete={() => {
              if (isTransitioningToCalendar && isSelectedDay) {
                clearScheduleTransitionState();
              }
            }}
            initial={isTransitioningToCalendar && !isSelectedDay ? { opacity: 0 } : false}
            animate={{ opacity: isTransitioningToDaily && !isSelectedDay ? 0 : 1 }}
            transition={{
              ...calendarRestTransition,
              layout: morphLayoutTransition,
            }}
            style={{ pointerEvents: isCalendarLocked ? "none" : undefined }}
            className={`
              border-r border-b border-[#33ccbb]/10 last:border-r-0
              ${isInMonth ? "text-white" : "text-white/30"}
              ${hasSchedule ? "bg-[#33ccbb]/5" : ""}
              ${isSelectedDay ? "relative z-20" : ""}
            `}
          >
            <Link
              to="/dashboard/guilds/$guildId/schedule/$channel/daily"
              params={{ guildId, channel }}
              search={{
                timestamp: DateTime.toEpochMillis(day),
                from: { view: "calendar", timestamp: DateTime.toEpochMillis(currentMonth) },
              }}
              mask={{
                to: "/dashboard/guilds/$guildId/schedule/$channel/daily",
                params: { guildId, channel },
                search: { timestamp: DateTime.toEpochMillis(day) },
                unmaskOnReload: true,
              }}
              className={`
                h-14 p-1 flex flex-col items-center justify-center
                transition-colors
                ${isInMonth ? "hover:bg-[#33ccbb]/10" : ""}
              `}
            >
              <span className="text-sm font-medium">{formatDayOfMonth(day)}</span>
              {hasSchedule && <div className="mt-1 h-1.5 w-1.5 rounded-full bg-[#33ccbb]" />}
            </Link>
          </motion.div>
        );
      })}
    </div>
  );
}
