import { createFileRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { Effect } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useRef, useState } from "react";
import { ArrowLeft, CalendarDays, ChevronDown, Settings2, ShieldCheck, Table2 } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "#/components/ui/avatar";
import { isSheetEditorPath } from "#/routes";
import { ensureResultAtomData, isBrowserRuntime } from "#/lib/atomRegistry";
import { useDismissOnOutsideOrEscape } from "#/lib/documentEvents";
import {
  currentUserGuildsAtom,
  guildIconUrl,
  useCurrentUserGuilds,
  type DiscordGuild,
} from "#/lib/discord";
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

function ServerAdministrationLinks({
  canLockdown,
  canManage,
  guildId,
}: {
  readonly canLockdown: boolean;
  readonly canManage: boolean;
  readonly guildId: string;
}) {
  return (
    <nav
      aria-label="Server administration"
      className="flex w-full min-w-0 flex-col gap-px bg-[#33ccbb]/20 sm:w-auto sm:flex-row"
    >
      {canLockdown ? (
        <Link
          to={
            canManage
              ? "/dashboard/guilds/$guildId/settings/server"
              : "/dashboard/guilds/$guildId/settings/channels"
          }
          params={{ guildId }}
          activeOptions={{ exact: true, includeSearch: false }}
          className="group flex min-h-11 min-w-0 flex-1 items-center justify-start gap-2 whitespace-nowrap bg-[#0a0f0e] px-3 py-3 text-left text-[11px] font-black tracking-wide text-white transition hover:bg-[#33ccbb]/10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#73e9dc] [&.active]:bg-[#33ccbb] [&.active]:text-[#07100e] sm:min-h-0 sm:justify-center sm:px-4 sm:text-xs"
        >
          <Settings2 className="h-4 w-4 shrink-0 text-[#33ccbb] group-[.active]:text-[#07100e]" />
          SERVER SETTINGS
        </Link>
      ) : null}
      {canManage ? (
        <Link
          to="/dashboard/guilds/$guildId/settings/sheet"
          params={{ guildId }}
          activeOptions={{ includeSearch: false }}
          className="group flex min-h-11 min-w-0 flex-1 items-center justify-start gap-2 whitespace-nowrap bg-[#0a0f0e] px-3 py-3 text-left text-[11px] font-black tracking-wide text-white transition hover:bg-[#33ccbb]/10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#73e9dc] [&.active]:bg-[#33ccbb] [&.active]:text-[#07100e] sm:min-h-0 sm:justify-center sm:px-4 sm:text-xs"
        >
          <Table2 className="h-4 w-4 shrink-0 text-[#33ccbb] group-[.active]:text-[#07100e]" />
          SHEET MAPPINGS
        </Link>
      ) : null}
    </nav>
  );
}

function ServerChooserAvatar({ guild }: { readonly guild: DiscordGuild }) {
  const iconUrl = guildIconUrl(guild);

  return (
    <Avatar className="h-8 w-8 shrink-0 rounded-lg border border-[#33ccbb]/30">
      {iconUrl ? <AvatarImage src={iconUrl} alt="" className="rounded-lg object-cover" /> : null}
      <AvatarFallback delay={0} className="rounded-lg bg-[#111b19] text-xs text-[#33ccbb]">
        {guild.name.slice(0, 2).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

function ServerChooserOption({
  guild,
  selected,
}: {
  readonly guild: DiscordGuild;
  readonly selected: boolean;
}) {
  return (
    <Link
      to="/dashboard/guilds/$guildId/schedule"
      params={{ guildId: guild.id }}
      aria-current={selected ? "page" : undefined}
      className="flex min-h-11 items-center gap-3 px-3 py-2 text-white transition-colors hover:bg-[#33ccbb]/10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#73e9dc] aria-[current=page]:bg-[#33ccbb]/15"
    >
      <ServerChooserAvatar guild={guild} />
      <span className="min-w-0 flex-1 break-words text-sm font-bold leading-5">{guild.name}</span>
      {selected ? (
        <span className="shrink-0 text-[10px] font-black tracking-wide text-[#33ccbb]">
          CURRENT
        </span>
      ) : null}
    </Link>
  );
}

function ServerChooser({
  guildId,
  guilds,
}: {
  readonly guildId: string;
  readonly guilds: ReturnType<typeof useCurrentUserGuilds>;
}) {
  const guild = guilds.find((candidate) => candidate.id === guildId);
  const guildName = guild?.name ?? "Unknown server";
  const [isOpen, setIsOpen] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const closeMenu = useCallback(() => {
    if (detailsRef.current !== null) {
      detailsRef.current.open = false;
    }
    setIsOpen(false);
  }, []);

  useDismissOnOutsideOrEscape(isOpen, detailsRef, triggerRef, closeMenu);

  return (
    <details
      ref={detailsRef}
      key={guildId}
      className="group relative min-w-0"
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary
        ref={triggerRef}
        aria-label={`Switch server. Current server: ${guildName}`}
        className="flex min-h-11 max-w-full cursor-pointer list-none items-center gap-2 text-left text-base font-black tracking-tight text-white transition-colors hover:text-[#33ccbb] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc] sm:text-lg [&::-webkit-details-marker]:hidden"
      >
        <span className="min-w-0 break-words">{guildName}</span>
        <ChevronDown
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-[#33ccbb] transition-transform group-open:rotate-180"
        />
      </summary>

      <div className="absolute left-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] border border-[#33ccbb]/35 bg-[#0f1615] p-1 shadow-xl">
        <p className="border-b border-[#33ccbb]/20 px-3 py-2 text-[10px] font-black tracking-[0.18em] text-[#33ccbb]">
          SWITCH SERVER
        </p>
        {guilds.length > 0 ? (
          <nav aria-label="Available servers" className="max-h-72 overflow-y-auto pt-1">
            {guilds.map((candidate) => (
              <ServerChooserOption
                key={candidate.id}
                guild={candidate}
                selected={candidate.id === guildId}
              />
            ))}
          </nav>
        ) : (
          <p className="px-3 py-4 text-sm text-white/55">No servers available.</p>
        )}
      </div>
    </details>
  );
}

// fallow-ignore-next-line complexity
function SelectedGuildLayout() {
  const { guildId } = Route.useParams();
  const { pathname } = useLocation();
  const isSheetEditor = isSheetEditorPath(pathname);
  const isServerAdministrationPath = pathname.includes("/settings");
  const [adminNavOverride, setAdminNavOverride] = useState<
    { readonly pathname: string; readonly open: boolean } | undefined
  >();
  const isAdminNavOpen =
    adminNavOverride?.pathname === pathname ? adminNavOverride.open : isServerAdministrationPath;
  const guilds = useCurrentUserGuilds();
  const guild = guilds.find((candidate) => candidate.id === guildId);
  const permissionResult = useGuildPermissionsResult(guildId);
  const capabilities = guildCapabilities(permissionsFromResult(permissionResult), guildId);
  const iconUrl = guild === undefined ? null : guildIconUrl(guild);

  return (
    <div
      className={`min-w-0 ${isSheetEditor ? "space-y-2 sm:space-y-3" : "space-y-2 sm:space-y-5"}`}
    >
      <Link
        to="/dashboard/guilds"
        className="inline-flex min-h-11 items-center gap-2 border border-[#33ccbb]/25 bg-[#0f1615] px-3 py-2 text-xs font-black tracking-wide text-[#33ccbb] transition-colors hover:bg-[#33ccbb]/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc]"
      >
        <ArrowLeft aria-hidden="true" className="h-4 w-4" />
        BACK TO SERVER LIST
      </Link>
      <div
        className={`relative min-w-0 overflow-visible border border-[#33ccbb]/25 ${isSheetEditor ? "bg-[#0b1210]" : "bg-[#0d1513]"}`}
      >
        <div
          className={`absolute inset-y-0 right-0 w-48 bg-[linear-gradient(135deg,transparent_40%,rgba(51,204,187,0.08)_40%,rgba(51,204,187,0.08)_60%,transparent_60%)] bg-[length:18px_18px] ${isSheetEditor ? "hidden" : "block"}`}
        />
        <div className="relative flex min-w-0 flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-5 sm:py-4">
          <div className="flex min-w-0 items-center justify-between gap-3 sm:gap-4">
            <div className="flex min-w-0 items-center gap-3 sm:gap-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden border border-[#33ccbb]/35 bg-[#09110f] sm:h-12 sm:w-12">
                {iconUrl ? (
                  <img className="h-full w-full object-cover" src={iconUrl} alt="" />
                ) : (
                  <span className="font-mono text-sm font-black text-[#33ccbb]">
                    {(guild?.name ?? "??").slice(0, 2).toUpperCase()}
                  </span>
                )}
              </div>
              <div className="min-w-0">
                <p className="hidden text-[10px] font-black tracking-[0.22em] text-[#33ccbb] sm:block">
                  ACTIVE SERVER
                </p>
                <ServerChooser guildId={guildId} guilds={guilds} />
                <p className="hidden truncate font-mono text-[11px] text-white/35 sm:block">
                  {guildId}
                </p>
              </div>
            </div>
            <nav
              aria-label="Schedule navigation"
              className="flex shrink-0 bg-[#33ccbb]/20 sm:hidden"
            >
              <Link
                to="/dashboard/guilds/$guildId/schedule"
                params={{ guildId }}
                activeOptions={{ includeSearch: false }}
                className="group flex min-h-11 items-center justify-center gap-2 bg-[#0a0f0e] px-3 text-xs font-black tracking-wide text-white transition hover:bg-[#33ccbb]/10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#73e9dc] [&.active]:bg-[#33ccbb] [&.active]:text-[#07100e]"
              >
                <CalendarDays className="h-4 w-4 text-[#33ccbb] group-[.active]:text-[#07100e]" />
                SCHEDULE
              </Link>
            </nav>
          </div>
          <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:items-end sm:gap-3">
            <nav
              aria-label="Schedule navigation"
              className="hidden w-full min-w-0 bg-[#33ccbb]/20 sm:flex sm:w-auto"
            >
              <Link
                to="/dashboard/guilds/$guildId/schedule"
                params={{ guildId }}
                activeOptions={{ includeSearch: false }}
                className="group flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2 whitespace-nowrap bg-[#0a0f0e] px-2 py-3 text-center text-xs font-black tracking-wide text-white transition hover:bg-[#33ccbb]/10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#73e9dc] [&.active]:bg-[#33ccbb] [&.active]:text-[#07100e] sm:min-h-0 sm:flex-none sm:px-4"
              >
                <CalendarDays className="h-4 w-4 text-[#33ccbb] group-[.active]:text-[#07100e]" />
                SCHEDULE
              </Link>
            </nav>
            {capabilities.canLockdown || capabilities.canManage ? (
              <div className="min-w-0">
                <div className="sm:hidden">
                  <button
                    type="button"
                    aria-controls="mobile-server-administration"
                    aria-expanded={isAdminNavOpen}
                    className="flex min-h-11 w-full items-center justify-between gap-3 whitespace-nowrap border border-[#33ccbb]/20 bg-[#33ccbb]/[0.06] px-3 py-3 text-left text-[10px] font-black tracking-[0.14em] text-[#33ccbb] transition hover:bg-[#33ccbb]/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc]"
                    onClick={() => setAdminNavOverride({ pathname, open: !isAdminNavOpen })}
                  >
                    <span>SERVER ADMINISTRATION</span>
                    <ChevronDown
                      aria-hidden="true"
                      className={`h-4 w-4 shrink-0 transition-transform ${isAdminNavOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                  <div id="mobile-server-administration" className="mt-1" hidden={!isAdminNavOpen}>
                    <ServerAdministrationLinks
                      canLockdown={capabilities.canLockdown}
                      canManage={capabilities.canManage}
                      guildId={guildId}
                    />
                  </div>
                </div>
                <div className="hidden min-w-0 flex-col gap-1 sm:flex">
                  <p className="px-1 text-[10px] font-black tracking-[0.2em] text-[#33ccbb] sm:text-right">
                    SERVER ADMINISTRATION
                  </p>
                  <ServerAdministrationLinks
                    canLockdown={capabilities.canLockdown}
                    canManage={capabilities.canManage}
                    guildId={guildId}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </div>
        {capabilities.canManage && !isSheetEditor ? (
          <div className="relative hidden items-center gap-2 border-t border-[#33ccbb]/15 bg-[#33ccbb]/[0.04] px-5 py-2 text-[10px] font-bold tracking-wide text-white/45 sm:flex">
            <ShieldCheck className="h-3.5 w-3.5 text-[#33ccbb]" />
            MANAGE SERVER ACCESS VERIFIED
          </div>
        ) : null}
      </div>
      <Outlet />
    </div>
  );
}
