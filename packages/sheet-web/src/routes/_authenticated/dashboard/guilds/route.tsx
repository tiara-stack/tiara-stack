import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { Suspense } from "react";
import { Effect } from "effect";
import { Discord } from "sheet-ingress-api/schemas";
import { Avatar, AvatarImage, AvatarFallback } from "#/components/ui/avatar";
import { Skeleton } from "#/components/ui/skeleton";
import { currentUserGuildsAtom, useCurrentUserGuilds } from "#/lib/discord";
import { ensureResultAtomData } from "#/lib/atomRegistry";

// Infer the type from the Schema
type DiscordGuildType = typeof Discord.DiscordGuild.Type;

// Loading fallback for guild sidebar
function GuildSidebarFallback() {
  return (
    <div className="flex flex-col gap-3 items-center w-full">
      <Skeleton className="w-12 h-12 rounded-lg bg-[#33ccbb]/20" />
      <Skeleton className="w-12 h-12 rounded-lg bg-[#33ccbb]/20" />
      <Skeleton className="w-12 h-12 rounded-lg bg-[#33ccbb]/20" />
    </div>
  );
}

function GuildIcon({ guild }: { guild: DiscordGuildType }) {
  const iconUrl = guild.icon
    ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png`
    : null;

  return (
    <Link
      to="/dashboard/guilds/$guildId/schedule"
      params={{ guildId: guild.id }}
      className="block"
      title={guild.name}
    >
      <Avatar className="w-12 h-12 rounded-lg border border-[#33ccbb]/30 hover:border-[#33ccbb] transition-colors after:rounded-lg">
        {iconUrl ? (
          <AvatarImage src={iconUrl} alt={guild.name} className="rounded-lg object-cover" />
        ) : null}
        <AvatarFallback delay={0} className="relative rounded-lg bg-[#0f1615] text-[#33ccbb]">
          {iconUrl && (
            <Skeleton className="absolute inset-0 size-full rounded-lg bg-[#33ccbb]/20" />
          )}
          <span className="relative z-10 font-black text-sm">
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
    return <div className="text-white/40 text-xs font-medium text-center">NO GUILDS</div>;
  }

  return (
    <div className="flex flex-col gap-3 items-center w-full overflow-y-auto max-h-[calc(100vh-280px)] pr-1">
      {guilds.map((guild) => (
        <GuildIcon key={guild.id} guild={guild} />
      ))}
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/dashboard/guilds")({
  component: GuildsLayout,
  loader: async ({ context }) => {
    await Effect.runPromise(
      ensureResultAtomData(context.atomRegistry, currentUserGuildsAtom).pipe(
        Effect.catch(() => Effect.succeed([])),
      ),
    );
  },
});

function GuildsLayout() {
  return (
    <div className="flex gap-6">
      {/* Guild Sidebar */}
      <div className="w-16 flex-shrink-0">
        <div className="sticky top-32 flex flex-col gap-3 items-center">
          <div className="text-[10px] font-bold text-[#33ccbb] tracking-wider text-center mb-2">
            GUILDS
          </div>
          <Suspense fallback={<GuildSidebarFallback />}>
            <GuildSidebarContent />
          </Suspense>
        </div>
      </div>

      {/* Content Area - Renders child routes */}
      <div className="flex-1 min-h-[400px]">
        <Outlet />
      </div>
    </div>
  );
}
