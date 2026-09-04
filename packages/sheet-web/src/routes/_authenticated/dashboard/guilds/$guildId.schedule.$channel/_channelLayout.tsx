import { createFileRoute, Outlet, Link } from "@tanstack/react-router";
import { Schema, pipe, Effect } from "effect";
import { AnimatePresence, LayoutGroup, motion, useIsPresent } from "motion/react";

import { useAllChannels, getAllChannelsAtom } from "#/lib/schedule";
import { ensureResultAtomData, isBrowserRuntime } from "#/lib/atomRegistry";
import { SchedulePending } from "#/components/SchedulePending";
import { useHydrated } from "#/hooks/useHydrated";
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
    if (!isBrowserRuntime()) return;
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
  const hydrated = useHydrated();

  return (
    <LayoutGroup id={`${guildId}-${channel}`}>
      <div className="space-y-3 sm:space-y-6">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-base font-black tracking-[0.18em] text-[#33ccbb] sm:text-lg">
            SCHEDULE
          </h1>
          <span aria-hidden="true" className="text-[#33ccbb]/40">
            /
          </span>
          <span className="truncate text-sm font-bold text-white/70">#{channel}</span>
        </div>

        {hydrated ? <ScheduleLayoutContent guildId={guildId} /> : <ScheduleLayoutPending />}
      </div>
    </LayoutGroup>
  );
}

function ScheduleLayoutPending() {
  return <SchedulePending />;
}

function ScheduleLayoutContent({ guildId }: { guildId: string }) {
  const search = Route.useSearch();
  const selected = useScheduleSelected(search);

  const viewType = useCurrentView();
  const routeKey = viewType === "daily" ? "daily" : "calendar";

  const channels = useAllChannels(guildId);

  return (
    <>
      {/* Channel Tabs */}
      {channels.length > 0 && (
        <nav aria-label="Schedule channels" className="flex gap-2 overflow-x-auto pb-1 sm:pb-2">
          {channels.map((ch) => (
            <Link
              key={ch}
              to="/dashboard/guilds/$guildId/schedule/$channel"
              params={{ guildId, channel: ch }}
              search={{ timestamp: search.timestamp }}
              activeOptions={{ includeSearch: false, exact: false }}
              activeProps={{ "aria-current": "page" }}
              className={`
                inline-flex min-h-11 items-center px-3 py-1.5 text-xs font-bold tracking-wide whitespace-nowrap transition-colors sm:min-h-0
                [&.active]:bg-[#33ccbb] [&.active]:text-[#0a0f0e]
                bg-[#0f1615] text-white border border-[#33ccbb]/30 hover:bg-[#33ccbb]/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc]
              `}
            >
              {ch.toUpperCase()}
            </Link>
          ))}
        </nav>
      )}

      <div className="relative">
        <AnimatePresence initial={false} mode="sync">
          <RoutePresenceShell key={routeKey} shouldFadeIn={selected === undefined}>
            <Outlet />
          </RoutePresenceShell>
        </AnimatePresence>
      </div>
    </>
  );
}
