import { createFileRoute, Outlet, Link, useLocation } from "@tanstack/react-router";
import { Calendar as CalendarIcon, Users } from "lucide-react";
import { Schema, pipe, Effect } from "effect";
import { Registry } from "@effect-atom/atom-react";
import { useAllChannels, getAllChannelsAtom } from "#/lib/schedule";

// Search params schema using Effect Schema
// Timestamp in milliseconds for the selected date
const ScheduleSearchSchema = Schema.Struct({
  timestamp: Schema.Number,
});

export type ScheduleSearchParams = typeof ScheduleSearchSchema.Type;

export const Route = createFileRoute("/dashboard/guilds/$guildId/schedule/$channel")({
  validateSearch: pipe(ScheduleSearchSchema, Schema.standardSchemaV1),
  component: ScheduleLayout,
  loader: async ({ context, params }) => {
    await Effect.runPromise(
      Registry.getResult(context.atomRegistry, getAllChannelsAtom(params.guildId)).pipe(
        Effect.catchAll(() => Effect.succeed([])),
      ),
    );
  },
});

function ScheduleLayout() {
  const { guildId, channel } = Route.useParams();
  const search = Route.useSearch();
  const location = useLocation();

  const channels = useAllChannels(guildId);

  return (
    <div className="space-y-6">
      {/* View Toggle */}
      <div className="flex gap-2">
        <Link
          to="/dashboard/guilds/$guildId/schedule/$channel/calendar"
          params={{ guildId, channel }}
          search={{ timestamp: search.timestamp }}
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
          search={{ timestamp: search.timestamp }}
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
              search={{ timestamp: search.timestamp }}
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
