import {
  createFileRoute,
  Outlet,
  useNavigate,
  useLocation,
  getRouteApi,
} from "@tanstack/react-router";
import { Calendar as CalendarIcon, Users } from "lucide-react";
import { useTransition } from "react";
import { Schema, pipe } from "effect";

import { ViewTransition } from "react";

// Search params schema using Effect Schema
const ScheduleSearchSchema = Schema.Struct({
  month: Schema.NonEmptyString,
  day: Schema.NonEmptyString,
});

export type ScheduleSearchParams = typeof ScheduleSearchSchema.Type;

// Create route API to access search params from child routes
export const routeApi = getRouteApi("/dashboard/guilds/$guildId/schedule");

export const Route = createFileRoute("/dashboard/guilds/$guildId/schedule")({
  validateSearch: pipe(ScheduleSearchSchema, Schema.standardSchemaV1),

  component: ScheduleLayout,
});

function ScheduleLayout() {
  const { guildId } = Route.useParams();
  const search = Route.useSearch();
  const location = useLocation();
  const navigate = useNavigate();
  const [isPending, startTransition] = useTransition();

  const isCalendarView = location.pathname.includes("/calendar");
  const isDailyView = location.pathname.includes("/daily");

  const handleCalendarClick = (e: React.MouseEvent) => {
    e.preventDefault();
    startTransition(() => {
      navigate({
        to: "/dashboard/guilds/$guildId/schedule/calendar",
        params: { guildId },
        search: { month: search.month, day: search.day },
      });
    });
  };

  const handleDailyClick = (e: React.MouseEvent) => {
    e.preventDefault();
    startTransition(() => {
      navigate({
        to: "/dashboard/guilds/$guildId/schedule/daily",
        params: { guildId },
        search: { month: search.month, day: search.day },
      });
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

      {/* Content with React ViewTransition */}
      <ViewTransition name="schedule-content">
        <Outlet key={location.pathname} />
      </ViewTransition>
    </div>
  );
}
