import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarDays, ChevronLeft } from "lucide-react";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion } from "motion/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { DateTime, Option, Effect, pipe, HashMap, Array, Duration, Predicate } from "effect";

import { ensureResultAtomData, isBrowserRuntime } from "#/lib/atomRegistry";
import {
  type SchedulePlayer,
  guildScheduleAtom,
  useGuildSchedule,
  computeScheduleHour,
  formatDayKey,
} from "#/lib/schedule";
import * as Schedule from "#/lib/scheduleValues";
import { eventConfigAtom, useEventConfig } from "#/lib/sheet";
import { useNowByHour } from "#/lib/dateTime";
import { useDateTime } from "#/hooks/useDateTime";
import { useTimeZone } from "#/hooks/useTimeZone";
import { useZoned, zoneId } from "#/hooks/useDateTimeZoned";
import { cn } from "#/lib/utils";
import { currentUserAtom, useCurrentUser } from "#/lib/discord";
import { useHydrated } from "#/hooks/useHydrated";
import {
  buildSharedDayLayoutId,
  calendarRestTransition,
  morphLayoutTransition,
  useScheduleSelected,
} from "./-transition";
import { classifyDailyHourSchedules, getDailyHourSchedules } from "./-dailyRows";

// Virtualizer constants
const ESTIMATE_SIZE = 23 + 24 * 44;
const INITIAL_START_OFFSET = -10;
const INITIAL_END_OFFSET = 10;
const TOP_EDGE_THRESHOLD = 3;
const BOTTOM_EDGE_THRESHOLD = 3;
const isPlayer = Predicate.isTagged("Player");
const hasHour = <S extends { hour: Option.Option<number> }>(
  schedule: S,
): schedule is S & { hour: Option.Some<number> } => Option.isSome(schedule.hour);

export const Route = createFileRoute(
  "/_authenticated/dashboard/guilds/$guildId/schedule/$channel/_channelLayout/daily",
)({
  component: DailyPage,
  pendingComponent: DailyPendingPage,
  ssr: "data-only",
  loader: async ({ context, params }) => {
    if (!isBrowserRuntime()) return;
    await Effect.runPromise(
      Effect.all(
        [
          ensureResultAtomData(context.atomRegistry, guildScheduleAtom(params.guildId)),
          ensureResultAtomData(context.atomRegistry, eventConfigAtom(params.guildId)),
          ensureResultAtomData(context.atomRegistry, currentUserAtom),
        ],
        { concurrency: "unbounded" },
      ),
    );
  },
});

function useDailyScheduleView() {
  const timeZone = useTimeZone();
  const search = Route.useSearch();
  const selected = useScheduleSelected(search);
  const currentDate = useDateTime(search.timestamp);
  const currentDateZoned = useZoned(timeZone, currentDate);
  const sourceMonth = useMemo(
    () =>
      selected && DateTime.Equivalence(selected.day, DateTime.startOf(currentDateZoned, "day"))
        ? selected.month
        : DateTime.startOf(currentDateZoned, "month"),
    [selected, currentDateZoned],
  );

  return { currentDateZoned, sourceMonth };
}

function DailyScheduleFrame({
  currentDateZoned,
  sourceMonth,
  children,
}: {
  currentDateZoned: DateTime.Zoned;
  sourceMonth: DateTime.Zoned;
  children: ReactNode;
}) {
  const sharedLayoutId = buildSharedDayLayoutId(currentDateZoned, sourceMonth);

  return (
    <motion.div
      layoutId={sharedLayoutId}
      transition={{
        layout: morphLayoutTransition,
      }}
      className="border border-[#33ccbb]/20 bg-[#0a0f0e]"
    >
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={calendarRestTransition}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

function DailyCalendarLink({
  guildId,
  channel,
  currentDateZoned,
  sourceMonth,
  pending = false,
}: {
  guildId: string;
  channel: string;
  currentDateZoned: DateTime.Zoned;
  sourceMonth: DateTime.Zoned;
  pending?: boolean;
}) {
  const calendarTimestamp = DateTime.toEpochMillis(sourceMonth);
  const dailyTimestamp = DateTime.toEpochMillis(currentDateZoned);

  return (
    <Link
      aria-label={pending ? "Back to calendar" : undefined}
      className={
        pending
          ? "flex items-center gap-2 text-[#33ccbb] transition-colors hover:text-white"
          : "inline-flex min-h-11 items-center justify-center gap-2 border border-[#33ccbb]/30 bg-[#0a0f0e] px-3 text-xs font-black tracking-wide text-[#33ccbb] transition-colors hover:bg-[#33ccbb]/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc]"
      }
      to="/dashboard/guilds/$guildId/schedule/$channel/calendar"
      params={{ guildId, channel }}
      search={{
        timestamp: calendarTimestamp,
        from: { view: "daily", timestamp: dailyTimestamp },
      }}
      mask={{
        to: "/dashboard/guilds/$guildId/schedule/$channel/calendar",
        params: { guildId, channel },
        search: { timestamp: calendarTimestamp },
        unmaskOnReload: true,
      }}
    >
      {pending ? (
        <>
          <ChevronLeft aria-hidden="true" className="h-4 w-4" />
          <div aria-hidden="true" className="h-4 w-36 rounded bg-[#33ccbb]/12" />
        </>
      ) : (
        <>
          <CalendarDays aria-hidden="true" className="h-4 w-4" />
          CALENDAR
        </>
      )}
    </Link>
  );
}

function DailyPendingPage() {
  const { guildId, channel } = Route.useParams();
  const { currentDateZoned, sourceMonth } = useDailyScheduleView();

  return (
    <DailyScheduleFrame currentDateZoned={currentDateZoned} sourceMonth={sourceMonth}>
      <div className="flex items-center justify-between border-b border-[#33ccbb]/20 bg-[#0f1615] px-6 py-4">
        <DailyCalendarLink
          guildId={guildId}
          channel={channel}
          currentDateZoned={currentDateZoned}
          sourceMonth={sourceMonth}
          pending
        />
      </div>
      <div className="space-y-4 px-6 py-5">
        <div className="grid gap-3">
          {Array.makeBy(5, (index) => (
            <div
              key={index}
              className="overflow-hidden rounded border border-[#33ccbb]/12 bg-[#0f1615]"
            >
              <div className="border-b border-[#33ccbb]/10 px-4 py-3">
                <div
                  className={cn(
                    "h-4 rounded bg-[#33ccbb]/10",
                    index === 0 ? "w-40" : index % 2 === 0 ? "w-28" : "w-32",
                  )}
                />
              </div>
              <div className="space-y-3 px-4 py-4">
                {Array.makeBy(index === 0 ? 4 : 3, (rowIndex) => (
                  <div key={rowIndex} className="flex items-center gap-3">
                    <div className="h-8 w-14 rounded bg-[#33ccbb]/10" />
                    <div className="flex-1 space-y-2">
                      <div
                        className={cn(
                          "h-3 rounded bg-white/8",
                          rowIndex % 3 === 0 ? "w-11/12" : rowIndex % 3 === 1 ? "w-3/4" : "w-5/6",
                        )}
                      />
                      <div
                        className={cn(
                          "h-3 rounded bg-[#33ccbb]/8",
                          rowIndex % 2 === 0 ? "w-1/2" : "w-2/3",
                        )}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </DailyScheduleFrame>
  );
}

function DailyPage() {
  const hydrated = useHydrated();

  return hydrated ? <DailyPageContent /> : <DailyPendingPage />;
}

function DailyPageContent() {
  const { currentDateZoned, sourceMonth } = useDailyScheduleView();

  return (
    <DailyScheduleFrame currentDateZoned={currentDateZoned} sourceMonth={sourceMonth}>
      <DailyHeader sourceMonth={sourceMonth} currentDateZoned={currentDateZoned} />
      <DailyScheduleContent />
    </DailyScheduleFrame>
  );
}

// Header component
function DailyHeader({
  sourceMonth,
  currentDateZoned,
}: {
  sourceMonth: DateTime.Zoned;
  currentDateZoned: DateTime.Zoned;
}) {
  const { channel, guildId } = Route.useParams();
  const timeZone = useTimeZone();
  const nowByHour = useNowByHour(timeZone);
  const isToday = DateTime.Equivalence(
    DateTime.startOf(currentDateZoned, "day"),
    DateTime.startOf(nowByHour, "day"),
  );

  return (
    <div className="border-b border-[#33ccbb]/20 bg-[#0f1615] px-4 py-4 sm:px-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-lg font-black tracking-tight text-white">
            <span className="text-[#33ccbb]">{isToday ? "TODAY" : "DAILY SCHEDULE"}</span>
            <span aria-hidden="true" className="text-[#33ccbb]/40">
              /
            </span>
            <time dateTime={formatDayKey(currentDateZoned)}>
              {formatDailyDate(currentDateZoned)}
            </time>
          </h2>
          <p className="mt-1 text-[10px] font-bold tracking-[0.16em] text-white/50">
            LIVE SCHEDULE · {zoneId(timeZone)}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {!isToday ? (
            <Link
              className="inline-flex min-h-11 items-center justify-center gap-2 border border-[#33ccbb]/30 bg-[#0a0f0e] px-3 text-xs font-black tracking-wide text-[#33ccbb] transition-colors hover:bg-[#33ccbb]/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc]"
              to="/dashboard/guilds/$guildId/schedule/$channel/daily"
              params={{ guildId, channel }}
              search={{ timestamp: DateTime.toEpochMillis(nowByHour) }}
            >
              TODAY
            </Link>
          ) : null}
          <DailyCalendarLink
            guildId={guildId}
            channel={channel}
            currentDateZoned={currentDateZoned}
            sourceMonth={sourceMonth}
          />
        </div>
      </div>
    </div>
  );
}

const DAILY_WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const DAILY_MONTH_NAMES = [
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

function formatDailyDate(dateTime: DateTime.Zoned): string {
  const parts = DateTime.toParts(dateTime);
  return `${DAILY_WEEKDAY_NAMES[parts.weekDay]!}, ${DAILY_MONTH_NAMES[parts.month - 1]!} ${parts.day}, ${parts.year}`;
}

interface DailyOffsetRange {
  startOffset: number;
  endOffset: number;
}

interface DailyScrollAnchor {
  scrollHeight: number;
  scrollTop: number;
}

type DailyOffsetRangeSetter = Dispatch<SetStateAction<DailyOffsetRange>>;

function extendDailyRangeAtTop({
  firstItem,
  scrollElement,
  isPrependingRef,
  pendingPrependAnchorRef,
  setDayOffsetRange,
}: {
  firstItem: Option.Option<{ readonly index: number }>;
  scrollElement: HTMLDivElement | null;
  isPrependingRef: { current: boolean };
  pendingPrependAnchorRef: { current: DailyScrollAnchor | null };
  setDayOffsetRange: DailyOffsetRangeSetter;
}) {
  const isNearTop = Option.isSome(firstItem) && firstItem.value.index < TOP_EDGE_THRESHOLD;
  if (isNearTop) {
    if (!isPrependingRef.current) {
      isPrependingRef.current = true;
      pendingPrependAnchorRef.current = scrollElement
        ? {
            scrollHeight: scrollElement.scrollHeight,
            scrollTop: scrollElement.scrollTop,
          }
        : null;
      setDayOffsetRange((previous) => ({
        ...previous,
        startOffset: previous.startOffset + INITIAL_START_OFFSET,
      }));
    }
    return;
  }

  isPrependingRef.current = false;
}

function extendDailyRangeAtBottom({
  lastItem,
  virtualDaysLength,
  isAppendingRef,
  setDayOffsetRange,
}: {
  lastItem: Option.Option<{ readonly index: number }>;
  virtualDaysLength: number;
  isAppendingRef: { current: boolean };
  setDayOffsetRange: DailyOffsetRangeSetter;
}) {
  const isNearBottom =
    Option.isSome(lastItem) && lastItem.value.index >= virtualDaysLength - BOTTOM_EDGE_THRESHOLD;
  if (isNearBottom) {
    if (!isAppendingRef.current) {
      isAppendingRef.current = true;
      setDayOffsetRange((previous) => ({
        ...previous,
        endOffset: previous.endOffset + INITIAL_END_OFFSET,
      }));
    }
    return;
  }

  isAppendingRef.current = false;
}

// Main content - loads data and renders infinite scroll
function DailyScheduleContent() {
  const { channel, guildId } = Route.useParams();
  const currentUser = useCurrentUser();
  const timeZone = useTimeZone();
  const search = Route.useSearch();
  const parentRef = useRef<HTMLDivElement>(null);
  const currentHourKey = useNowByHour(timeZone);

  const currentDate = useDateTime(search.timestamp);
  const currentDateZoned = useZoned(timeZone, currentDate);

  // Load schedules and eventConfig
  const allSchedules = useGuildSchedule(guildId);
  const eventConfig = useEventConfig(guildId);
  const startTimeZoned = useZoned(timeZone, eventConfig.startTime);
  const channelSchedules = useMemo(
    () => allSchedules.filter((s) => s.channel === channel).filter(hasHour),
    [allSchedules, channel],
  );

  const dayByScheduleHour = useMemo(() => {
    return pipe(
      channelSchedules,
      Array.reduce(HashMap.empty<number, number>(), (acc, schedule) => {
        const hour = schedule.hour.value;
        return HashMap.set(acc, hour, schedule.day);
      }),
    );
  }, [channelSchedules]);

  const maxScheduleHour = useMemo(() => {
    const hours = channelSchedules.map((s) => s.hour.value);
    return hours.length > 0 ? Math.max(...hours) : 0;
  }, [channelSchedules]);

  const visibleChannelSchedules = useMemo(
    () => channelSchedules.filter((schedule) => schedule.visible),
    [channelSchedules],
  );

  // Group schedules by date -> DateTime -> populated schedule variants[]
  const schedulesByDate = useMemo(() => {
    return pipe(
      visibleChannelSchedules,
      Array.reduce(
        HashMap.empty<
          DateTime.Zoned,
          HashMap.HashMap<DateTime.Zoned, Schedule.PopulatedScheduleResult[]>
        >(),
        (acc, schedule) => {
          if (Option.isNone(schedule.hourWindow)) {
            return acc;
          }

          const scheduleDateTime = DateTime.setZone(schedule.hourWindow.value.start, timeZone);
          const dateKey = DateTime.startOf(scheduleDateTime, "day");

          return HashMap.modifyAt(
            acc,
            dateKey,
            Option.match({
              onSome: (existingHourMap) =>
                Option.some(
                  HashMap.modifyAt(
                    existingHourMap,
                    scheduleDateTime,
                    Option.match({
                      onSome: (value) => Option.some([...value, schedule]),
                      onNone: () => Option.some([schedule]),
                    }),
                  ),
                ),
              onNone: () => Option.some(HashMap.make([scheduleDateTime, [schedule]])),
            }),
          );
        },
      ),
    );
  }, [timeZone, visibleChannelSchedules]);

  const currentDateKey = useMemo(
    () => DateTime.startOf(currentDateZoned, "day"),
    [currentDateZoned],
  );

  // Infinite scroll state
  const [dayOffsetRange, setDayOffsetRange] = useState<DailyOffsetRange>({
    startOffset: INITIAL_START_OFFSET,
    endOffset: INITIAL_END_OFFSET,
  });
  const pendingPrependAnchorRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const isPrependingRef = useRef(false);
  const isAppendingRef = useRef(false);

  // Generate virtual days based on range around target
  const virtualDays = useMemo(() => {
    const dayOffsetArray = Array.range(dayOffsetRange.startOffset, dayOffsetRange.endOffset);

    return Array.map(dayOffsetArray, (dayOffset) => {
      const dateKey = DateTime.startOf(
        dayOffset >= 0
          ? DateTime.addDuration(currentDateKey, Duration.days(dayOffset))
          : DateTime.subtractDuration(currentDateKey, Duration.days(-dayOffset)),
        "day",
      );
      const data = HashMap.get(schedulesByDate, dateKey);
      const schedulesByDateTime = Option.getOrElse(data, () =>
        HashMap.empty<DateTime.Zoned, Schedule.PopulatedScheduleResult[]>(),
      );

      return { dateKey, schedulesByDateTime };
    });
  }, [dayOffsetRange, currentDateKey, schedulesByDate]);

  const virtualizer = useVirtualizer({
    count: virtualDays.length,
    getScrollElement: () => parentRef.current,
    getItemKey: (index) => formatDayKey(virtualDays[index]!.dateKey),
    estimateSize: () => ESTIMATE_SIZE,
    initialOffset: -INITIAL_START_OFFSET * ESTIMATE_SIZE,
    overscan: 3,
  });

  useLayoutEffect(() => {
    const pendingPrependAnchor = pendingPrependAnchorRef.current;
    if (!pendingPrependAnchor) {
      isPrependingRef.current = false;
      return;
    }

    const scrollElement = parentRef.current;
    if (!scrollElement) {
      pendingPrependAnchorRef.current = null;
      isPrependingRef.current = false;
      return;
    }

    scrollElement.scrollTop =
      pendingPrependAnchor.scrollTop +
      (scrollElement.scrollHeight - pendingPrependAnchor.scrollHeight);
    pendingPrependAnchorRef.current = null;
  }, [dayOffsetRange.startOffset]);

  // Extend range when scrolling near edges (bidirectional infinite scroll)
  useEffect(() => {
    const virtualItems = virtualizer.getVirtualItems();
    if (virtualItems.length === 0) return;

    extendDailyRangeAtTop({
      firstItem: Array.head(virtualItems),
      scrollElement: parentRef.current,
      isPrependingRef,
      pendingPrependAnchorRef,
      setDayOffsetRange,
    });
    extendDailyRangeAtBottom({
      lastItem: Array.last(virtualItems),
      virtualDaysLength: virtualDays.length,
      isAppendingRef,
      setDayOffsetRange,
    });
  }, [virtualizer.getVirtualItems(), virtualDays.length]);

  return (
    <div ref={parentRef} className="h-[600px] overflow-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const dayData = virtualDays[virtualItem.index];
          if (Predicate.isUndefined(dayData)) {
            return null;
          }
          const isActive = DateTime.Equivalence(dayData.dateKey, currentDateKey);

          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualItem.size}px`,
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <DateBlock
                date={dayData.dateKey}
                schedulesByDateTime={dayData.schedulesByDateTime}
                isActive={isActive}
                startTimeZoned={startTimeZoned}
                scheduleStartHour={eventConfig.scheduleStartHour}
                maxHour={maxScheduleHour}
                dayByScheduleHour={dayByScheduleHour}
                currentUserId={currentUser.id}
                currentHourKey={currentHourKey}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Break Row Component - Full row for break hours
interface BreakRowProps {
  scheduleHour: Option.Option<number>;
  scheduleDay: Option.Option<number>;
  isScheduleDayBoundary: boolean;
  dateTimeParts: DateTime.DateTime.Parts;
  isDateTimeBoundary: boolean;
  isCurrentHour: boolean;
}

interface TimelineHourRowProps extends BreakRowProps {
  children: ReactNode;
  contentClassName?: string;
  dimmed?: boolean;
}

function TimelineScheduleDayLabel({
  scheduleDay,
  isScheduleDayBoundary,
  isCurrentHour,
}: Pick<BreakRowProps, "scheduleDay" | "isScheduleDayBoundary" | "isCurrentHour">) {
  if (Option.isNone(scheduleDay) || !isScheduleDayBoundary) {
    return null;
  }

  return (
    <span
      className={cn(
        "text-[9px] font-bold uppercase tracking-wider leading-none",
        isCurrentHour ? "text-[#041311]/65" : "text-[#33ccbb]/60",
      )}
    >
      Day {scheduleDay.value}
    </span>
  );
}

function TimelineScheduleHourLabel({
  scheduleHour,
  isCurrentHour,
}: Pick<BreakRowProps, "scheduleHour" | "isCurrentHour">) {
  if (Option.isNone(scheduleHour)) {
    return null;
  }

  return (
    <span
      className={cn(
        "text-sm font-bold tabular-nums leading-none",
        isCurrentHour ? "text-[#041311]" : "text-[#33ccbb]/80",
      )}
    >
      {scheduleHour.value}
    </span>
  );
}

function TimelineScheduleLabels({
  scheduleHour,
  scheduleDay,
  isScheduleDayBoundary,
  isCurrentHour,
  boundaryClassName,
}: Pick<
  BreakRowProps,
  "scheduleHour" | "scheduleDay" | "isScheduleDayBoundary" | "isCurrentHour"
> & {
  boundaryClassName: string | false;
}) {
  return (
    <div
      className={cn(
        "border-r p-3 min-h-[44px] flex flex-col items-end justify-center",
        isCurrentHour ? "border-[#041311]/15 bg-[#2fc0b2]" : "border-[#33ccbb]/10 bg-[#0f1615]/50",
        boundaryClassName,
      )}
    >
      <TimelineScheduleDayLabel
        scheduleDay={scheduleDay}
        isScheduleDayBoundary={isScheduleDayBoundary}
        isCurrentHour={isCurrentHour}
      />
      <TimelineScheduleHourLabel scheduleHour={scheduleHour} isCurrentHour={isCurrentHour} />
    </div>
  );
}

function TimelineDateLabel({
  dateTimeParts,
  isDateTimeBoundary,
  isCurrentHour,
}: Pick<BreakRowProps, "dateTimeParts" | "isDateTimeBoundary" | "isCurrentHour">) {
  return (
    <div className="w-20 shrink-0">
      {isDateTimeBoundary ? (
        <div className="flex flex-col leading-tight">
          <span
            className={cn(
              "text-xs font-black tabular-nums",
              isCurrentHour ? "text-[#041311]" : "text-white",
            )}
          >
            {dateTimeParts.day}
          </span>
          <span
            className={cn(
              "text-[9px] font-bold uppercase tracking-wider",
              isCurrentHour ? "text-[#041311]/70" : "text-[#33ccbb]",
            )}
          >
            {dateTimeParts.month}/{dateTimeParts.year}
          </span>
        </div>
      ) : (
        <span
          className={cn(
            "text-xs font-bold tabular-nums",
            isCurrentHour ? "text-[#041311]/80" : "text-white/40",
          )}
        >
          {String(dateTimeParts.hour).padStart(2, "0")}:00
        </span>
      )}
    </div>
  );
}

function TimelineHourRow({
  scheduleHour,
  scheduleDay,
  isScheduleDayBoundary,
  dateTimeParts,
  isDateTimeBoundary,
  isCurrentHour,
  children,
  contentClassName,
  dimmed = false,
}: TimelineHourRowProps) {
  const boundaryClassName =
    isDateTimeBoundary &&
    (isCurrentHour ? "border-t-2 border-t-[#041311]/15" : "border-t-2 border-t-[#33ccbb]/40");

  return (
    <div
      className={cn(
        "grid grid-cols-[140px_1fr] border-b border-[#33ccbb]/10 last:border-b-0",
        isCurrentHour ? "bg-[#33ccbb]" : dimmed && "opacity-40",
      )}
    >
      <TimelineScheduleLabels
        scheduleHour={scheduleHour}
        scheduleDay={scheduleDay}
        isScheduleDayBoundary={isScheduleDayBoundary}
        isCurrentHour={isCurrentHour}
        boundaryClassName={boundaryClassName}
      />

      <div className={cn("p-3 min-h-[44px] flex items-center gap-4", boundaryClassName)}>
        <TimelineDateLabel
          dateTimeParts={dateTimeParts}
          isDateTimeBoundary={isDateTimeBoundary}
          isCurrentHour={isCurrentHour}
        />

        <div className={cn("flex-1", contentClassName)}>{children}</div>
      </div>
    </div>
  );
}

function BreakRow({
  scheduleHour,
  scheduleDay,
  isScheduleDayBoundary,
  dateTimeParts,
  isDateTimeBoundary,
  isCurrentHour,
}: BreakRowProps) {
  return (
    <TimelineHourRow
      scheduleHour={scheduleHour}
      scheduleDay={scheduleDay}
      isScheduleDayBoundary={isScheduleDayBoundary}
      dateTimeParts={dateTimeParts}
      isDateTimeBoundary={isDateTimeBoundary}
      isCurrentHour={isCurrentHour}
      dimmed
    >
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "w-2 h-2 rounded-full",
            isCurrentHour ? "bg-[#041311]/35" : "bg-[#33ccbb]/30",
          )}
        />
        <span
          className={cn(
            "text-sm font-medium italic",
            isCurrentHour ? "text-[#041311]/80" : "text-white/40",
          )}
        >
          Break
        </span>
      </div>
    </TimelineHourRow>
  );
}

// Schedule Row Component - Full row for schedule hours
interface ScheduleHourRowProps extends BreakRowProps {
  schedules: Array.NonEmptyReadonlyArray<Schedule.PopulatedSchedule>;
  currentUserId: string | undefined;
}

function ScheduleHourRow({
  schedules,
  scheduleHour,
  scheduleDay,
  isScheduleDayBoundary,
  dateTimeParts,
  isDateTimeBoundary,
  currentUserId,
  isCurrentHour,
}: ScheduleHourRowProps) {
  return (
    <TimelineHourRow
      scheduleHour={scheduleHour}
      scheduleDay={scheduleDay}
      isScheduleDayBoundary={isScheduleDayBoundary}
      dateTimeParts={dateTimeParts}
      isDateTimeBoundary={isDateTimeBoundary}
      isCurrentHour={isCurrentHour}
      contentClassName="space-y-2"
    >
      {schedules.map((schedule, idx) => (
        <ScheduleRow
          key={idx}
          schedule={schedule}
          currentUserId={currentUserId}
          isCurrentHour={isCurrentHour}
        />
      ))}
    </TimelineHourRow>
  );
}

// Individual Day Block - Shows unified timeline with both schedule and actual date perspectives
type RowData =
  | {
      type: "break";
      key: number;
      scheduleHour: Option.Option<number>;
      scheduleDay: Option.Option<number>;
      isScheduleDayBoundary: boolean;
      dateTimeParts: DateTime.DateTime.Parts;
      isDateTimeBoundary: boolean;
      isCurrentHour: boolean;
    }
  | {
      type: "schedule";
      key: number;
      schedules: Array.NonEmptyReadonlyArray<Schedule.PopulatedSchedule>;
      scheduleHour: Option.Option<number>;
      scheduleDay: Option.Option<number>;
      isScheduleDayBoundary: boolean;
      dateTimeParts: DateTime.DateTime.Parts;
      isDateTimeBoundary: boolean;
      isCurrentHour: boolean;
    };

interface DateBlockProps {
  date: DateTime.Zoned;
  schedulesByDateTime: HashMap.HashMap<DateTime.Zoned, Schedule.PopulatedScheduleResult[]>;
  isActive: boolean;
  startTimeZoned: DateTime.Zoned;
  scheduleStartHour: number;
  maxHour: number;
  dayByScheduleHour: HashMap.HashMap<number, number>;
  currentUserId: string | undefined;
  currentHourKey: DateTime.DateTime;
}

function DateBlock({
  date,
  schedulesByDateTime,
  isActive,
  startTimeZoned,
  scheduleStartHour,
  maxHour,
  dayByScheduleHour,
  currentUserId,
  currentHourKey,
}: DateBlockProps) {
  // Build rows using dayByScheduleHour lookup for schedule day
  const rows: RowData[] = useMemo(
    () =>
      pipe(
        Array.range(0, 23),
        Array.map((dateHour, index) => {
          const dateTimeHour = DateTime.addDuration(date, Duration.hours(dateHour));
          const hourSchedules = Option.getOrElse(
            HashMap.get(schedulesByDateTime, dateTimeHour),
            () => [],
          );
          const dateTimeParts = DateTime.toParts(dateTimeHour);
          const isDateTimeBoundary = index === 0;
          const isCurrentHour = DateTime.Equivalence(dateTimeHour, currentHourKey);

          // Compute schedule hour from datetime using computeScheduleHour
          const scheduleHour = computeScheduleHour(
            startTimeZoned,
            dateTimeHour,
            maxHour,
            scheduleStartHour,
          );

          // Look up schedule day from dayByScheduleHour using scheduleHour
          const scheduleDay = Option.flatMap(scheduleHour, (hour) =>
            HashMap.get(dayByScheduleHour, hour),
          );

          // Determine if this is a schedule day boundary
          // It's a boundary if this hour has a schedule day and the previous hour has a different day or no day
          const isScheduleDayBoundary =
            Option.isSome(scheduleDay) &&
            Option.isSome(scheduleHour) &&
            pipe(
              HashMap.get(dayByScheduleHour, scheduleHour.value - 1),
              Option.map((prevDay) => prevDay !== scheduleDay.value),
              Option.getOrElse(() => true),
            );

          const rowType = classifyDailyHourSchedules(hourSchedules);

          if (rowType === "break") {
            return {
              type: "break",
              key: dateHour,
              scheduleHour,
              scheduleDay,
              isScheduleDayBoundary,
              dateTimeParts,
              isDateTimeBoundary,
              isCurrentHour,
            };
          }

          const schedules = getDailyHourSchedules(
            hourSchedules,
          ) as Array.NonEmptyReadonlyArray<Schedule.PopulatedSchedule>;

          return {
            type: "schedule",
            key: dateHour,
            schedules,
            scheduleHour,
            scheduleDay,
            isScheduleDayBoundary,
            dateTimeParts,
            isDateTimeBoundary,
            isCurrentHour,
          };
        }),
      ),
    [
      date,
      schedulesByDateTime,
      startTimeZoned,
      scheduleStartHour,
      maxHour,
      dayByScheduleHour,
      currentHourKey,
    ],
  );

  return (
    <div className={`border-b border-[#33ccbb]/30 ${isActive ? "bg-[#0f1615]" : "bg-[#0a0f0e]"}`}>
      {/* Schedule Rows - Each row shows one schedule hour with both perspectives */}
      <div>
        {rows.map((row) =>
          row.type === "break" ? (
            <BreakRow
              key={row.key}
              scheduleHour={row.scheduleHour}
              scheduleDay={row.scheduleDay}
              isScheduleDayBoundary={row.isScheduleDayBoundary}
              dateTimeParts={row.dateTimeParts}
              isDateTimeBoundary={row.isDateTimeBoundary}
              isCurrentHour={row.isCurrentHour}
            />
          ) : (
            <ScheduleHourRow
              key={row.key}
              schedules={row.schedules}
              scheduleHour={row.scheduleHour}
              scheduleDay={row.scheduleDay}
              isScheduleDayBoundary={row.isScheduleDayBoundary}
              dateTimeParts={row.dateTimeParts}
              isDateTimeBoundary={row.isDateTimeBoundary}
              currentUserId={currentUserId}
              isCurrentHour={row.isCurrentHour}
            />
          ),
        )}
      </div>
    </div>
  );
}

// Schedule Row Component - Shows only Fillers (callers must filter out break schedules)
function ScheduleRow({
  schedule,
  currentUserId,
  isCurrentHour,
}: {
  schedule: Schedule.PopulatedSchedule;
  currentUserId: string | undefined;
  isCurrentHour: boolean;
}) {
  const fills = schedule.fills.filter(Option.isSome).map((f: { value: SchedulePlayer }) => f.value);

  if (fills.length === 0) {
    return <div className="h-full" />;
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {fills.map((fill: SchedulePlayer, idx: number) => (
        <PlayerBadge
          key={idx}
          player={fill}
          currentUserId={currentUserId}
          isCurrentHour={isCurrentHour}
        />
      ))}
    </div>
  );
}

// Player Badge Component
const playerBadgeClassNames = {
  currentHour: {
    currentUser: {
      regular: "text-[#07211d] underline decoration-[#07211d]/45 underline-offset-2",
      encore: "font-black text-[#041311]",
    },
    other: {
      regular: "text-[#041311]/80",
      encore: "font-bold text-[#041311]",
    },
  },
  otherHour: {
    currentUser: {
      regular: "text-[#33ccbb]",
      encore: "font-bold text-[#33ccbb]",
    },
    other: {
      regular: "text-white/80",
      encore: "font-bold text-white",
    },
  },
} as const;

const playerEncoreClassNames = {
  currentHour: {
    currentUser: "text-[#07211d]/65",
    other: "text-[#041311]/60",
  },
  otherHour: {
    currentUser: "text-[#33ccbb]/70",
    other: "text-white/50",
  },
} as const;

function isCurrentPlayer(player: SchedulePlayer, currentUserId: string | undefined) {
  if (Predicate.isUndefined(currentUserId) || !isPlayer(player.player)) {
    return false;
  }

  return player.player.id === currentUserId;
}

function getPlayerBadgeClasses({
  isCurrentHour,
  isCurrentUser,
  isEncore,
}: {
  isCurrentHour: boolean;
  isCurrentUser: boolean;
  isEncore: boolean;
}) {
  const hourTone = isCurrentHour ? "currentHour" : "otherHour";
  const audience = isCurrentUser ? "currentUser" : "other";
  const fillTone = isEncore ? "encore" : "regular";

  return {
    badge: playerBadgeClassNames[hourTone][audience][fillTone],
    encore: playerEncoreClassNames[hourTone][audience],
  };
}

function PlayerEncore({ className }: { className: string }) {
  return <span className={cn("ml-1 text-[10px]", className)}>(encore)</span>;
}

function PlayerBadge({
  player,
  currentUserId,
  isCurrentHour,
}: {
  player: SchedulePlayer;
  currentUserId: string | undefined;
  isCurrentHour: boolean;
}) {
  const classes = getPlayerBadgeClasses({
    isCurrentHour,
    isCurrentUser: isCurrentPlayer(player, currentUserId),
    isEncore: player.enc,
  });

  return (
    <span className={cn("text-xs", classes.badge)}>
      {player.player.name}
      {player.enc ? <PlayerEncore className={classes.encore} /> : null}
    </span>
  );
}
