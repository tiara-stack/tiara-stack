import {
  createFileRoute,
  Outlet,
  useNavigate,
  useLocation,
  getRouteApi,
} from "@tanstack/react-router";
import { Calendar as CalendarIcon, Users } from "lucide-react";
import { useTransition, useMemo } from "react";
import { Schema, pipe } from "effect";
import { useGuildSchedule } from "#/lib/schedule";

// Search params schema using Effect Schema
const ScheduleSearchSchema = Schema.Struct({
  month: Schema.NonEmptyString,
  day: Schema.NonEmptyString,
});

export type ScheduleSearchParams = typeof ScheduleSearchSchema.Type;

// Create route API to access search params from child routes
export const routeApi = getRouteApi("/dashboard/guilds/$guildId/schedule/$channel");

// Extract unique channels from schedules
const getChannelsFromSchedules = (
  schedules: readonly import("#/lib/schedule").ScheduleResult[],
): string[] => {
  const channelSet = new Set<string>();
  schedules.forEach((schedule) => {
    if (schedule._tag === "PopulatedSchedule") {
      channelSet.add(schedule.channel);
    }
  });
  return Array.from(channelSet).sort();
};

export const Route = createFileRoute("/dashboard/guilds/$guildId/schedule/$channel")({
  validateSearch: pipe(ScheduleSearchSchema, Schema.standardSchemaV1),
  component: ScheduleLayout,
});

function ScheduleLayout() {
  const { guildId, channel } = Route.useParams();
  const search = Route.useSearch();
  const location = useLocation();
  const navigate = useNavigate();
  const [isPending, startTransition] = useTransition();

  // Fetch schedules to get all available channels
  const scheduleData = useGuildSchedule(guildId);
  const channels = useMemo(() => getChannelsFromSchedules(scheduleData), [scheduleData]);

  const isCalendarView = location.pathname.includes("/calendar");
  const isDailyView = location.pathname.includes("/daily");

  const handleCalendarClick = (e: React.MouseEvent) => {
    e.preventDefault();
    startTransition(() => {
      navigate({
        to: "/dashboard/guilds/$guildId/schedule/$channel/calendar",
        params: { guildId, channel },
        search: { month: search.month, day: search.day },
      });
    });
  };

  const handleDailyClick = (e: React.MouseEvent) => {
    e.preventDefault();
    startTransition(() => {
      navigate({
        to: "/dashboard/guilds/$guildId/schedule/$channel/daily",
        params: { guildId, channel },
        search: { month: search.month, day: search.day },
      });
    });
  };

  const handleChannelClick = (newChannel: string) => {
    startTransition(() => {
      if (isCalendarView) {
        navigate({
          to: "/dashboard/guilds/$guildId/schedule/$channel/calendar",
          params: { guildId, channel: newChannel },
          search: { month: search.month, day: search.day },
        });
      } else {
        navigate({
          to: "/dashboard/guilds/$guildId/schedule/$channel/daily",
          params: { guildId, channel: newChannel },
          search: { month: search.month, day: search.day },
        });
      }
    });
  };

  return (
    <div className="space-y-6">
      {/* View Toggle */}
      <div className="flex gap-2">
        <button
          onClick={handleCalendarClick}
          disabled={isPending}
          className={`
            px-4 py-2 text-sm font-bold tracking-wide transition-colors
            ${isCalendarView ? "bg-[#33ccbb] text-[#0a0f0e]" : "bg-[#0f1615] text-white border border-[#33ccbb]/30 hover:bg-[#33ccbb]/10"}
            ${isPending ? "opacity-50 cursor-not-allowed" : ""}
          `}
        >
          <CalendarIcon className="w-4 h-4 inline mr-2" />
          CALENDAR
        </button>
        <button
          onClick={handleDailyClick}
          disabled={isPending}
          className={`
            px-4 py-2 text-sm font-bold tracking-wide transition-colors
            ${isDailyView ? "bg-[#33ccbb] text-[#0a0f0e]" : "bg-[#0f1615] text-white border border-[#33ccbb]/30 hover:bg-[#33ccbb]/10"}
            ${isPending ? "opacity-50 cursor-not-allowed" : ""}
          `}
        >
          <Users className="w-4 h-4 inline mr-2" />
          DAILY VIEW
        </button>
      </div>

      {/* Channel Tabs */}
      {channels.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-2">
          {channels.map((ch) => (
            <button
              key={ch}
              onClick={() => handleChannelClick(ch)}
              disabled={isPending}
              className={`
                px-3 py-1.5 text-xs font-bold tracking-wide whitespace-nowrap transition-colors
                ${
                  channel === ch
                    ? "bg-[#33ccbb] text-[#0a0f0e]"
                    : "bg-[#0f1615] text-white border border-[#33ccbb]/30 hover:bg-[#33ccbb]/10"
                }
                ${isPending ? "opacity-50 cursor-not-allowed" : ""}
              `}
            >
              {ch.toUpperCase()}
            </button>
          ))}
        </div>
      )}

      <Outlet key={location.pathname} />
    </div>
  );
}
