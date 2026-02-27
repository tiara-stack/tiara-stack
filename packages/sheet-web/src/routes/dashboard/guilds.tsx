import { createFileRoute, Link } from "@tanstack/react-router";
import { Suspense } from "react";
import { Users } from "lucide-react";
import { format } from "date-fns";
import { Discord } from "sheet-apis/schema";
import { useCurrentUserGuilds } from "#/lib/discord";

// Infer the type from the Schema
type DiscordGuildType = typeof Discord.DiscordGuild.Type;

// Loading fallback for guild sidebar
function GuildSidebarFallback() {
  return (
    <div className="flex flex-col gap-3 items-center w-full">
      <div className="w-12 h-12 bg-[#33ccbb]/10 animate-pulse rounded-lg" />
      <div className="w-12 h-12 bg-[#33ccbb]/10 animate-pulse rounded-lg" />
      <div className="w-12 h-12 bg-[#33ccbb]/10 animate-pulse rounded-lg" />
    </div>
  );
}

function GuildIcon({ guild }: { guild: DiscordGuildType }) {
  const iconUrl = guild.icon
    ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png`
    : null;

  // Calculate default date values for the link
  const now = new Date();
  const defaultMonth = format(now, "yyyy-MM");
  const defaultDay = format(now, "yyyy-MM-dd");

  return (
    <Link
      to="/dashboard/guilds/$guildId/schedule/calendar"
      params={{ guildId: guild.id }}
      search={{ month: defaultMonth, day: defaultDay }}
      className="w-12 h-12 rounded-lg bg-[#0f1615] border border-[#33ccbb]/30 flex items-center justify-center overflow-hidden hover:border-[#33ccbb] transition-colors cursor-pointer"
      title={guild.name}
    >
      {iconUrl ? (
        <img src={iconUrl} alt={guild.name} className="w-full h-full object-cover" />
      ) : (
        <span className="text-[#33ccbb] font-black text-sm">
          {guild.name.slice(0, 2).toUpperCase()}
        </span>
      )}
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

export const Route = createFileRoute("/dashboard/guilds")({
  component: GuildsPage,
});

function GuildsPage() {
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

      {/* Content Area */}
      <div className="flex-1 min-h-[400px]">
        <div className="border border-[#33ccbb]/20 bg-[#0f1615] p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-[#33ccbb]/10 flex items-center justify-center">
              <Users className="w-5 h-5 text-[#33ccbb]" />
            </div>
            <h2 className="text-xl font-black tracking-tight">YOUR GUILDS</h2>
          </div>
          <div className="h-48 flex items-center justify-center border-2 border-dashed border-[#33ccbb]/20">
            <p className="text-white/40 font-medium tracking-wide">
              SELECT A GUILD FROM THE SIDEBAR
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
