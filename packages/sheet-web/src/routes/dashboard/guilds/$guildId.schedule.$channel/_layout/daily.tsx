import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { useMemo, useRef, useState, useCallback, useEffect, Suspense } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { format, isSameDay, addDays, parseISO } from "date-fns";
import { Option } from "effect";
import {
  type SchedulePlayer,
  type ScheduleResult,
  useGuildSchedule,
  filterSchedulesByDate,
} from "#/lib/schedule";
import { useEventConfig } from "#/lib/sheet";
import { useTimeZone } from "#/hooks/useTimeZone";

const MAX_DAY_RANGE = 365;

export const Route = createFileRoute("/dashboard/guilds/$guildId/schedule/$channel/_layout/daily")({
  component: DailyPage,
  ssr: "data-only", // Prevent component SSR to avoid timezone-based content flash
});

function DailyPage() {
  const { guildId } = Route.useParams();
  const timeZone = useTimeZone();

  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <div className="text-white/60 font-medium tracking-wide">LOADING SCHEDULE...</div>
        </div>
      }
    >
      <DailyScheduleView guildId={guildId} timeZone={timeZone} />
    </Suspense>
  );
}

function DailyScheduleView({ guildId, timeZone }: { guildId: string; timeZone: string }) {
  const { channel } = Route.useParams();
  const parentRef = useRef<HTMLDivElement>(null);
  const search = Route.useSearch();

  // Parse date with fallback to today if invalid
  const currentDate = useMemo(() => {
    try {
      const parsed = parseISO(search.day);
      return isNaN(parsed.getTime()) ? new Date() : parsed;
    } catch {
      return new Date();
    }
  }, [search.day]);

  // Infinite scroll state - track day offset and total count
  const [dayRange, setDayRange] = useState({ startOffset: -30, endOffset: 30 });

  // Generate virtual days based on current range
  const virtualDays = useMemo(() => {
    const days: Date[] = [];
    for (let i = dayRange.startOffset; i <= dayRange.endOffset; i++) {
      days.push(addDays(currentDate, i));
    }
    return days;
  }, [currentDate, dayRange]);

  // Calculate current date index within the virtual days
  const currentDateIndex = useMemo(() => {
    return virtualDays.findIndex((d) => isSameDay(d, currentDate));
  }, [currentDate, virtualDays]);

  const virtualizer = useVirtualizer({
    count: virtualDays.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 500,
    overscan: 2,
    initialOffset: currentDateIndex >= 0 ? currentDateIndex * 500 : 0,
  });

  // Scroll to current date when it changes (e.g., URL param update)
  useEffect(() => {
    if (currentDateIndex >= 0) {
      virtualizer.scrollToIndex(currentDateIndex, { align: "start" });
    }
  }, [currentDateIndex, virtualizer]);

  // Extend range when scrolling near edges using onScroll event
  const lastScrollCheckRef = useRef(0);

  const handleScroll = useCallback(() => {
    const now = Date.now();
    if (now - lastScrollCheckRef.current < 100) return; // Throttle to 100ms
    lastScrollCheckRef.current = now;

    const range = virtualizer.getVirtualItems();
    if (range.length === 0) return;

    const startIndex = range[0].index;
    const endIndex = range[range.length - 1].index;

    // Extend backward if scrolling near start
    if (startIndex < 5) {
      setDayRange((prev) => ({
        ...prev,
        startOffset: Math.max(-MAX_DAY_RANGE, prev.startOffset - 30),
      }));
    }

    // Extend forward if scrolling near end
    if (endIndex > virtualDays.length - 5) {
      setDayRange((prev) => ({
        ...prev,
        endOffset: Math.min(MAX_DAY_RANGE, prev.endOffset + 30),
      }));
    }
  }, [virtualizer, virtualDays.length]);

  const calendarTo = {
    to: "/dashboard/guilds/$guildId/schedule/$channel/calendar" as const,
    params: { guildId, channel },
    search: {
      month: format(currentDate, "yyyy-MM"),
      day: search.day,
    },
  };

  return (
    <div className="border border-[#33ccbb]/20 bg-[#0f1615] p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <Link
          {...calendarTo}
          className="flex items-center gap-2 text-[#33ccbb] hover:text-white transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          <span className="text-sm font-bold tracking-wide">BACK TO CALENDAR</span>
        </Link>
        <h3 className="text-xl font-black tracking-tight">
          {format(currentDate, "EEEE, MMMM d, yyyy").toUpperCase()}
        </h3>
      </div>

      {/* Schedule Grid with Virtualization */}
      <div ref={parentRef} className="h-[600px] overflow-auto" onScroll={handleScroll}>
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const virtualDate = virtualDays[virtualItem.index];
            const isActive = isSameDay(virtualDate, currentDate);

            return (
              <div
                key={virtualItem.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${virtualItem.size}px`,
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <Suspense fallback={<DayScheduleSkeleton date={virtualDate} isActive={isActive} />}>
                  <DayScheduleGridContent
                    guildId={guildId}
                    channel={channel}
                    date={virtualDate}
                    timeZone={timeZone}
                    isActive={isActive}
                  />
                </Suspense>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Skeleton for loading state
function DayScheduleSkeleton({ date, isActive }: { date: Date; isActive: boolean }) {
  return (
    <div className={`${isActive ? "bg-[#0f1615]" : "bg-[#0a0f0e]"} border-b-4 border-[#33ccbb]/40`}>
      {/* Day Header */}
      <div className="bg-[#0f1615] border-b border-[#33ccbb]/30 px-4 py-3">
        <h4 className="text-lg font-black tracking-tight">
          {format(date, "EEEE, MMMM d").toUpperCase()}
        </h4>
      </div>

      {/* Timeline Skeleton */}
      <div className="relative">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-[60px_1fr] border-b border-[#33ccbb]/10 min-h-[60px]"
          >
            <div className="border-r border-[#33ccbb]/10 p-2">
              <div className="h-3 bg-[#33ccbb]/10 animate-pulse ml-auto w-8" />
            </div>
            <div className="p-2">
              <div className="h-8 bg-[#33ccbb]/10 animate-pulse w-3/4" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Day Schedule Grid Content (fetches data)
function DayScheduleGridContent({
  guildId,
  channel,
  date,
  timeZone,
  isActive,
}: {
  guildId: string;
  channel: string;
  date: Date;
  timeZone: string;
  isActive: boolean;
}) {
  // Fetch all schedules and event config (with startTime)
  const allSchedules = useGuildSchedule(guildId);
  const eventConfig = useEventConfig(guildId);

  // Filter schedules that fall within the target date based on startTime
  const daySchedules = useMemo(() => {
    return filterSchedulesByDate(allSchedules, eventConfig.startTime, date, timeZone);
  }, [allSchedules, eventConfig.startTime, date, timeZone]);

  // Filter schedules by channel and visibility
  const channelSchedules = useMemo(() => {
    return daySchedules.filter((schedule) =>
      schedule._tag === "PopulatedSchedule"
        ? schedule.channel === channel && schedule.visible
        : true,
    );
  }, [daySchedules, channel]);

  return <DayScheduleGrid date={date} schedules={channelSchedules} isActive={isActive} />;
}

// Individual Day Schedule Grid - Daily Planner Style
function DayScheduleGrid({
  date,
  schedules,
  isActive,
}: {
  date: Date;
  schedules: readonly ScheduleResult[];
  isActive: boolean;
}) {
  // Group schedules by hour (modulo 24 since hour is cumulative across days)
  const schedulesByHour = useMemo(() => {
    const grouped = new Map<number, ScheduleResult[]>();
    schedules.forEach((schedule: ScheduleResult) => {
      const cumulativeHour = Option.getOrElse(schedule.hour, () => 0);
      const displayHour = cumulativeHour % 24; // Convert to 0-23 for display
      if (!grouped.has(displayHour)) {
        grouped.set(displayHour, []);
      }
      grouped.get(displayHour)!.push(schedule);
    });
    return grouped;
  }, [schedules]);

  // Get all hours (0-23)
  const hours = Array.from({ length: 24 }, (_, i) => i);

  return (
    <div className={`${isActive ? "bg-[#0f1615]" : "bg-[#0a0f0e]"} border-b-4 border-[#33ccbb]/40`}>
      {/* Day Header - prominent boundary */}
      <div className="sticky top-0 z-10 bg-[#0f1615] border-b border-[#33ccbb]/30 px-4 py-3">
        <h4 className="text-lg font-black tracking-tight">
          {format(date, "EEEE, MMMM d").toUpperCase()}
        </h4>
      </div>
      {/* Daily Planner Timeline */}
      <div className="relative">
        {hours.map((hour) => {
          const hourSchedules = schedulesByHour.get(hour) ?? [];

          return (
            <div
              key={hour}
              className="grid grid-cols-[60px_1fr] border-b border-[#33ccbb]/10 min-h-[60px]"
            >
              {/* Time Label */}
              <div className="border-r border-[#33ccbb]/10 p-2 text-right">
                <span className="text-xs font-bold text-[#33ccbb]/60">
                  {format(new Date().setHours(hour, 0, 0, 0), "h a")}
                </span>
              </div>
              {/* Schedule Block */}
              <div className="p-2 relative">
                {hourSchedules.length > 0 ? (
                  <div className="space-y-1">
                    {hourSchedules.map((schedule, idx) => (
                      <ScheduleBlock key={idx} schedule={schedule} />
                    ))}
                  </div>
                ) : (
                  // Empty slot - subtle indication
                  <div className="h-full min-h-[44px]" />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Schedule Block - Calendar Event Style
function ScheduleBlock({ schedule }: { schedule: ScheduleResult }) {
  if (schedule._tag === "PopulatedBreakSchedule") {
    return (
      <div className="bg-[#33ccbb]/5 border-l-2 border-[#33ccbb]/30 py-1 px-2">
        <span className="text-[10px] text-white/40 uppercase tracking-wide">Break</span>
      </div>
    );
  }

  const fills = schedule.fills.filter(Option.isSome).map((f) => f.value);

  return (
    <div className="bg-[#33ccbb]/10 border-l-2 border-[#33ccbb] py-1.5 px-2 hover:bg-[#33ccbb]/20 transition-colors">
      <div className="flex flex-wrap gap-x-2 gap-y-0.5">
        {fills.map((fill: SchedulePlayer, idx: number) => (
          <span
            key={idx}
            className={`text-xs text-white/90 ${fill.enc ? "font-bold text-white" : ""}`}
          >
            {fill.player.name}
          </span>
        ))}
      </div>
    </div>
  );
}
