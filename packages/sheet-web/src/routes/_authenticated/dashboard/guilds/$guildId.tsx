import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { Effect, Predicate } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { CalendarDays, Settings2, ShieldCheck } from "lucide-react";
import { ensureResultAtomData, isBrowserRuntime } from "#/lib/atomRegistry";
import { currentUserGuildsAtom, useCurrentUserGuilds } from "#/lib/discord";
import {
  guildCapabilities,
  guildPermissionsAtom,
  permissionsFromResult,
  useGuildPermissionsResult,
} from "#/lib/guildConfig";

export const Route = createFileRoute("/_authenticated/dashboard/guilds/$guildId")({
  component: SelectedGuildLayout,
  loader: async ({ abortController, context, params }) => {
    if (!isBrowserRuntime()) return;
    const preload = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
      ensureResultAtomData(context.atomRegistry, atom).pipe(Effect.catch(() => Effect.void));

    await Effect.runPromise(
      Effect.all([preload(currentUserGuildsAtom), preload(guildPermissionsAtom(params.guildId))], {
        concurrency: 2,
        discard: true,
      }),
      { signal: abortController.signal },
    );
  },
});

// fallow-ignore-next-line complexity
function SelectedGuildLayout() {
  const { guildId } = Route.useParams();
  const guilds = useCurrentUserGuilds();
  const guild = guilds.find((candidate) => candidate.id === guildId);
  const permissionResult = useGuildPermissionsResult(guildId);
  const capabilities = guildCapabilities(permissionsFromResult(permissionResult), guildId);
  const iconUrl =
    Predicate.isNotUndefined(guild) && Predicate.isNotNull(guild.icon)
      ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png`
      : undefined;

  return (
    <div className="space-y-5">
      <div className="relative overflow-hidden border border-[#33ccbb]/25 bg-[#0d1513]">
        <div className="absolute inset-y-0 right-0 w-48 bg-[linear-gradient(135deg,transparent_40%,rgba(51,204,187,0.08)_40%,rgba(51,204,187,0.08)_60%,transparent_60%)] bg-[length:18px_18px]" />
        <div className="relative flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden border border-[#33ccbb]/35 bg-[#09110f]">
              {iconUrl ? (
                <img className="h-full w-full object-cover" src={iconUrl} alt="" />
              ) : (
                <span className="font-mono text-sm font-black text-[#33ccbb]">
                  {(guild?.name ?? "??").slice(0, 2).toUpperCase()}
                </span>
              )}
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-black tracking-[0.22em] text-[#33ccbb]">
                ACTIVE SERVER
              </p>
              <h2 className="truncate text-lg font-black tracking-tight">
                {guild?.name ?? "Unknown server"}
              </h2>
              <p className="truncate font-mono text-[11px] text-white/35">{guildId}</p>
            </div>
          </div>
          <div className="flex gap-px bg-[#33ccbb]/20">
            <Link
              to="/dashboard/guilds/$guildId/schedule"
              params={{ guildId }}
              activeOptions={{ includeSearch: false }}
              className="group flex items-center gap-2 bg-[#0a0f0e] px-4 py-3 text-xs font-black tracking-wide text-white transition hover:bg-[#33ccbb]/10 [&.active]:bg-[#33ccbb] [&.active]:text-[#07100e]"
            >
              <CalendarDays className="h-4 w-4 text-[#33ccbb] group-[.active]:text-[#07100e]" />
              SCHEDULE
            </Link>
            {capabilities.canLockdown ? (
              <Link
                to="/dashboard/guilds/$guildId/settings"
                params={{ guildId }}
                search={{ section: capabilities.canManage ? "server" : "channels" }}
                activeOptions={{ includeSearch: false }}
                className="group flex items-center gap-2 bg-[#0a0f0e] px-4 py-3 text-xs font-black tracking-wide text-white transition hover:bg-[#33ccbb]/10 [&.active]:bg-[#33ccbb] [&.active]:text-[#07100e]"
              >
                <Settings2 className="h-4 w-4 text-[#33ccbb] group-[.active]:text-[#07100e]" />
                SETTINGS
              </Link>
            ) : null}
          </div>
        </div>
        {capabilities.canManage ? (
          <div className="relative flex items-center gap-2 border-t border-[#33ccbb]/15 bg-[#33ccbb]/[0.04] px-5 py-2 text-[10px] font-bold tracking-wide text-white/45">
            <ShieldCheck className="h-3.5 w-3.5 text-[#33ccbb]" />
            MANAGE SERVER ACCESS VERIFIED
          </div>
        ) : null}
      </div>
      <Outlet />
    </div>
  );
}
