import { createFileRoute, redirect } from "@tanstack/react-router";
import { Suspense, useState } from "react";
import { Calendar, Users, ChevronRight } from "lucide-react";
import { Discord } from "sheet-apis/schema";
import { Registry } from "@effect-atom/atom-react";
import { Effect, Option } from "effect";
import { sessionAtom } from "#/lib/auth";
import { useCurrentUserGuilds } from "#/lib/discord";

// Infer the type from the Schema
type DiscordGuildType = typeof Discord.DiscordGuild.Type;

// Loading fallback for guild sidebar
function GuildSidebarFallback() {
  return (
    <div className="flex flex-col gap-3">
      <div className="w-12 h-12 bg-[#33ccbb]/10 animate-pulse rounded-lg" />
      <div className="w-12 h-12 bg-[#33ccbb]/10 animate-pulse rounded-lg" />
      <div className="w-12 h-12 bg-[#33ccbb]/10 animate-pulse rounded-lg" />
    </div>
  );
}

// Route loader that fetches session on load using Atom Registry
export const Route = createFileRoute("/dashboard")({
  component: DashboardPage,
  beforeLoad: async ({ context }) => {
    const session = await Effect.runPromise(
      Registry.getResult(context.atomRegistry, sessionAtom).pipe(
        Effect.catchAll(() => Effect.succeedNone),
      ),
    );

    // Redirect to home if not authenticated
    if (Option.isNone(session)) {
      throw redirect({ to: "/" });
    }
  },
});

function GuildIcon({ guild }: { guild: DiscordGuildType }) {
  const iconUrl = guild.icon
    ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png`
    : null;

  return (
    <div
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
    </div>
  );
}

function GuildSidebarContent() {
  const guilds = useCurrentUserGuilds();

  if (guilds.length === 0) {
    return <div className="text-white/40 text-xs font-medium text-center">NO GUILDS</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      {guilds.map((guild) => (
        <GuildIcon key={guild.id} guild={guild} />
      ))}
    </div>
  );
}

function DashboardPage() {
  const [activeTab, setActiveTab] = useState<"my-shifts" | "guilds">("my-shifts");

  return (
    <div className="min-h-screen text-white pt-32 pb-12 px-8">
      <div className="max-w-7xl mx-auto">
        {/* Page Header */}
        <div className="mb-12">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-1 h-8 bg-[#33ccbb]" />
            <p className="text-sm font-bold tracking-[0.3em] text-[#33ccbb]">DASHBOARD</p>
          </div>
          <h1 className="text-5xl sm:text-6xl font-black tracking-tight">
            YOUR <span className="text-[#33ccbb]">SCHEDULE</span>
          </h1>
        </div>

        {/* Tab Navigation - Brutalist Style */}
        <div className="flex flex-col sm:flex-row gap-px bg-[#33ccbb]/20 mb-12">
          <button
            onClick={() => setActiveTab("my-shifts")}
            className={`flex-1 flex items-center justify-between px-8 py-6 font-black text-lg tracking-wide transition-all duration-200 group ${
              activeTab === "my-shifts"
                ? "bg-[#33ccbb] text-[#0a0f0e]"
                : "bg-[#0f1615] text-white hover:bg-[#33ccbb]/10"
            }`}
          >
            <div className="flex items-center gap-4">
              <Calendar
                className={`w-6 h-6 ${
                  activeTab === "my-shifts" ? "text-[#0a0f0e]" : "text-[#33ccbb]"
                }`}
              />
              <span>MY SHIFTS</span>
            </div>
            <ChevronRight
              className={`w-5 h-5 transition-transform ${
                activeTab === "my-shifts" ? "rotate-90" : "group-hover:translate-x-1"
              }`}
            />
          </button>

          <button
            onClick={() => setActiveTab("guilds")}
            className={`flex-1 flex items-center justify-between px-8 py-6 font-black text-lg tracking-wide transition-all duration-200 group ${
              activeTab === "guilds"
                ? "bg-[#33ccbb] text-[#0a0f0e]"
                : "bg-[#0f1615] text-white hover:bg-[#33ccbb]/10"
            }`}
          >
            <div className="flex items-center gap-4">
              <Users
                className={`w-6 h-6 ${
                  activeTab === "guilds" ? "text-[#0a0f0e]" : "text-[#33ccbb]"
                }`}
              />
              <span>GUILDS</span>
            </div>
            <ChevronRight
              className={`w-5 h-5 transition-transform ${
                activeTab === "guilds" ? "rotate-90" : "group-hover:translate-x-1"
              }`}
            />
          </button>
        </div>

        {/* Main Content with optional Guild Sidebar */}
        <div className="flex gap-6">
          {/* Guild Sidebar - Only visible on Guilds tab */}
          {activeTab === "guilds" && (
            <div className="w-16 flex-shrink-0">
              <div className="sticky top-32 flex flex-col gap-3">
                <div className="text-[10px] font-bold text-[#33ccbb] tracking-wider text-center mb-2">
                  GUILDS
                </div>
                <Suspense fallback={<GuildSidebarFallback />}>
                  <GuildSidebarContent />
                </Suspense>
              </div>
            </div>
          )}

          {/* Content Area */}
          <div className="flex-1 min-h-[400px]">
            {activeTab === "my-shifts" && (
              <div className="border border-[#33ccbb]/20 bg-[#0f1615] p-12">
                <div className="flex items-center gap-4 mb-8">
                  <div className="w-12 h-12 bg-[#33ccbb]/10 flex items-center justify-center">
                    <Calendar className="w-6 h-6 text-[#33ccbb]" />
                  </div>
                  <h2 className="text-3xl font-black tracking-tight">UPCOMING SHIFTS</h2>
                </div>
                <div className="h-64 flex items-center justify-center border-2 border-dashed border-[#33ccbb]/20">
                  <p className="text-white/40 font-medium tracking-wide">NO UPCOMING SHIFTS</p>
                </div>
              </div>
            )}

            {activeTab === "guilds" && (
              <div className="border border-[#33ccbb]/20 bg-[#0f1615] p-12">
                <div className="flex items-center gap-4 mb-8">
                  <div className="w-12 h-12 bg-[#33ccbb]/10 flex items-center justify-center">
                    <Users className="w-6 h-6 text-[#33ccbb]" />
                  </div>
                  <h2 className="text-3xl font-black tracking-tight">YOUR GUILDS</h2>
                </div>
                <div className="h-64 flex items-center justify-center border-2 border-dashed border-[#33ccbb]/20">
                  <p className="text-white/40 font-medium tracking-wide">
                    SELECT A GUILD FROM THE SIDEBAR
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Bottom Stats Bar */}
        <div className="mt-12 grid grid-cols-1 sm:grid-cols-3 gap-px bg-[#33ccbb]/20">
          <div className="bg-[#0f1615] p-6 flex items-center justify-between">
            <div>
              <p className="text-4xl font-black text-[#33ccbb]">0</p>
              <p className="text-sm font-bold text-white/50 tracking-wide">UPCOMING</p>
            </div>
            <div className="w-12 h-12 border border-[#33ccbb]/30 flex items-center justify-center">
              <Calendar className="w-5 h-5 text-[#33ccbb]" />
            </div>
          </div>
          <div className="bg-[#0f1615] p-6 flex items-center justify-between">
            <div>
              <p className="text-4xl font-black text-[#33ccbb]">0</p>
              <p className="text-sm font-bold text-white/50 tracking-wide">GUILDS</p>
            </div>
            <div className="w-12 h-12 border border-[#33ccbb]/30 flex items-center justify-center">
              <Users className="w-5 h-5 text-[#33ccbb]" />
            </div>
          </div>
          <div className="bg-[#0f1615] p-6 flex items-center justify-between">
            <div>
              <p className="text-4xl font-black text-[#33ccbb]">0</p>
              <p className="text-sm font-bold text-white/50 tracking-wide">COMPLETED</p>
            </div>
            <div className="w-12 h-12 border border-[#33ccbb]/30 flex items-center justify-center">
              <ChevronRight className="w-5 h-5 text-[#33ccbb]" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
