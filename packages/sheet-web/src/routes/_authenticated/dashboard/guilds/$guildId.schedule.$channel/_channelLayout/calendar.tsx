import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { DateTime, HashSet, Effect, Array } from "effect";
import { AnimatePresence, motion, useIsPresent } from "motion/react";

import { ensureResultAtomData, isBrowserRuntime } from "#/lib/atomRegistry";
import { useScheduledDays, scheduledDaysAtom, formatDayKey } from "#/lib/schedule";
import { useCalendarDays, calendarDaysAtom } from "#/lib/calendar";
import { getServerTimeZone, useTimeZone } from "#/hooks/useTimeZone";
import { makeZoned, useZoned, zoneId } from "#/hooks/useDateTimeZoned";
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
    if (!isBrowserRuntime()) return;
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

interface CalendarMonthArrowProps {
  guildId: string;
  channel: string;
  currentDateZoned: DateTime.Zoned;
  timestamp: number;
  direction: "previous" | "next";
  compact: boolean;
}

const CALENDAR_DAY_LABEL_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function formatCalendarDayLabel(dateTime: DateTime.Zoned): string {
  const parts = DateTime.toParts(dateTime);
  return `${CALENDAR_DAY_LABEL_MONTHS[parts.month - 1]!} ${parts.day}, ${parts.year}`;
}

function CalendarMonthArrow({
  guildId,
  channel,
  currentDateZoned,
  timestamp,
  direction,
  compact,
}: CalendarMonthArrowProps) {
  const currentMonthTimestamp = DateTime.toEpochMillis(DateTime.startOf(currentDateZoned, "month"));
  const isPrevious = direction === "previous";

  return (
    <Link
      to="."
      params={{ guildId, channel }}
      search={{
        timestamp,
        from: { view: "calendar", timestamp: currentMonthTimestamp },
      }}
      mask={{
        to: "/dashboard/guilds/$guildId/schedule/$channel/calendar",
        params: { guildId, channel },
        search: { timestamp },
        unmaskOnReload: true,
      }}
      className={cn(
        "place-items-center text-[#33ccbb] transition-colors hover:bg-[#33ccbb]/10",
        compact ? "grid h-9 w-9" : "p-2",
        isPrevious ? "justify-self-start" : "justify-self-end",
      )}
      aria-label={`${isPrevious ? "Previous" : "Next"} month`}
    >
      {isPrevious ? <ChevronLeft className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
    </Link>
  );
}

function CalendarMonthNavigation({
  guildId,
  channel,
  currentDateZoned,
  prevMonthTimestamp,
  nextMonthTimestamp,
  children,
  compact = false,
}: {
  guildId: string;
  channel: string;
  currentDateZoned: DateTime.Zoned;
  prevMonthTimestamp: number;
  nextMonthTimestamp: number;
  children: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center border-b border-[#33ccbb]/20 p-4">
      <CalendarMonthArrow
        guildId={guildId}
        channel={channel}
        currentDateZoned={currentDateZoned}
        timestamp={prevMonthTimestamp}
        direction="previous"
        compact={compact}
      />
      {children}
      <CalendarMonthArrow
        guildId={guildId}
        channel={channel}
        currentDateZoned={currentDateZoned}
        timestamp={nextMonthTimestamp}
        direction="next"
        compact={compact}
      />
    </div>
  );
}

function CalendarDayLink({
  guildId,
  channel,
  day,
  currentMonth,
  className,
  children,
}: {
  guildId: string;
  channel: string;
  day: DateTime.Zoned;
  currentMonth: DateTime.Zoned;
  className: string;
  children: ReactNode;
}) {
  const dayTimestamp = DateTime.toEpochMillis(day);
  const monthTimestamp = DateTime.toEpochMillis(currentMonth);

  return (
    <Link
      to="/dashboard/guilds/$guildId/schedule/$channel/daily"
      params={{ guildId, channel }}
      search={{
        timestamp: dayTimestamp,
        from: { view: "calendar", timestamp: monthTimestamp },
      }}
      mask={{
        to: "/dashboard/guilds/$guildId/schedule/$channel/daily",
        params: { guildId, channel },
        search: { timestamp: dayTimestamp },
        unmaskOnReload: true,
      }}
      className={className}
      aria-label={`View schedule for ${formatCalendarDayLabel(day)}`}
    >
      {children}
    </Link>
  );
}

function getMonthSlideMotionProps(direction: -1 | 0 | 1, exitDirection: -1 | 0 | 1) {
  return {
    initial: direction === 0 ? false : { y: direction > 0 ? "100%" : "-100%", opacity: 0 },
    animate: { y: 0, opacity: 1 },
    ...(exitDirection === 0
      ? {}
      : { exit: { y: exitDirection > 0 ? "-100%" : "100%", opacity: 0 } }),
    transition: monthSlideTransition,
  };
}

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
        <CalendarMonthNavigation
          guildId={guildId}
          channel={channel}
          currentDateZoned={currentDateZoned}
          prevMonthTimestamp={prevMonthTimestamp}
          nextMonthTimestamp={nextMonthTimestamp}
          compact
        >
          <div className="mx-auto h-6 w-36 rounded bg-[#33ccbb]/10" />
        </CalendarMonthNavigation>

        <CalendarContext timeZone={timeZone} />

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
                {...(layoutId === undefined ? {} : { layoutId })}
                transition={{
                  layout: morphLayoutTransition,
                }}
                className="h-14 border-r border-b border-[#33ccbb]/10 last:border-r-0"
              >
                <CalendarDayLink
                  guildId={guildId}
                  channel={channel}
                  day={day}
                  currentMonth={currentMonth}
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
                </CalendarDayLink>
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
  return { month: monthNames[parts.month - 1]!, year: String(parts.year) };
}

function CalendarContext({ timeZone }: { readonly timeZone: DateTime.TimeZone }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#33ccbb]/20 bg-[#0f1615] px-4 py-2 text-[10px] font-bold tracking-wide text-white/50">
      <span className="flex items-center gap-2">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#33ccbb]" />
        SCHEDULED DAYS
      </span>
      <span>TIME ZONE: {zoneId(timeZone)}</span>
    </div>
  );
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
      {...getMonthSlideMotionProps(direction, exitDirection)}
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
        <SlidingTextInner
          key={text}
          text={text}
          direction={direction}
          {...(className === undefined ? {} : { className })}
        />
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
      {...getMonthSlideMotionProps(direction, exitDirection)}
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
        <CalendarMonthNavigation
          guildId={guildId}
          channel={channel}
          currentDateZoned={currentDateZoned}
          prevMonthTimestamp={prevMonthTimestamp}
          nextMonthTimestamp={nextMonthTimestamp}
        >
          <h3 className="flex items-center justify-center gap-2 text-center text-lg font-black tracking-tight">
            <SlidingText text={month} direction={monthDirection} />
            <SlidingText text={year} direction={monthDirection} />
          </h3>
        </CalendarMonthNavigation>
      </motion.div>

      <CalendarContext timeZone={timeZone} />

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
            <CalendarDayLink
              guildId={guildId}
              channel={channel}
              day={day}
              currentMonth={currentMonth}
              className={`
                h-14 p-1 flex flex-col items-center justify-center
                transition-colors
                ${isInMonth ? "hover:bg-[#33ccbb]/10" : ""}
              `}
            >
              <span className="text-sm font-medium">{formatDayOfMonth(day)}</span>
              {hasSchedule && <div className="mt-1 h-1.5 w-1.5 rounded-full bg-[#33ccbb]" />}
            </CalendarDayLink>
          </motion.div>
        );
      })}
    </div>
  );
}
