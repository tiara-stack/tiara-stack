import { createFileRoute, Outlet, Link, useLocation, getRouteApi } from "@tanstack/react-router";
import { Calendar as CalendarIcon, Users } from "lucide-react";
import { useMemo } from "react";
import { Schema, pipe } from "effect";
import { useGuildSchedule, getChannelsFromSchedules } from "#/lib/schedule";

// Search params schema using Effect Schema
const ScheduleSearchSchema = Schema.Struct({
  month: Schema.NonEmptyString,
  day: Schema.NonEmptyString,
});

export type ScheduleSearchParams = typeof ScheduleSearchSchema.Type;

// Create route API to access search params from child routes
export const routeApi = getRouteApi("/dashboard/guilds/$guildId/schedule/$channel");

export const Route = createFileRoute("/dashboard/guilds/$guildId/schedule/$channel")({
  validateSearch: pipe(ScheduleSearchSchema, Schema.standardSchemaV1),
  component: ScheduleLayout,
});

function ScheduleLayout() {
  const { guildId, channel } = Route.useParams();
  const search = Route.useSearch();
  const location = useLocation();

  // Fetch schedules to get all available channels
  const scheduleData = useGuildSchedule(guildId);
  const channels = useMemo(() => getChannelsFromSchedules(scheduleData), [scheduleData]);

  return (
    <div className="space-y-6">
      {/* View Toggle */}
      <div className="flex gap-2">
        <Link
          to="/dashboard/guilds/$guildId/schedule/$channel/calendar"
          params={{ guildId, channel }}
          search={{ month: search.month, day: search.day }}
          activeOptions={{ exact: true }}
          className={`
            px-4 py-2 text-sm font-bold tracking-wide transition-colors
            [&.active]:bg-[#33ccbb] [&.active]:text-[#0a0f0e]
            bg-[#0f1615] text-white border border-[#33ccbb]/30 hover:bg-[#33ccbb]/10
          `}
        >
          <CalendarIcon className="w-4 h-4 inline mr-2" />
          CALENDAR
        </Link>
        <Link
          to="/dashboard/guilds/$guildId/schedule/$channel/daily"
          params={{ guildId, channel }}
          search={{ month: search.month, day: search.day }}
          activeOptions={{ exact: true }}
          className={`
            px-4 py-2 text-sm font-bold tracking-wide transition-colors
            [&.active]:bg-[#33ccbb] [&.active]:text-[#0a0f0e]
            bg-[#0f1615] text-white border border-[#33ccbb]/30 hover:bg-[#33ccbb]/10
          `}
        >
          <Users className="w-4 h-4 inline mr-2" />
          DAILY VIEW
        </Link>
      </div>

      {/* Channel Tabs */}
      {channels.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-2">
          {channels.map((ch) => (
            <Link
              key={ch}
              to="."
              params={(prev) => ({ ...prev, channel: ch })}
              search={{ month: search.month, day: search.day }}
              activeOptions={{ exact: false }}
              className={`
                px-3 py-1.5 text-xs font-bold tracking-wide whitespace-nowrap transition-colors
                [&.active]:bg-[#33ccbb] [&.active]:text-[#0a0f0e]
                bg-[#0f1615] text-white border border-[#33ccbb]/30 hover:bg-[#33ccbb]/10
              `}
            >
              {ch.toUpperCase()}
            </Link>
          ))}
        </div>
      )}

      <Outlet key={location.pathname} />
    </div>
  );
}
