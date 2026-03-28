import { DateTime, Array, Option, pipe } from "effect";
import { useMemo, useCallback } from "react";
import { useChildMatches, useNavigate } from "@tanstack/react-router";
import { formatDayKey } from "#/lib/schedule";
import { makeDateTime, useDateTime } from "#/hooks/useDateTime";
import { useZoned, useZonedOptional } from "#/hooks/useDateTimeZoned";
import { useTimeZone } from "#/hooks/useTimeZone";
import type { ScheduleSearchParams } from "../_channelLayout";

export const morphLayoutTransition = {
  duration: 0.35,
  ease: [0.4, 0, 0.2, 1],
} as const;

export const calendarRestTransition = {
  duration: 0.2,
  ease: [0.4, 0, 0.2, 1],
} as const;

export const monthSlideTransition = {
  duration: 0.3,
  ease: [0.4, 0, 0.2, 1],
} as const;

export type MonthDirection = -1 | 0 | 1;

export type TransitionPhase = "to-daily" | "to-calendar";

export type ViewType = "calendar" | "daily" | "default";

// Hook to get the current view type from route matches
export function useCurrentView(): ViewType {
  const childMatches = useChildMatches();

  return useMemo(() => {
    return pipe(
      Array.head(childMatches),
      Option.map((match) => {
        if (match.routeId.includes("/daily")) return "daily" as const;
        if (match.routeId.includes("/calendar")) return "calendar" as const;
        return "default" as const;
      }),
      Option.getOrElse(() => "default" as const),
    );
  }, [childMatches]);
}

// Hook for reading the selected day transition state
// Fully derived from URL search params
export function useScheduleSelected(search: ScheduleSearchParams) {
  const timeZone = useTimeZone();
  const timestamp = useDateTime(search.timestamp);
  const fromDateTime = search.from?.timestamp !== undefined ? search.from.timestamp : undefined;
  const fromTimestampDateTime = useMemo(
    () => (fromDateTime !== undefined ? makeDateTime(fromDateTime) : undefined),
    [fromDateTime],
  );

  const zonedTimestamp = useZoned(timeZone, timestamp);
  const fromTimestamp = useZonedOptional(timeZone, fromTimestampDateTime);

  return useMemo(() => {
    if (!search.from || !fromTimestamp) {
      return undefined;
    }

    if (search.from.view === "calendar") {
      // Calendar → Daily: timestamp=day, from.timestamp=month
      return { day: zonedTimestamp, month: DateTime.startOf(fromTimestamp, "month") };
    } else {
      // Daily → Calendar: timestamp=month, from.timestamp=day
      return { day: fromTimestamp, month: DateTime.startOf(zonedTimestamp, "month") };
    }
    // Use primitive deps to avoid recomputation when search object is recreated
  }, [search.from?.view, search.from?.timestamp, zonedTimestamp, fromTimestamp]);
}

// Hook for reading the month direction
// Fully derived from URL search params by comparing current timestamp with from.timestamp
// Only applies when coming from calendar view
export function useScheduleMonthDirection(search: ScheduleSearchParams) {
  const timeZone = useTimeZone();
  const timestamp = useDateTime(search.timestamp);
  const fromDateTime = search.from?.timestamp !== undefined ? search.from.timestamp : undefined;
  const fromTimestampDateTime = useMemo(
    () => (fromDateTime !== undefined ? makeDateTime(fromDateTime) : undefined),
    [fromDateTime],
  );

  const currentDate = useZoned(timeZone, timestamp);
  const fromDate = useZonedOptional(timeZone, fromTimestampDateTime);

  return useMemo(() => {
    // Only derive direction when explicitly coming from calendar view
    if (search.from?.view !== "calendar") {
      return 0 as const;
    }

    if (!fromDate) {
      return 0 as const;
    }

    const currentMonthStart = DateTime.toEpochMillis(DateTime.startOf(currentDate, "month"));
    const fromMonthStart = DateTime.toEpochMillis(DateTime.startOf(fromDate, "month"));

    if (fromMonthStart < currentMonthStart) {
      return 1 as const; // Forward (next month)
    } else if (fromMonthStart > currentMonthStart) {
      return -1 as const; // Backward (prev month)
    }
    return 0 as const;
  }, [search.from?.view, currentDate, fromDate]);
}

// Hook for reading the transition phase
// Derived by comparing current view with from.view from URL
export function useSchedulePhase(
  search: ScheduleSearchParams,
  currentView: ViewType,
): TransitionPhase | undefined {
  return useMemo(() => {
    const fromView = search.from?.view;

    // No transition if no from param or view matches
    if (!fromView || fromView === currentView) {
      return undefined;
    }

    // Transition from calendar to daily
    if (fromView === "calendar" && currentView === "daily") {
      return "to-daily";
    }

    // Transition from daily to calendar
    if (fromView === "daily" && currentView === "calendar") {
      return "to-calendar";
    }

    return undefined;
  }, [search.from?.view, currentView]);
}

// Hook for derived transition states
// All derived from URL without atoms
export function useScheduleTransitionStates(search: ScheduleSearchParams, currentView: ViewType) {
  const phase = useSchedulePhase(search, currentView);
  const navigate = useNavigate();

  const clearScheduleTransitionState = useCallback(() => {
    // Navigate to the same route but without the 'from' param to clear transition state
    // Use replace: true to avoid pushing a duplicate history entry
    void navigate({
      to: ".",
      search: { timestamp: search.timestamp },
      replace: true,
    });
  }, [navigate, search.timestamp]);

  return useMemo(() => {
    const isTransitioningToDaily = phase === "to-daily";
    const isTransitioningToCalendar = phase === "to-calendar";
    const isCalendarLocked = isTransitioningToDaily || isTransitioningToCalendar;

    return {
      isTransitioningToDaily,
      isTransitioningToCalendar,
      isCalendarLocked,
      clearScheduleTransitionState,
    };
  }, [phase, clearScheduleTransitionState]);
}

export function buildSharedDayLayoutId(day: DateTime.Zoned, displayedMonth: DateTime.Zoned) {
  return `day-${formatDayKey(day)}-${formatDayKey(DateTime.startOf(displayedMonth, "month"))}`;
}
