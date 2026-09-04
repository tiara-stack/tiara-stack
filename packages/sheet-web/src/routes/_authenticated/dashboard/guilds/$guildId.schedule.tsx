import { createFileRoute, Outlet, redirect, useLocation } from "@tanstack/react-router";
import { DateTime, Effect, Predicate, Schema, pipe } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { Suspense, useEffect } from "react";
import { getAllChannelsAtom, useAllChannelsResult } from "#/lib/schedule";
import { ensureResultAtomData, isBrowserRuntime } from "#/lib/atomRegistry";
import { availableResultValue } from "#/lib/asyncResult";
import { SchedulePending } from "#/components/SchedulePending";
import { useHydrated } from "#/hooks/useHydrated";

const ScheduleSearchSchema = Schema.Struct({
  timestamp: Schema.optional(Schema.Number),
});

export const Route = createFileRoute("/_authenticated/dashboard/guilds/$guildId/schedule")({
  component: ScheduleRedirect,
  pendingComponent: SchedulePending,
  ssr: "data-only",
  validateSearch: pipe(ScheduleSearchSchema, Schema.toStandardSchemaV1),
  beforeLoad: async ({ params, search, context }) => {
    if (!isBrowserRuntime() || Predicate.isNotUndefined(search.timestamp)) {
      return;
    }

    const channels = await Effect.runPromise(
      ensureResultAtomData(context.atomRegistry, getAllChannelsAtom(params.guildId), {
        revalidateIfStale: true,
      }).pipe(Effect.catch(() => Effect.succeed([]))),
    );

    const defaultChannel = channels[0];
    const now = Effect.runSync(DateTime.now);

    if (Predicate.isUndefined(defaultChannel)) return;

    throw redirect({
      to: "/dashboard/guilds/$guildId/schedule/$channel/daily",
      params: { guildId: params.guildId, channel: defaultChannel },
      search: { timestamp: DateTime.toEpochMillis(now) },
      replace: true,
    });
  },
});

function ScheduleRouteContent({
  hydrated,
  isScheduleRoot,
}: {
  hydrated: boolean;
  isScheduleRoot: boolean;
}) {
  if (!hydrated) {
    return <SchedulePending />;
  }

  return isScheduleRoot ? <ScheduleContent /> : <Outlet />;
}

function ScheduleRedirect() {
  const { guildId } = Route.useParams();
  const { pathname } = useLocation();
  const hydrated = useHydrated();
  const scheduleRootPath = `/dashboard/guilds/${guildId}/schedule`;
  const isScheduleRoot = pathname === scheduleRootPath || pathname === `${scheduleRootPath}/`;

  return (
    <Suspense fallback={<SchedulePending />}>
      <ScheduleRouteContent hydrated={hydrated} isScheduleRoot={isScheduleRoot} />
    </Suspense>
  );
}

function useScheduleDefaultChannelRedirect({
  guildId,
  timestamp,
  defaultChannel,
}: {
  readonly guildId: string;
  readonly timestamp: number | undefined;
  readonly defaultChannel: string | undefined;
}) {
  const navigate = Route.useNavigate();
  useEffect(() => {
    if (Predicate.isUndefined(defaultChannel)) return;

    void navigate({
      to: "/dashboard/guilds/$guildId/schedule/$channel/daily",
      params: { guildId, channel: defaultChannel },
      search: {
        timestamp: timestamp ?? DateTime.toEpochMillis(Effect.runSync(DateTime.now)),
      },
      replace: true,
    });
  }, [defaultChannel, guildId, navigate, timestamp]);
}

type ScheduleChannelsResult = ReturnType<typeof useAllChannelsResult>;

const scheduleIsUnavailable = (
  channelsResult: ScheduleChannelsResult,
  defaultChannel: string | undefined,
) => AsyncResult.isFailure(channelsResult) && Predicate.isUndefined(defaultChannel);

const scheduleIsPending = (
  channelsResult: ScheduleChannelsResult,
  defaultChannel: string | undefined,
) => Predicate.isNotUndefined(defaultChannel) || channelsResult.waiting;

function ScheduleContent() {
  const { guildId } = Route.useParams();
  const search = Route.useSearch();
  const channelsResult = useAllChannelsResult(guildId);
  const channels = availableResultValue(channelsResult) ?? [];
  const defaultChannel = channels[0];

  useScheduleDefaultChannelRedirect({
    defaultChannel,
    guildId,
    timestamp: search.timestamp,
  });

  return <ScheduleChannelState channelsResult={channelsResult} defaultChannel={defaultChannel} />;
}

function ScheduleChannelState({
  channelsResult,
  defaultChannel,
}: {
  readonly channelsResult: ScheduleChannelsResult;
  readonly defaultChannel: string | undefined;
}) {
  if (scheduleIsPending(channelsResult, defaultChannel)) {
    return <SchedulePending />;
  }

  if (scheduleIsUnavailable(channelsResult, defaultChannel)) {
    return (
      <section
        role="alert"
        aria-live="polite"
        className="space-y-2 border border-[#33ccbb]/20 bg-[#0f1615] p-4 sm:p-6"
      >
        <p className="text-[10px] font-black tracking-[0.2em] text-[#33ccbb]">SCHEDULE</p>
        <h1 className="text-lg font-black tracking-tight text-white sm:text-xl">
          Schedule unavailable
        </h1>
        <p className="max-w-xl text-sm leading-relaxed text-white/55">
          This server does not have a readable schedule yet. Configure a schedule channel in server
          administration, then try again.
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="space-y-2 border border-[#33ccbb]/20 bg-[#0f1615] p-4 sm:p-6">
        <p className="text-[10px] font-black tracking-[0.2em] text-[#33ccbb]">SCHEDULE</p>
        <h1 className="text-lg font-black tracking-tight text-white sm:text-xl">
          No schedule channels yet
        </h1>
        <p className="max-w-xl text-sm leading-relaxed text-white/55">
          Configure a schedule channel in server administration to start planning.
        </p>
      </section>
    </>
  );
}
