import { createFileRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import { Suspense } from "react";
import { Effect } from "effect";
import { Avatar, AvatarImage, AvatarFallback } from "#/components/ui/avatar";
import { Skeleton } from "#/components/ui/skeleton";
import {
  currentUserGuildsAtom,
  guildIconUrl,
  useCurrentUserGuildsResult,
  useRefreshCurrentUserGuilds,
  type DiscordGuild,
} from "#/lib/discord";
import { ensureResultAtomData, isBrowserRuntime } from "#/lib/atomRegistry";
import { isSheetEditorPath } from "#/routes";
import { cn } from "#/lib/utils";
import { useHydrated } from "#/hooks/useHydrated";

// Loading fallback for guild sidebar
function GuildSidebarFallback() {
  return (
    <div className="flex min-w-0 flex-row items-center gap-2 overflow-x-auto pb-0 sm:w-full sm:flex-col sm:gap-3 sm:overflow-x-visible sm:pb-1">
      <Skeleton className="h-12 w-12 shrink-0 rounded-lg bg-[#33ccbb]/20" />
      <Skeleton className="h-12 w-12 shrink-0 rounded-lg bg-[#33ccbb]/20" />
      <Skeleton className="h-12 w-12 shrink-0 rounded-lg bg-[#33ccbb]/20" />
    </div>
  );
}

function GuildRailAvatarContent({
  guild,
  iconUrl,
}: {
  guild: DiscordGuild;
  iconUrl: string | null;
}) {
  return (
    <>
      {iconUrl ? <AvatarImage src={iconUrl} alt="" className="rounded-lg object-cover" /> : null}
      <AvatarFallback delay={0} className="relative rounded-lg bg-[#0f1615] text-[#33ccbb]">
        {iconUrl && <Skeleton className="absolute inset-0 size-full rounded-lg bg-[#33ccbb]/20" />}
        <span className="relative z-10 text-sm font-black">
          {guild.name.slice(0, 2).toUpperCase()}
        </span>
      </AvatarFallback>
    </>
  );
}

function GuildRailAvatar({ guild, selected }: { guild: DiscordGuild; selected: boolean }) {
  const iconUrl = guildIconUrl(guild);

  return (
    <Avatar
      className={cn(
        "h-12 w-12 rounded-lg border transition-colors after:rounded-lg hover:border-[#33ccbb]",
        selected ? "border-[#33ccbb]" : "border-[#33ccbb]/30",
      )}
    >
      <GuildRailAvatarContent guild={guild} iconUrl={iconUrl} />
    </Avatar>
  );
}

function GuildIcon({ guild, selected }: { guild: DiscordGuild; selected: boolean }) {
  return (
    <Link
      to="/dashboard/guilds/$guildId/schedule"
      params={{ guildId: guild.id }}
      className={cn(
        "group relative block shrink-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc]",
        selected && "ring-2 ring-[#33ccbb] ring-offset-2 ring-offset-[#0a0f0e]",
      )}
      aria-label={`Switch to ${guild.name}`}
      aria-current={selected ? "page" : undefined}
    >
      <GuildRailAvatar guild={guild} selected={selected} />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-nowrap border border-[#33ccbb]/40 bg-[#0f1615] px-3 py-2 text-xs font-bold text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 sm:bottom-auto sm:left-full sm:top-1/2 sm:mb-0 sm:ml-3 sm:translate-x-0 sm:-translate-y-1/2"
      >
        {guild.name}
      </span>
    </Link>
  );
}

function GuildSidebarContent() {
  const guildsResult = useCurrentUserGuildsResult();
  const refreshGuilds = useRefreshCurrentUserGuilds();
  const { pathname } = useLocation();

  if (AsyncResult.isFailure(guildsResult)) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex flex-col items-center gap-2 text-center text-xs font-medium text-white/40"
      >
        <span>SERVERS UNAVAILABLE</span>
        <button
          type="button"
          className="border border-[#33ccbb]/30 px-2 py-1 text-[10px] font-black tracking-wide text-[#33ccbb] transition hover:bg-[#33ccbb]/10 disabled:cursor-wait disabled:opacity-50"
          disabled={guildsResult.waiting}
          onClick={refreshGuilds}
        >
          {guildsResult.waiting ? "RETRYING…" : "RETRY"}
        </button>
      </div>
    );
  }

  const guilds = guildsResult.value;
  if (guilds.length === 0) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="text-center text-xs font-medium text-white/40"
      >
        NO SERVERS AVAILABLE
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-row items-center gap-2 overflow-x-auto pb-0 sm:w-full sm:flex-none sm:flex-col sm:gap-3 sm:overflow-x-hidden sm:overflow-y-auto sm:max-h-[calc(100vh-280px)] sm:pr-1 sm:pb-1">
      {guilds.map((guild) => (
        <GuildIcon
          key={guild.id}
          guild={guild}
          selected={isSelectedGuildPath(pathname, guild.id)}
        />
      ))}
    </div>
  );
}

function isSelectedGuildPath(pathname: string, guildId: string) {
  const basePath = `/dashboard/guilds/${guildId}`;
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

export const Route = createFileRoute("/_authenticated/dashboard/guilds")({
  component: GuildsLayout,
  loader: async ({ abortController, context }) => {
    if (!isBrowserRuntime()) return;
    await Effect.runPromise(
      ensureResultAtomData(context.atomRegistry, currentUserGuildsAtom).pipe(
        Effect.catch(() => Effect.void),
      ),
      { signal: abortController.signal },
    );
  },
});

function GuildsLayout() {
  const hydrated = useHydrated();
  const { pathname } = useLocation();
  const isSheetEditor = isSheetEditorPath(pathname);

  return (
    <div
      className={`flex min-w-0 flex-col sm:flex-row sm:gap-6 ${isSheetEditor ? "gap-2" : "gap-2 sm:gap-4"}`}
    >
      {/* Server switcher */}
      <aside aria-label="Server switcher" className="w-full min-w-0 sm:w-16 sm:shrink-0">
        <div className="flex items-center gap-2 sm:sticky sm:top-32 sm:flex-col sm:gap-3">
          <div className="hidden shrink-0 text-center text-[10px] font-bold tracking-wider text-[#33ccbb] sm:mb-2 sm:block">
            SERVERS
          </div>
          <Suspense fallback={<GuildSidebarFallback />}>
            {hydrated ? <GuildSidebarContent /> : <GuildSidebarFallback />}
          </Suspense>
        </div>
      </aside>

      {/* Content Area - Renders child routes */}
      <div className="min-h-[400px] min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
