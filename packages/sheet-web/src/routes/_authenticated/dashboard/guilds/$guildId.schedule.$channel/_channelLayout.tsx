import { createFileRoute, Outlet, Link } from "@tanstack/react-router";
import { Schema, pipe, Effect } from "effect";
import { AnimatePresence, LayoutGroup, motion, useIsPresent } from "motion/react";

import { useAllChannels, getAllChannelsAtom } from "#/lib/schedule";
import { ensureResultAtomData } from "#/lib/atomRegistry";
import {
  morphLayoutTransition,
  useScheduleSelected,
  useCurrentView,
} from "./_channelLayout/-transition";

// Search params schema using Effect Schema
// Timestamp in milliseconds for the selected date
// From track transition origin for animations
const ScheduleSearchSchema = Schema.Struct({
  timestamp: Schema.Number,
  from: Schema.optional(
    Schema.Struct({
      view: Schema.Literals(["calendar", "daily"]),
      timestamp: Schema.Number,
    }),
  ),
});

export type ScheduleSearchParams = typeof ScheduleSearchSchema.Type;

export const Route = createFileRoute(
  "/_authenticated/dashboard/guilds/$guildId/schedule/$channel/_channelLayout",
)({
  validateSearch: pipe(ScheduleSearchSchema, Schema.toStandardSchemaV1),
  component: ScheduleLayout,
  loader: async ({ context, params }) => {
    await Effect.runPromise(
      ensureResultAtomData(context.atomRegistry, getAllChannelsAtom(params.guildId)).pipe(
        Effect.catch(() => Effect.succeed([])),
      ),
    );
  },
});

function RoutePresenceShell({
  children,
  shouldFadeIn,
}: {
  children: React.ReactNode;
  shouldFadeIn: boolean;
}) {
  const isPresent = useIsPresent();

  return (
    <motion.div
      initial={shouldFadeIn ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      exit={{ opacity: 1 }}
      transition={morphLayoutTransition}
      className={isPresent ? "relative w-full" : "absolute inset-0 w-full"}
    >
      {children}
    </motion.div>
  );
}

function ScheduleLayout() {
  const { guildId, channel } = Route.useParams();
  const search = Route.useSearch();
  const selected = useScheduleSelected(search);

  const viewType = useCurrentView();
  const routeKey = viewType === "daily" ? "daily" : "calendar";

  const channels = useAllChannels(guildId);

  return (
    <LayoutGroup id={`${guildId}-${channel}`}>
      <div className="space-y-6">
        {/* Channel Tabs */}
        {channels.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-2">
            {channels.map((ch) => (
              <Link
                key={ch}
                to="/dashboard/guilds/$guildId/schedule/$channel"
                params={{ guildId, channel: ch }}
                search={{ timestamp: search.timestamp }}
                activeOptions={{ includeSearch: false, exact: false }}
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

        <div className="relative">
          <AnimatePresence initial={false} mode="sync">
            <RoutePresenceShell key={routeKey} shouldFadeIn={selected === undefined}>
              <Outlet />
            </RoutePresenceShell>
          </AnimatePresence>
        </div>
      </div>
    </LayoutGroup>
  );
}
