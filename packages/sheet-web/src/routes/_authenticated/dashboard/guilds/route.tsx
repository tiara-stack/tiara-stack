import { createFileRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { Suspense } from "react";
import { Effect } from "effect";
import { Avatar, AvatarImage, AvatarFallback } from "#/components/ui/avatar";
import { Skeleton } from "#/components/ui/skeleton";
import { currentUserGuildsAtom, useCurrentUserGuilds, type DiscordGuild } from "#/lib/discord";
import { ensureResultAtomData, isBrowserRuntime } from "#/lib/atomRegistry";
import { isSheetEditorPath } from "#/routes";

// Loading fallback for guild sidebar
function GuildSidebarFallback() {
  return (
    <div className="flex min-w-0 flex-row items-center gap-3 overflow-x-auto pb-1 sm:w-full sm:flex-col sm:overflow-x-visible">
      <Skeleton className="h-12 w-12 shrink-0 rounded-lg bg-[#33ccbb]/20" />
      <Skeleton className="h-12 w-12 shrink-0 rounded-lg bg-[#33ccbb]/20" />
      <Skeleton className="h-12 w-12 shrink-0 rounded-lg bg-[#33ccbb]/20" />
    </div>
  );
}

function GuildIcon({ guild }: { guild: DiscordGuild }) {
  const iconUrl = guild.icon
    ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png`
    : null;

  return (
    <Link
      to="/dashboard/guilds/$guildId/schedule"
      params={{ guildId: guild.id }}
      className="block shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc]"
      aria-label={guild.name}
      title={guild.name}
    >
      <Avatar className="h-12 w-12 rounded-lg border border-[#33ccbb]/30 transition-colors after:rounded-lg hover:border-[#33ccbb]">
        {iconUrl ? (
          <AvatarImage src={iconUrl} alt={guild.name} className="rounded-lg object-cover" />
        ) : null}
        <AvatarFallback delay={0} className="relative rounded-lg bg-[#0f1615] text-[#33ccbb]">
          {iconUrl && (
            <Skeleton className="absolute inset-0 size-full rounded-lg bg-[#33ccbb]/20" />
          )}
          <span className="relative z-10 text-sm font-black">
            {guild.name.slice(0, 2).toUpperCase()}
          </span>
        </AvatarFallback>
      </Avatar>
    </Link>
  );
}

function GuildSidebarContent() {
  const guilds = useCurrentUserGuilds();

  if (guilds.length === 0) {
    return <div className="text-center text-xs font-medium text-white/40">NO GUILDS</div>;
  }

  return (
    <div className="flex min-w-0 flex-1 flex-row items-center gap-3 overflow-x-auto pb-1 sm:w-full sm:flex-none sm:flex-col sm:overflow-x-hidden sm:overflow-y-auto sm:max-h-[calc(100vh-280px)] sm:pr-1">
      {guilds.map((guild) => (
        <GuildIcon key={guild.id} guild={guild} />
      ))}
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/dashboard/guilds")({
  component: GuildsLayout,
  loader: async ({ context }) => {
    if (!isBrowserRuntime()) return;
    await Effect.runPromise(
      ensureResultAtomData(context.atomRegistry, currentUserGuildsAtom).pipe(
        Effect.catch(() => Effect.succeed([])),
      ),
    );
  },
});

function GuildsLayout() {
  const { pathname } = useLocation();
  const isSheetEditor = isSheetEditorPath(pathname);

  return (
    <div
      className={`flex min-w-0 flex-col sm:flex-row sm:gap-6 ${isSheetEditor ? "gap-2" : "gap-4"}`}
    >
      {/* Guild Sidebar */}
      <div className="w-full min-w-0 sm:w-16 sm:shrink-0">
        <div className="flex items-center gap-3 sm:sticky sm:top-32 sm:flex-col sm:gap-3">
          <div
            className={`shrink-0 text-center text-[10px] font-bold tracking-wider text-[#33ccbb] sm:mb-2 ${isSheetEditor ? "hidden sm:block" : ""}`}
          >
            GUILDS
          </div>
          <Suspense fallback={<GuildSidebarFallback />}>
            <GuildSidebarContent />
          </Suspense>
        </div>
      </div>

      {/* Content Area - Renders child routes */}
      <div className="min-h-[400px] min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
