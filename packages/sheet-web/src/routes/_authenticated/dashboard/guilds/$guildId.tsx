import { createFileRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { Effect, Predicate } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { CalendarDays, Settings2, ShieldCheck, Table2 } from "lucide-react";
import { isSheetEditorPath } from "#/routes";
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
  const { pathname } = useLocation();
  const isSheetEditor = isSheetEditorPath(pathname);
  const guilds = useCurrentUserGuilds();
  const guild = guilds.find((candidate) => candidate.id === guildId);
  const permissionResult = useGuildPermissionsResult(guildId);
  const capabilities = guildCapabilities(permissionsFromResult(permissionResult), guildId);
  const iconUrl =
    Predicate.isNotUndefined(guild) && Predicate.isNotNull(guild.icon)
      ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png`
      : undefined;

  return (
    <div className={`min-w-0 ${isSheetEditor ? "space-y-2 sm:space-y-3" : "space-y-5"}`}>
      <div
        className={`relative min-w-0 overflow-hidden border border-[#33ccbb]/25 ${isSheetEditor ? "bg-[#0b1210]" : "bg-[#0d1513]"}`}
      >
        <div
          className={`absolute inset-y-0 right-0 w-48 bg-[linear-gradient(135deg,transparent_40%,rgba(51,204,187,0.08)_40%,rgba(51,204,187,0.08)_60%,transparent_60%)] bg-[length:18px_18px] ${isSheetEditor ? "hidden" : "block"}`}
        />
        <div
          className={`relative flex min-w-0 flex-col sm:flex-row sm:items-center sm:justify-between ${isSheetEditor ? "gap-2 px-3 py-2 sm:gap-4 sm:px-5 sm:py-4" : "gap-4 px-5 py-4"}`}
        >
          <div className="flex min-w-0 items-center gap-4">
            <div
              className={`flex shrink-0 items-center justify-center overflow-hidden border border-[#33ccbb]/35 bg-[#09110f] ${isSheetEditor ? "h-9 w-9 sm:h-12 sm:w-12" : "h-12 w-12"}`}
            >
              {iconUrl ? (
                <img className="h-full w-full object-cover" src={iconUrl} alt="" />
              ) : (
                <span className="font-mono text-sm font-black text-[#33ccbb]">
                  {(guild?.name ?? "??").slice(0, 2).toUpperCase()}
                </span>
              )}
            </div>
            <div className="min-w-0">
              <p
                className={`text-[10px] font-black tracking-[0.22em] text-[#33ccbb] ${isSheetEditor ? "hidden sm:block" : ""}`}
              >
                ACTIVE SERVER
              </p>
              <h2
                className={`truncate font-black tracking-tight ${isSheetEditor ? "text-base sm:text-lg" : "text-lg"}`}
              >
                {guild?.name ?? "Unknown server"}
              </h2>
              <p
                className={`truncate font-mono text-[11px] text-white/35 ${isSheetEditor ? "hidden sm:block" : ""}`}
              >
                {guildId}
              </p>
              {isSheetEditor ? (
                <p className="mt-0.5 font-mono text-[9px] font-black tracking-[0.14em] text-[#73e9dc] sm:hidden">
                  SHEET MAP
                </p>
              ) : null}
            </div>
          </div>
          <div
            className={
              isSheetEditor
                ? "hidden w-full min-w-0 flex-wrap gap-px bg-[#33ccbb]/20 sm:flex sm:w-auto sm:flex-nowrap"
                : "flex w-full min-w-0 flex-wrap gap-px bg-[#33ccbb]/20 sm:w-auto sm:flex-nowrap"
            }
          >
            <Link
              to="/dashboard/guilds/$guildId/schedule"
              params={{ guildId }}
              activeOptions={{ includeSearch: false }}
              className="group flex min-w-0 flex-1 items-center justify-center gap-2 whitespace-nowrap bg-[#0a0f0e] px-2 py-3 text-center text-xs font-black tracking-wide text-white transition hover:bg-[#33ccbb]/10 [&.active]:bg-[#33ccbb] [&.active]:text-[#07100e] sm:flex-none sm:px-4"
            >
              <CalendarDays className="h-4 w-4 text-[#33ccbb] group-[.active]:text-[#07100e]" />
              SCHEDULE
            </Link>
            {capabilities.canLockdown ? (
              <Link
                to="/dashboard/guilds/$guildId/settings"
                params={{ guildId }}
                search={{ section: capabilities.canManage ? "server" : "channels" }}
                activeOptions={{ exact: true, includeSearch: false }}
                className="group flex min-w-0 flex-1 items-center justify-center gap-2 whitespace-nowrap bg-[#0a0f0e] px-2 py-3 text-center text-xs font-black tracking-wide text-white transition hover:bg-[#33ccbb]/10 [&.active]:bg-[#33ccbb] [&.active]:text-[#07100e] sm:flex-none sm:px-4"
              >
                <Settings2 className="h-4 w-4 text-[#33ccbb] group-[.active]:text-[#07100e]" />
                SETTINGS
              </Link>
            ) : null}
            {capabilities.canManage ? (
              <Link
                to="/dashboard/guilds/$guildId/settings/sheet"
                params={{ guildId }}
                activeOptions={{ includeSearch: false }}
                className="group flex min-w-0 flex-1 items-center justify-center gap-2 whitespace-nowrap bg-[#0a0f0e] px-2 py-3 text-center text-xs font-black tracking-wide text-white transition hover:bg-[#33ccbb]/10 [&.active]:bg-[#33ccbb] [&.active]:text-[#07100e] sm:flex-none sm:px-4"
              >
                <Table2 className="h-4 w-4 text-[#33ccbb] group-[.active]:text-[#07100e]" />
                SHEET MAP
              </Link>
            ) : null}
          </div>
        </div>
        {capabilities.canManage && !isSheetEditor ? (
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
