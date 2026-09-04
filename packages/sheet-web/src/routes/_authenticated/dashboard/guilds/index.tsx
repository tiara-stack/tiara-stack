import { createFileRoute, Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import { ArrowRight } from "lucide-react";
import { Suspense } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "#/components/ui/avatar";
import {
  guildIconUrl,
  useCurrentUserGuildsResult,
  useRefreshCurrentUserGuilds,
  type DiscordGuild,
} from "#/lib/discord";
import { useHydrated } from "#/hooks/useHydrated";

export const Route = createFileRoute("/_authenticated/dashboard/guilds/")({
  component: GuildsIndexPage,
});

function GuildsIndexPage() {
  const hydrated = useHydrated();

  if (!hydrated) {
    return <GuildChooserPending />;
  }

  return (
    <Suspense fallback={<GuildChooserPending />}>
      <GuildChooser />
    </Suspense>
  );
}

function GuildChooserPending() {
  return (
    <section
      aria-labelledby="server-chooser-title"
      aria-busy="true"
      className="border border-[#33ccbb]/20 bg-[#0f1615] p-6 sm:p-8"
    >
      <div className="flex min-h-48 flex-col justify-center px-1 py-4 sm:px-4">
        <h1
          id="server-chooser-title"
          className="text-xl font-black tracking-tight text-white sm:text-2xl"
        >
          YOUR SERVERS
        </h1>
        <p className="mt-3 text-sm leading-6 text-white/60">Loading your server list…</p>
      </div>
    </section>
  );
}

function GuildChooser() {
  const guildsResult = useCurrentUserGuildsResult();
  const refreshGuilds = useRefreshCurrentUserGuilds();

  return (
    <section
      aria-labelledby="server-chooser-title"
      className="border border-[#33ccbb]/20 bg-[#0f1615] p-6 sm:p-8"
    >
      <div className="px-1 sm:px-4">
        <h1
          id="server-chooser-title"
          className="text-xl font-black tracking-tight text-white sm:text-2xl"
        >
          YOUR SERVERS
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-white/60">
          Select a server to open its current schedule. The server rail stays available for quick
          switching.
        </p>
      </div>

      {AsyncResult.isFailure(guildsResult) ? (
        <div
          role="alert"
          aria-busy={guildsResult.waiting}
          className="mt-8 border-2 border-dashed border-red-300/25 px-5 py-8"
        >
          <p className="text-sm font-black tracking-wide text-white">SERVERS UNAVAILABLE</p>
          <p className="mt-2 text-sm leading-6 text-white/55">
            We couldn&apos;t load your server list. Try again before checking your membership.
          </p>
          <button
            type="button"
            className="mt-5 border border-[#33ccbb]/35 px-4 py-3 text-xs font-black tracking-wide text-[#33ccbb] transition hover:bg-[#33ccbb]/10 disabled:cursor-wait disabled:opacity-50"
            disabled={guildsResult.waiting}
            onClick={refreshGuilds}
          >
            {guildsResult.waiting ? "RETRYING…" : "RETRY SERVER LIST"}
          </button>
        </div>
      ) : guildsResult.value.length > 0 ? (
        <div className="mt-8 grid gap-px border border-[#33ccbb]/20 bg-[#33ccbb]/20 sm:grid-cols-2">
          {guildsResult.value.map((guild) => (
            <GuildChooserLink key={guild.id} guild={guild} />
          ))}
        </div>
      ) : (
        <div
          role="status"
          aria-live="polite"
          className="mt-8 border-2 border-dashed border-[#33ccbb]/20 px-5 py-8"
        >
          <p className="text-sm font-black tracking-wide text-white">NO SERVERS AVAILABLE</p>
          <p className="mt-2 text-sm leading-6 text-white/55">
            Join or be invited to a Discord server connected to TiaraBot, then return here.
          </p>
        </div>
      )}
    </section>
  );
}

function GuildChooserLink({ guild }: { guild: DiscordGuild }) {
  const iconUrl = guildIconUrl(guild);

  return (
    <Link
      to="/dashboard/guilds/$guildId/schedule"
      params={{ guildId: guild.id }}
      aria-label={`Open ${guild.name} schedule`}
      title={guild.name}
      className="group flex min-h-16 min-w-0 items-center gap-3 bg-[#0a0f0e] px-4 py-3 text-white transition-colors hover:bg-[#33ccbb]/10 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#73e9dc]"
    >
      <Avatar className="h-10 w-10 shrink-0 rounded-lg border border-[#33ccbb]/35">
        {iconUrl ? <AvatarImage src={iconUrl} alt="" className="rounded-lg object-cover" /> : null}
        <AvatarFallback delay={0} className="rounded-lg bg-[#111b19] text-[#33ccbb]">
          <span className="text-xs font-black">{guild.name.slice(0, 2).toUpperCase()}</span>
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm font-black leading-5">{guild.name}</span>
        <span className="mt-1 block text-[10px] font-bold tracking-[0.16em] text-[#33ccbb]/70">
          OPEN SCHEDULE
        </span>
      </span>
      <ArrowRight
        aria-hidden="true"
        className="h-4 w-4 shrink-0 text-[#33ccbb] transition-transform group-hover:translate-x-1"
      />
    </Link>
  );
}
