import { Dialog } from "@base-ui/react/dialog";
import { useAtomRefresh } from "@effect/atom-react";
import {
  createFileRoute,
  Outlet,
  type RegisteredRouter,
  useBlocker,
  useLocation,
} from "@tanstack/react-router";
import { Effect, Equal, Option, Predicate, Schema, pipe } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Hash,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RotateCcw,
  Save,
  Search,
  ServerCog,
  Shield,
  X,
} from "lucide-react";
import { isSheetEditorPath } from "#/routes";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ensureResultAtomData, isBrowserRuntime } from "#/lib/atomRegistry";
import {
  type ChannelConfigDraft,
  type ServerConfigForm,
  type WorkspaceConfigValue,
  type WorkspaceConversationConfigValue,
  buildChannelLabels,
  channelConfigPatch,
  channelDraftFrom,
  guildCapabilities,
  guildChannelsAtom,
  guildPermissionsAtom,
  guildRolesAtom,
  isEmptyPatch,
  permissionsFromResult,
  serverConfigFormFrom,
  serverConfigPatch,
  sortGuildChannels,
  sortGuildRoles,
  useAddWorkspaceMonitorRole,
  useGuildChannelsResult,
  useGuildPermissionsResult,
  useGuildRolesResult,
  useRemoveWorkspaceMonitorRole,
  useSetupWorkspaceConversationLockdown,
  useUndoWorkspaceConversationLockdown,
  useUpsertWorkspaceConfig,
  useUpsertWorkspaceConversation,
  useWorkspaceConfigResult,
  useWorkspaceConversationsResult,
  useWorkspaceMonitorRolesResult,
  workspaceConfigAtom,
  workspaceConversationsAtom,
  workspaceMonitorRolesAtom,
} from "#/lib/guildConfig";
import { availableResultValue } from "#/lib/asyncResult";
import type { DiscordChannel, DiscordRole } from "sheet-workflow-contracts";
import {
  isDiscordAnnouncementChannelType,
  isDiscordCategoryChannelType,
  isSendableDiscordChannelType,
} from "sheet-bot-api";

const SettingsSearch = Schema.Struct({
  section: Schema.optional(Schema.Literals(["server", "channels"])),
});

export const Route = createFileRoute("/_authenticated/dashboard/guilds/$guildId/settings")({
  component: GuildSettings,
  validateSearch: pipe(SettingsSearch, Schema.toStandardSchemaV1),
  loader: async ({ abortController, context, params }) => {
    if (!isBrowserRuntime()) return;
    await Effect.runPromise(
      Effect.gen(function* () {
        const permissionResult = yield* ensureResultAtomData(
          context.atomRegistry,
          guildPermissionsAtom(params.guildId),
        ).pipe(Effect.option);
        if (Option.isNone(permissionResult)) return;

        const capabilities = guildCapabilities(permissionResult.value.permissions, params.guildId);
        if (!capabilities.canLockdown) return;

        const preload = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
          ensureResultAtomData(context.atomRegistry, atom).pipe(Effect.catch(() => Effect.void));

        if (!capabilities.canManage) {
          yield* preload(guildChannelsAtom(params.guildId));
          return;
        }

        yield* Effect.all(
          [
            preload(guildChannelsAtom(params.guildId)),
            preload(guildRolesAtom(params.guildId)),
            preload(workspaceConfigAtom(params.guildId)),
            preload(workspaceMonitorRolesAtom(params.guildId)),
            preload(workspaceConversationsAtom(params.guildId)),
          ],
          { concurrency: "unbounded", discard: true },
        );
      }),
      { signal: abortController.signal },
    );
  },
});

const errorText = (error: unknown) =>
  Predicate.isError(error) ? error.message : "The request failed. Try again.";

type StatusState =
  | { readonly kind: "idle" }
  | { readonly kind: "success"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

type ResultTag = AsyncResult.AsyncResult<unknown, unknown>["_tag"];

const runningDraftValues: ReadonlyMap<string, ChannelConfigDraft["running"]> = new Map([
  ["unset", "unset"],
  ["enabled", "enabled"],
  ["disabled", "disabled"],
]);

// fallow-ignore-next-line complexity
function GuildSettings() {
  const { guildId } = Route.useParams();
  const { pathname } = useLocation();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const permissionResult = useGuildPermissionsResult(guildId);
  const refreshPermissions = useAtomRefresh(guildPermissionsAtom(guildId));
  const capabilities = guildCapabilities(permissionsFromResult(permissionResult), guildId);
  const section = capabilities.canManage && search.section !== "channels" ? "server" : "channels";

  if (
    isSheetEditorPath(pathname) &&
    AsyncResult.isSuccess(permissionResult) &&
    capabilities.canManage
  ) {
    return <Outlet />;
  }

  if (!capabilities.canLockdown && !AsyncResult.isSuccess(permissionResult)) {
    return (
      <ResourceState
        resultTag={permissionResult._tag}
        label="permissions"
        onRetry={refreshPermissions}
      />
    );
  }

  if (!capabilities.canLockdown) {
    return (
      <Notice icon={<Shield />} eyebrow="ACCESS DENIED" title="Settings are restricted">
        Discord Manage Server is required for configuration. A configured TiaraBot monitor role can
        access channel lockdown tools.
      </Notice>
    );
  }

  return (
    <div className="border border-[#33ccbb]/20 bg-[#080d0c]">
      <header className="flex flex-col gap-4 border-b border-[#33ccbb]/20 px-5 py-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-[10px] font-black tracking-[0.24em] text-[#33ccbb]">
            CONFIGURATION CONSOLE
          </p>
          <h1 className="mt-1 text-2xl font-black tracking-tight">Server settings</h1>
          <p className="mt-1 max-w-xl text-sm text-white/55">
            Web controls mirror TiaraBot’s Discord commands and permission checks.
          </p>
        </div>
        <div className="flex gap-px bg-[#33ccbb]/20" role="group" aria-label="Settings section">
          {capabilities.canManage ? (
            <SectionButton
              active={section === "server"}
              onClick={() => void navigate({ search: { section: "server" }, replace: true })}
            >
              <ServerCog className="h-4 w-4" />
              SERVER
            </SectionButton>
          ) : null}
          <SectionButton
            active={section === "channels"}
            onClick={() => void navigate({ search: { section: "channels" }, replace: true })}
          >
            <Hash className="h-4 w-4" />
            CHANNELS
          </SectionButton>
        </div>
      </header>

      {section === "server" && capabilities.canManage ? (
        <ServerSection key={guildId} guildId={guildId} />
      ) : (
        <ChannelsSection key={guildId} guildId={guildId} canManage={capabilities.canManage} />
      )}
    </div>
  );
}

function SectionButton({
  active,
  children,
  onClick,
}: {
  readonly active: boolean;
  readonly children: ReactNode;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`flex items-center gap-2 px-4 py-3 text-xs font-black tracking-wide transition ${
        active
          ? "bg-[#33ccbb] text-[#07100e]"
          : "bg-[#0b1210] text-white/55 hover:bg-[#33ccbb]/10 hover:text-white"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ServerSection({ guildId }: { readonly guildId: string }) {
  const configResult = useWorkspaceConfigResult(guildId);
  const refreshConfig = useAtomRefresh(workspaceConfigAtom(guildId));
  const channelsResult = useGuildChannelsResult(guildId);
  const rolesResult = useGuildRolesResult(guildId);
  const monitorRolesResult = useWorkspaceMonitorRolesResult(guildId);
  const conversationsResult = useWorkspaceConversationsResult(guildId);
  const config = availableResultValue(configResult);
  const channels = availableResultValue(channelsResult);
  const roles = availableResultValue(rolesResult);
  const monitorRoles = availableResultValue(monitorRolesResult);
  const conversations = availableResultValue(conversationsResult);

  if (config === undefined) {
    return (
      <ResourceState
        resultTag={configResult._tag}
        label="server configuration"
        onRetry={refreshConfig}
      />
    );
  }

  return (
    <ServerEditor
      guildId={guildId}
      config={config}
      channels={channels}
      roles={roles}
      monitorRoles={monitorRoles}
      conversations={conversations}
      resourceTags={{
        channels: channelsResult._tag,
        roles: rolesResult._tag,
        monitorRoles: monitorRolesResult._tag,
        conversations: conversationsResult._tag,
      }}
    />
  );
}

// fallow-ignore-next-line complexity
function ServerEditor({
  guildId,
  config,
  channels,
  roles,
  monitorRoles,
  conversations,
  resourceTags,
}: {
  readonly guildId: string;
  readonly config: WorkspaceConfigValue;
  readonly channels: ReadonlyArray<DiscordChannel> | undefined;
  readonly roles: ReadonlyArray<DiscordRole> | undefined;
  readonly monitorRoles: ReadonlyArray<{ readonly roleId: string }> | undefined;
  readonly conversations: ReadonlyArray<WorkspaceConversationConfigValue> | undefined;
  readonly resourceTags: {
    readonly channels: ResultTag;
    readonly roles: ResultTag;
    readonly monitorRoles: ResultTag;
    readonly conversations: ResultTag;
  };
}) {
  const [form, setForm] = useState<ServerConfigForm>(() => serverConfigFormFrom(config));
  const [persistedConfig, setPersistedConfig] = useState<{
    readonly sourceUpdatedAt: WorkspaceConfigValue["updatedAt"];
    readonly value: WorkspaceConfigValue;
  }>({ sourceUpdatedAt: config.updatedAt, value: config });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<StatusState>({ kind: "idle" });
  const [roleStatus, setRoleStatus] = useState<StatusState>({ kind: "idle" });
  const [roleId, setRoleId] = useState("");
  const [roleBusy, setRoleBusy] = useState<string>();
  const upsert = useUpsertWorkspaceConfig();
  const addRole = useAddWorkspaceMonitorRole();
  const removeRole = useRemoveWorkspaceMonitorRole();
  const baseline = Equal.equals(persistedConfig.sourceUpdatedAt, config.updatedAt)
    ? persistedConfig.value
    : config;
  const patch = serverConfigPatch(baseline, form);
  const dirty = !isEmptyPatch(patch);
  const blocker = useBlocker({
    shouldBlockFn: () => dirty && !saving,
    withResolver: true,
  });
  const sheetValid = baseline.sheetId === null || form.sheetId.trim().length > 0;
  const sortedChannels = useMemo(() => sortGuildChannels(channels ?? []), [channels]);
  const channelLabels = useMemo(() => buildChannelLabels(sortedChannels), [sortedChannels]);
  const runningIds = useMemo(
    () =>
      new Set(
        (conversations ?? [])
          .filter((conversation) => conversation.running === true)
          .map((conversation) => conversation.conversationId),
      ),
    [conversations],
  );
  const monitorChannelChoices = sortedChannels.filter(
    (channel) =>
      isSendableDiscordChannelType(channel.type) &&
      (!runningIds.has(channel.id) || channel.id === form.monitorConversationId),
  );
  const configuredRoleIds = new Set((monitorRoles ?? []).map((monitorRole) => monitorRole.roleId));
  const availableRoles = sortGuildRoles(roles ?? []).filter(
    (role) => !configuredRoleIds.has(role.id) && role.id !== guildId,
  );

  useEffect(() => {
    if (!dirty && !saving) setForm(serverConfigFormFrom(baseline));
  }, [baseline, dirty, saving]);

  // fallow-ignore-next-line complexity
  const save = async () => {
    if (!dirty || !sheetValid || saving) return;
    setSaving(true);
    setStatus({ kind: "idle" });
    try {
      const savedConfig = await upsert(guildId, patch);
      setPersistedConfig({ sourceUpdatedAt: config.updatedAt, value: savedConfig });
      setStatus({ kind: "success", message: "Server settings saved." });
    } catch (error) {
      setStatus({ kind: "error", message: errorText(error) });
    } finally {
      setSaving(false);
    }
  };

  const updateRole = async (operation: "add" | "remove", targetRoleId: string) => {
    setRoleBusy(targetRoleId);
    setRoleStatus({ kind: "idle" });
    try {
      if (operation === "add") {
        await addRole(guildId, targetRoleId);
        setRoleId("");
      } else {
        await removeRole(guildId, targetRoleId);
      }
      setRoleStatus({
        kind: "success",
        message: `Monitor role ${operation === "add" ? "added" : "removed"}.`,
      });
    } catch (error) {
      setRoleStatus({
        kind: "error",
        message: `Server fields were not changed. Monitor role ${operation} failed: ${errorText(error)}`,
      });
    } finally {
      setRoleBusy(undefined);
    }
  };

  return (
    <div className="grid gap-px bg-[#33ccbb]/15 lg:grid-cols-[minmax(0,1fr)_340px]">
      <form
        className="space-y-6 bg-[#0a100f] p-5 sm:p-7"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field
          id="sheet-id"
          label="Google Sheet ID"
          hint="May be replaced, but an existing ID cannot be cleared."
        >
          <input
            id="sheet-id"
            aria-describedby={sheetValid ? "sheet-id-hint" : "sheet-id-hint sheet-id-error"}
            value={form.sheetId}
            disabled={saving}
            aria-invalid={!sheetValid}
            className={inputClass}
            placeholder="1AbC…"
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                sheetId: event.target.value,
              }))
            }
          />
          {!sheetValid ? (
            <p id="sheet-id-error" className="mt-2 text-xs font-bold text-[#ff8a80]">
              Sheet ID cannot be cleared.
            </p>
          ) : null}
        </Field>

        <Field
          id="monitor-channel"
          label="Monitor channel"
          hint="Text and announcement channels only. Running channels are excluded."
        >
          <select
            id="monitor-channel"
            aria-describedby="monitor-channel-hint"
            className={inputClass}
            disabled={saving || channels === undefined || conversations === undefined}
            value={form.monitorConversationId}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                monitorConversationId: event.target.value,
              }))
            }
          >
            <option value="">Unset monitor channel</option>
            {form.monitorConversationId.length > 0 &&
            !monitorChannelChoices.some((channel) => channel.id === form.monitorConversationId) ? (
              <option value={form.monitorConversationId}>
                Unknown channel ({form.monitorConversationId})
              </option>
            ) : null}
            {monitorChannelChoices.map((channel) => (
              <option key={channel.id} value={channel.id}>
                #{channelLabels.get(channel.id) ?? channel.name}
              </option>
            ))}
          </select>
          {channels === undefined || conversations === undefined ? (
            <ResourceInline
              tags={[resourceTags.channels, resourceTags.conversations]}
              failureMessage="Discord channels or configured channels could not be loaded. Retry by refreshing."
              loadingMessage="Loading Discord and configured channels."
            />
          ) : null}
        </Field>

        <div className="flex items-center justify-between gap-5 border border-white/10 bg-black/20 p-4">
          <div>
            <span id="auto-checkin-label" className="text-sm font-black tracking-wide">
              AUTO CHECK-IN
            </span>
            <p id="auto-checkin-hint" className="mt-1 text-xs text-white/55">
              Automatically enqueue configured check-ins.
            </p>
          </div>
          <button
            id="auto-checkin"
            type="button"
            role="switch"
            aria-labelledby="auto-checkin-label"
            aria-describedby="auto-checkin-hint"
            aria-checked={form.autoCheckin}
            disabled={saving}
            className={`relative h-7 w-12 border transition ${
              form.autoCheckin ? "border-[#33ccbb] bg-[#33ccbb]" : "border-white/20 bg-[#111817]"
            }`}
            onClick={() =>
              setForm((current) => ({
                ...current,
                autoCheckin: !current.autoCheckin,
              }))
            }
          >
            <span
              className={`absolute top-1 h-[18px] w-[18px] bg-[#07100e] transition ${
                form.autoCheckin ? "left-6" : "left-1 bg-white/45"
              }`}
            />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-white/10 pt-5">
          <button
            type="submit"
            disabled={!dirty || !sheetValid || saving}
            className={primaryButtonClass}
          >
            {saving ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {saving ? "SAVING" : "SAVE SERVER"}
          </button>
          <span className="font-mono text-[11px] text-white/55">
            {dirty ? "UNSAVED CHANGES" : "NO CHANGES"}
          </span>
        </div>
        <StatusMessage status={status} />
      </form>

      <aside className="bg-[#08100e] p-5 sm:p-7">
        <p className="font-mono text-[10px] font-black tracking-[0.2em] text-[#33ccbb]">
          MONITOR ROLES
        </p>
        <h2 className="mt-2 text-lg font-black">Lockdown operators</h2>
        <p className="mt-2 text-xs leading-relaxed text-white/55">
          Members with these roles may run Setup and Undo without seeing stored configuration.
        </p>

        <div className="mt-5 space-y-2">
          {(monitorRoles ?? []).map((monitorRole) => (
            <MonitorRoleRow
              key={monitorRole.roleId}
              roleId={monitorRole.roleId}
              role={roles?.find((candidate) => candidate.id === monitorRole.roleId)}
              busyRoleId={roleBusy}
              onRemove={(targetRoleId) => void updateRole("remove", targetRoleId)}
            />
          ))}
          {monitorRoles?.length === 0 ? (
            <p className="border border-dashed border-white/10 px-3 py-4 text-center text-xs text-white/55">
              No monitor roles configured.
            </p>
          ) : null}
        </div>

        <div className="mt-4 flex gap-2">
          <select
            aria-label="Role to add"
            className={`${inputClass} min-w-0 flex-1`}
            disabled={roles === undefined || monitorRoles === undefined}
            value={roleId}
            onChange={(event) => setRoleId(event.target.value)}
          >
            <option value="">Select role…</option>
            {availableRoles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label="Add monitor role"
            disabled={roleId.length === 0 || roleBusy !== undefined}
            className={iconButtonClass}
            onClick={() => void updateRole("add", roleId)}
          >
            {roleBusy === roleId && roleId.length > 0 ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
          </button>
        </div>
        {roles === undefined || monitorRoles === undefined ? (
          <ResourceInline
            tags={[resourceTags.roles, resourceTags.monitorRoles]}
            failureMessage="Role data could not be loaded. Existing unknown references remain removable."
            loadingMessage="Loading Discord and monitor roles."
          />
        ) : null}
        <StatusMessage status={roleStatus} />
      </aside>
      <NavigationConfirmation blocker={blocker} subject="server settings" />
    </div>
  );
}

function MonitorRoleRow({
  roleId,
  role,
  busyRoleId,
  onRemove,
}: {
  readonly roleId: string;
  readonly role: DiscordRole | undefined;
  readonly busyRoleId: string | undefined;
  readonly onRemove: (roleId: string) => void;
}) {
  const label = role?.name ?? `Unknown role (${roleId})`;
  return (
    <div className="flex items-center justify-between gap-3 border border-white/10 bg-black/20 px-3 py-2">
      <span className="min-w-0 truncate text-sm font-bold">{label}</span>
      <button
        type="button"
        aria-label={`Remove ${label}`}
        disabled={busyRoleId !== undefined}
        className="p-1.5 text-white/55 transition hover:bg-[#ff6257]/10 hover:text-[#ff8a80] disabled:opacity-40"
        onClick={() => onRemove(roleId)}
      >
        {busyRoleId === roleId ? (
          <LoaderCircle className="h-4 w-4 animate-spin" />
        ) : (
          <X className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}

function ChannelListButton({
  channel,
  label,
  selected,
  onSelect,
}: {
  readonly channel: DiscordChannel;
  readonly label: string;
  readonly selected: boolean;
  readonly onSelect: (channelId: string) => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      className={`mb-1 flex w-full items-center gap-3 border px-3 py-3 text-left transition ${
        selected
          ? "border-[#33ccbb]/50 bg-[#33ccbb]/10 text-white"
          : "border-transparent text-white/55 hover:border-white/10 hover:bg-white/[0.03]"
      }`}
      onClick={() => onSelect(channel.id)}
    >
      <Hash className="h-4 w-4 shrink-0 text-[#33ccbb]" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold">{label}</span>
        <span className="block truncate font-mono text-[9px] text-white/55">
          {isDiscordAnnouncementChannelType(channel.type) ? "ANNOUNCEMENT" : "TEXT"} · {channel.id}
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-white/20" />
    </button>
  );
}

// fallow-ignore-next-line complexity
function ChannelsSection({
  guildId,
  canManage,
}: {
  readonly guildId: string;
  readonly canManage: boolean;
}) {
  const channelsResult = useGuildChannelsResult(guildId);
  const refreshChannels = useAtomRefresh(guildChannelsAtom(guildId));
  const channels = availableResultValue(channelsResult);
  const [search, setSearch] = useState("");
  const sendableChannels = useMemo(
    () =>
      sortGuildChannels(channels ?? []).filter((channel) =>
        isSendableDiscordChannelType(channel.type),
      ),
    [channels],
  );
  const channelsById = useMemo(
    () => new Map((channels ?? []).map((channel) => [channel.id, channel])),
    [channels],
  );
  const channelLabels = useMemo(() => buildChannelLabels(channels ?? []), [channels]);
  const filtered = sendableChannels.filter((channel) => {
    const category = Predicate.isString(channel.parentId)
      ? channelsById.get(channel.parentId)
      : undefined;
    return `${channel.name} ${channel.id} ${category?.name ?? ""}`
      .toLowerCase()
      .includes(search.toLowerCase());
  });
  const [requestedId, setRequestedId] = useState<string>();
  const selectedId = sendableChannels.some((channel) => channel.id === requestedId)
    ? requestedId
    : filtered[0]?.id;

  if (channels === undefined) {
    return (
      <ResourceState
        resultTag={channelsResult._tag}
        label="Discord channels"
        onRetry={refreshChannels}
      />
    );
  }

  const selected = sendableChannels.find((channel) => channel.id === selectedId);

  return (
    <div className="grid min-h-[620px] bg-[#33ccbb]/15 lg:grid-cols-[300px_minmax(0,1fr)] lg:gap-px">
      <aside className="border-b border-[#33ccbb]/15 bg-[#08100e] lg:border-b-0">
        <div className="border-b border-white/10 p-4">
          <label className="relative block">
            <span className="sr-only">Search channels</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
            <input
              value={search}
              className={`${inputClass} pl-9`}
              placeholder="Search channels"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <p className="mt-2 font-mono text-[10px] text-white/55">
            {filtered.length} / {sendableChannels.length} SENDABLE
          </p>
        </div>
        <div className="max-h-[330px] overflow-y-auto p-2 lg:max-h-[600px]">
          {filtered.map((channel) => (
            <ChannelListButton
              key={channel.id}
              channel={channel}
              label={channelLabels.get(channel.id) ?? channel.name}
              selected={selectedId === channel.id}
              onSelect={setRequestedId}
            />
          ))}
          {filtered.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-white/55">No matching channels.</p>
          ) : null}
        </div>
      </aside>

      <main className="bg-[#0a100f]">
        {selected ? (
          canManage ? (
            <ManagerChannelEditor guildId={guildId} channel={selected} channels={channels} />
          ) : (
            <MonitorChannelActions guildId={guildId} channel={selected} />
          )
        ) : (
          <Notice icon={<Hash />} eyebrow="NO CHANNEL" title="Select a sendable channel">
            Text and announcement channels appear here.
          </Notice>
        )}
      </main>
    </div>
  );
}

// fallow-ignore-next-line complexity
function ManagerChannelEditor({
  guildId,
  channel,
  channels,
}: {
  readonly guildId: string;
  readonly channel: DiscordChannel;
  readonly channels: ReadonlyArray<DiscordChannel>;
}) {
  const conversationsResult = useWorkspaceConversationsResult(guildId);
  const rolesResult = useGuildRolesResult(guildId);
  const conversations = availableResultValue(conversationsResult);
  const roles = availableResultValue(rolesResult);
  const [drafts, setDrafts] = useState<Record<string, ChannelConfigDraft>>({});
  const [savedConfigs, setSavedConfigs] = useState<
    Record<
      string,
      {
        readonly value: WorkspaceConversationConfigValue;
        readonly source: ReadonlyArray<WorkspaceConversationConfigValue> | undefined;
      }
    >
  >({});
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [statuses, setStatuses] = useState<Record<string, StatusState>>({});
  const previousConversations = useRef(conversations);
  const upsert = useUpsertWorkspaceConversation();
  const savedConfig = savedConfigs[channel.id];
  const loadedConfig = conversations?.find(
    (conversation) => conversation.conversationId === channel.id,
  );
  const config = savedConfig?.value ?? loadedConfig;
  const status = statuses[channel.id] ?? { kind: "idle" };
  const setStatus = (next: StatusState) => {
    setStatuses((current) => ({ ...current, [channel.id]: next }));
  };

  useEffect(() => {
    if (savedConfig === undefined || conversations === savedConfig.source) return;
    setSavedConfigs((current) => {
      const { [channel.id]: _, ...remaining } = current;
      return remaining;
    });
  }, [channel.id, conversations, savedConfig]);

  useEffect(() => {
    const previous = previousConversations.current;
    previousConversations.current = conversations;
    if (previous === conversations) return;

    setDrafts((current) => {
      const next = { ...current };
      let changed = false;
      for (const [conversationId, candidate] of Object.entries(current)) {
        const previousConfig = previous?.find(
          (conversation) => conversation.conversationId === conversationId,
        );
        if (isEmptyPatch(channelConfigPatch(previousConfig, candidate))) {
          delete next[conversationId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [conversations]);

  const draft = drafts[channel.id] ?? channelDraftFrom(config);
  const patch = channelConfigPatch(config, draft);
  const dirty = !isEmptyPatch(patch);
  const saving = savingIds.has(channel.id);
  const nameValid = !draft.nameConfigured || draft.name.trim().length > 0;
  const canSave = dirty && nameValid && !saving;
  const running = config?.running === true;
  const dirtyIds = new Set(
    Object.entries(drafts)
      .filter(([conversationId, candidate]) => {
        const baseline =
          savedConfigs[conversationId]?.value ??
          conversations?.find((conversation) => conversation.conversationId === conversationId);
        return !isEmptyPatch(channelConfigPatch(baseline, candidate));
      })
      .map(([conversationId]) => conversationId),
  );
  const blocker = useBlocker({
    shouldBlockFn: () =>
      Array.from(dirtyIds).some((conversationId) => !savingIds.has(conversationId)),
    withResolver: true,
  });
  const category = channels.find(
    (candidate) =>
      candidate.id === channel.parentId && isDiscordCategoryChannelType(candidate.type),
  );
  const sortedRoles = sortGuildRoles(roles ?? []);
  const roleChoices = sortedRoles.filter((role) => !role.managed && role.id !== guildId);
  const configuredRoleId = draft.roleId;
  const configuredRoleMissing =
    configuredRoleId.length > 0 && !roleChoices.some((role) => role.id === configuredRoleId);
  const checkinChoices = sortGuildChannels(channels).filter((candidate) =>
    isSendableDiscordChannelType(candidate.type),
  );
  const channelLabels = useMemo(() => buildChannelLabels(channels), [channels]);
  const configuredCheckinMissing =
    draft.checkinConversationId.length > 0 &&
    !checkinChoices.some((candidate) => candidate.id === draft.checkinConversationId);

  const setDraft: Dispatch<SetStateAction<ChannelConfigDraft>> = (next) => {
    setDrafts((current) => {
      const existing = current[channel.id] ?? channelDraftFrom(config);
      const value = Predicate.isFunction(next) ? next(existing) : next;
      return { ...current, [channel.id]: value };
    });
  };

  const save = async () => {
    if (!canSave) return;
    setSavingIds((current) => new Set(current).add(channel.id));
    setStatus({ kind: "idle" });
    try {
      const saved = await upsert(guildId, channel.id, patch);
      setSavedConfigs((current) => ({
        ...current,
        [channel.id]: { value: saved, source: conversations },
      }));
      setDrafts((current) => {
        const { [channel.id]: _, ...remaining } = current;
        return remaining;
      });
      setStatus({ kind: "success", message: `#${channel.name} saved.` });
    } catch (error) {
      setStatus({ kind: "error", message: errorText(error) });
    } finally {
      setSavingIds((current) => {
        const next = new Set(current);
        next.delete(channel.id);
        return next;
      });
    }
  };

  return (
    <>
      <div className="border-b border-white/10 px-5 py-5 sm:px-7">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] font-black tracking-[0.2em] text-[#33ccbb]">
              {category?.name ?? "UNCATEGORIZED"} /{" "}
              {isDiscordAnnouncementChannelType(channel.type) ? "ANNOUNCEMENT" : "TEXT"}
            </p>
            <h2 className="mt-1 text-xl font-black">#{channel.name}</h2>
          </div>
          <div className="flex gap-2">
            <Badge active={config !== undefined}>
              {config === undefined ? "UNCONFIGURED" : "CONFIGURED"}
            </Badge>
            <Badge active={running}>{running ? "RUNNING" : "NOT RUNNING"}</Badge>
            {dirtyIds.has(channel.id) ? <Badge active>DIRTY</Badge> : null}
          </div>
        </div>
      </div>

      <div className="grid gap-px bg-white/10 xl:grid-cols-[minmax(0,1fr)_340px]">
        {conversations === undefined || roles === undefined ? (
          <div className="bg-[#0a100f] p-5 sm:p-7">
            <ResourceInline
              tags={[conversationsResult._tag, rolesResult._tag]}
              failureMessage="Stored configuration or Discord roles could not be loaded. Editing is disabled until the data is available."
              loadingMessage="Loading stored configuration and Discord roles."
            />
          </div>
        ) : (
          <form
            className="space-y-6 bg-[#0a100f] p-5 sm:p-7"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Field
              id={`running-${channel.id}`}
              label="Running"
              hint="Explicitly enable, disable, or leave this value unconfigured."
            >
              <select
                id={`running-${channel.id}`}
                aria-describedby={`running-${channel.id}-hint`}
                className={inputClass}
                value={draft.running}
                disabled={saving}
                onChange={(event) => {
                  const running = runningDraftValues.get(event.target.value);
                  if (running === undefined) return;
                  setDraft((current) => ({
                    ...current,
                    running,
                  }));
                }}
              >
                <option value="unset">Not set</option>
                <option value="enabled">Enabled</option>
                <option value="disabled">Disabled</option>
              </select>
            </Field>

            <Field
              id={`name-${channel.id}`}
              label="Logical name"
              hint="Controls the name used by sheet workflows, independently of Discord."
            >
              <label className="mb-2 flex items-center gap-2 text-xs font-bold text-white/55">
                <input
                  type="checkbox"
                  aria-describedby={`name-${channel.id}-hint`}
                  checked={draft.nameConfigured}
                  disabled={saving}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      nameConfigured: event.target.checked,
                    }))
                  }
                />
                Configure a logical name
              </label>
              <input
                id={`name-${channel.id}`}
                aria-describedby={
                  nameValid
                    ? `name-${channel.id}-hint`
                    : `name-${channel.id}-hint name-${channel.id}-error`
                }
                value={draft.name}
                disabled={saving || !draft.nameConfigured}
                aria-invalid={!nameValid}
                className={inputClass}
                placeholder="e.g. weekly-raid"
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
              />
              {!nameValid ? (
                <p
                  id={`name-${channel.id}-error`}
                  className="mt-2 text-xs font-bold text-[#ff8a80]"
                >
                  Logical name cannot be blank while configured.
                </p>
              ) : null}
            </Field>

            <Field
              id={`lockdown-role-${channel.id}`}
              label="Lockdown role"
              hint="@everyone and managed roles cannot be selected."
            >
              <select
                id={`lockdown-role-${channel.id}`}
                aria-describedby={`lockdown-role-${channel.id}-hint`}
                className={inputClass}
                value={draft.roleId}
                disabled={saving}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    roleId: event.target.value,
                  }))
                }
              >
                <option value="">Unset lockdown role</option>
                {configuredRoleMissing ? (
                  <option value={configuredRoleId}>
                    Unknown or unavailable role ({configuredRoleId})
                  </option>
                ) : null}
                {roleChoices.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              id={`checkin-${channel.id}`}
              label="Check-in channel"
              hint="Destination used by the check-in workflow."
            >
              <select
                id={`checkin-${channel.id}`}
                aria-describedby={`checkin-${channel.id}-hint`}
                className={inputClass}
                value={draft.checkinConversationId}
                disabled={saving}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    checkinConversationId: event.target.value,
                  }))
                }
              >
                <option value="">Unset check-in channel</option>
                {configuredCheckinMissing ? (
                  <option value={draft.checkinConversationId}>
                    Unknown channel ({draft.checkinConversationId})
                  </option>
                ) : null}
                {checkinChoices.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    #{channelLabels.get(candidate.id) ?? candidate.name}
                  </option>
                ))}
              </select>
            </Field>

            <div className="flex flex-wrap items-center gap-3 border-t border-white/10 pt-5">
              <button type="submit" disabled={!canSave} className={primaryButtonClass}>
                {saving ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                SAVE CHANNEL
              </button>
              <span className="font-mono text-[11px] text-white/55">
                {dirty ? "UNSAVED DRAFT" : "NO CHANGES"}
              </span>
            </div>
            <StatusMessage status={status} />
          </form>
        )}

        <LockdownPanel
          key={channel.id}
          guildId={guildId}
          channel={channel}
          requireConfiguration
          draftPending={dirtyIds.has(channel.id)}
          configured={conversations === undefined ? undefined : config !== undefined}
          hasLockdownRole={
            conversations === undefined
              ? undefined
              : Predicate.isString(config?.roleId) && config.roleId.length > 0
          }
        />
      </div>

      <NavigationConfirmation blocker={blocker} subject="channel drafts" />
    </>
  );
}

function MonitorChannelActions({
  guildId,
  channel,
}: {
  readonly guildId: string;
  readonly channel: DiscordChannel;
}) {
  return (
    <div>
      <div className="border-b border-white/10 px-5 py-5 sm:px-7">
        <p className="font-mono text-[10px] font-black tracking-[0.2em] text-[#33ccbb]">
          MONITOR ACCESS
        </p>
        <h2 className="mt-1 text-xl font-black">#{channel.name}</h2>
        <p className="mt-2 max-w-xl text-sm text-white/55">
          Stored channel configuration is hidden. Lockdown requests are still validated by the
          server.
        </p>
      </div>
      <div className="max-w-xl p-5 sm:p-7">
        <LockdownPanel key={channel.id} guildId={guildId} channel={channel} />
      </div>
    </div>
  );
}

// fallow-ignore-next-line complexity
function LockdownPanel({
  guildId,
  channel,
  requireConfiguration = false,
  draftPending = false,
  configured,
  hasLockdownRole,
}: {
  readonly guildId: string;
  readonly channel: DiscordChannel;
  readonly requireConfiguration?: boolean;
  readonly draftPending?: boolean;
  readonly configured?: boolean | undefined;
  readonly hasLockdownRole?: boolean | undefined;
}) {
  const setup = useSetupWorkspaceConversationLockdown();
  const undo = useUndoWorkspaceConversationLockdown();
  const [confirm, setConfirm] = useState<"setup" | "undo">();
  const [busy, setBusy] = useState<"setup" | "undo">();
  const [status, setStatus] = useState<StatusState>({ kind: "idle" });
  const configurationUnavailable = requireConfiguration && configured === undefined;

  const run = async (operation: "setup" | "undo") => {
    setConfirm(undefined);
    setBusy(operation);
    setStatus({ kind: "idle" });
    try {
      if (operation === "setup") {
        await setup(guildId, channel.id);
      } else {
        await undo(guildId, channel.id);
      }
      setStatus({
        kind: "success",
        message:
          operation === "setup"
            ? `Lockdown permissions replaced for #${channel.name}.`
            : `All explicit overwrites cleared for #${channel.name}.`,
      });
    } catch (error) {
      setStatus({ kind: "error", message: errorText(error) });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <aside className="bg-[#08100e] p-5 sm:p-7">
      <div className="flex h-10 w-10 items-center justify-center border border-[#33ccbb]/35 bg-[#33ccbb]/10 text-[#33ccbb]">
        <LockKeyhole className="h-5 w-5" />
      </div>
      <h3 className="mt-4 text-lg font-black">Permission lockdown</h3>
      <p className="mt-2 text-xs leading-relaxed text-white/55">
        These are destructive replacement operations, matching TiaraBot’s Discord commands.
      </p>

      {configured === false ? (
        <Guidance>Configure and save this channel before setup.</Guidance>
      ) : null}
      {configurationUnavailable ? (
        <Guidance>Stored configuration is unavailable. Setup is disabled.</Guidance>
      ) : null}
      {draftPending ? <Guidance>Save or discard this channel draft before setup.</Guidance> : null}
      {hasLockdownRole === false ? (
        <Guidance>A lockdown role must be configured before setup.</Guidance>
      ) : null}

      <div className="mt-5 space-y-3">
        <button
          type="button"
          disabled={
            busy !== undefined ||
            configured === false ||
            configurationUnavailable ||
            draftPending ||
            hasLockdownRole === false
          }
          className={`${primaryButtonClass} w-full`}
          onClick={() => setConfirm("setup")}
        >
          {busy === "setup" ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <LockKeyhole className="h-4 w-4" />
          )}
          SETUP LOCKDOWN
        </button>
        <button
          type="button"
          disabled={busy !== undefined}
          className={`${secondaryButtonClass} w-full`}
          onClick={() => setConfirm("undo")}
        >
          {busy === "undo" ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <RotateCcw className="h-4 w-4" />
          )}
          UNDO LOCKDOWN
        </button>
      </div>
      <StatusMessage status={status} />

      {confirm ? (
        <ConfirmationDialog
          title={
            confirm === "setup"
              ? "Replace every channel overwrite?"
              : "Clear every explicit overwrite?"
          }
          description={
            confirm === "setup"
              ? `Setup will replace all existing permission overwrites on #${channel.name} with the TiaraBot lockdown policy.`
              : `Undo will remove every explicit permission overwrite from #${channel.name}.`
          }
          confirmLabel={confirm === "setup" ? "Replace overwrites" : "Clear overwrites"}
          destructive
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => void run(confirm)}
        />
      ) : null}
    </aside>
  );
}

function NavigationConfirmation({
  blocker,
  subject,
}: {
  readonly blocker: ReturnType<typeof useBlocker<RegisteredRouter, true>>;
  readonly subject: string;
}) {
  if (blocker.status !== "blocked") return null;
  return (
    <ConfirmationDialog
      title={`Leave with unsaved ${subject}?`}
      description={`Your unsaved ${subject} will be discarded.`}
      confirmLabel="Leave settings"
      destructive
      onCancel={() => blocker.reset()}
      onConfirm={() => blocker.proceed()}
    />
  );
}

function ConfirmationDialog({
  title,
  description,
  confirmLabel,
  destructive,
  onCancel,
  onConfirm,
}: {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/80" />
        <Dialog.Viewport className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Popup
            role="alertdialog"
            className="w-full max-w-md border border-[#33ccbb]/35 bg-[#0b1210] p-6 shadow-[12px_12px_0_rgba(51,204,187,0.12)]"
          >
            <AlertTriangle className="h-7 w-7 text-[#ffb86b]" />
            <Dialog.Title className="mt-4 text-xl font-black">{title}</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-relaxed text-white/50">
              {description}
            </Dialog.Description>
            <div className="mt-6 flex justify-end gap-2">
              <Dialog.Close className={secondaryButtonClass}>CANCEL</Dialog.Close>
              <button
                type="button"
                className={
                  destructive
                    ? `${secondaryButtonClass} border-[#ff6257]/45 text-[#ff8a80] hover:bg-[#ff6257]/10`
                    : primaryButtonClass
                }
                onClick={onConfirm}
              >
                {confirmLabel.toUpperCase()}
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-xs font-black tracking-wide">
        {label.toUpperCase()}
      </label>
      <p id={`${id}-hint`} className="mb-2 mt-1 text-xs text-white/55">
        {hint}
      </p>
      {children}
    </div>
  );
}

function StatusMessage({ status }: { readonly status: StatusState }) {
  return (
    <>
      <div role="status" aria-live="polite">
        {status.kind === "success" ? (
          <div className="mt-4 flex items-start gap-2 border border-[#33ccbb]/35 bg-[#33ccbb]/10 px-3 py-2 text-xs font-bold text-[#79e6d9]">
            <Check className="mt-0.5 h-4 w-4 shrink-0" />
            {status.message}
          </div>
        ) : null}
      </div>
      <div role="alert" aria-live="assertive">
        {status.kind === "error" ? (
          <div className="mt-4 flex items-start gap-2 border border-[#ff6257]/35 bg-[#ff6257]/10 px-3 py-2 text-xs font-bold text-[#ff9b94]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {status.message}
          </div>
        ) : null}
      </div>
    </>
  );
}

function InlineFailure({ children }: { readonly children: ReactNode }) {
  return (
    <div
      role="alert"
      className="mt-3 flex items-start gap-2 border border-[#ffb86b]/25 bg-[#ffb86b]/5 px-3 py-2 text-xs text-[#ffca8b]"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      {children}
    </div>
  );
}

function InlineLoading({ children }: { readonly children: ReactNode }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mt-3 flex items-start gap-2 border border-[#33ccbb]/25 bg-[#33ccbb]/5 px-3 py-2 text-xs text-[#79e6d9]"
    >
      <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
      {children}
    </div>
  );
}

function ResourceInline({
  tags,
  failureMessage,
  loadingMessage,
}: {
  readonly tags: ReadonlyArray<ResultTag>;
  readonly failureMessage: string;
  readonly loadingMessage: string;
}) {
  return tags.includes("Failure") ? (
    <InlineFailure>{failureMessage}</InlineFailure>
  ) : (
    <InlineLoading>{loadingMessage}</InlineLoading>
  );
}

function Guidance({ children }: { readonly children: ReactNode }) {
  return (
    <div className="mt-4 border-l-2 border-[#ffb86b] bg-[#ffb86b]/5 px-3 py-2 text-xs text-[#ffca8b]">
      {children}
    </div>
  );
}

function Badge({ active, children }: { readonly active: boolean; readonly children: ReactNode }) {
  return (
    <span
      className={`border px-2 py-1 font-mono text-[9px] font-bold ${
        active
          ? "border-[#33ccbb]/35 bg-[#33ccbb]/10 text-[#79e6d9]"
          : "border-white/10 text-white/55"
      }`}
    >
      {children}
    </span>
  );
}

function ResourceState({
  resultTag,
  label,
  onRetry,
}: {
  readonly resultTag: ResultTag;
  readonly label: string;
  readonly onRetry: () => void;
}) {
  return resultTag === "Failure" ? (
    <Notice icon={<AlertTriangle />} eyebrow="RESOURCE ERROR" title={`Could not load ${label}`}>
      <span className="block">No values have been changed or cleared.</span>
      <button type="button" className={`${secondaryButtonClass} mt-4`} onClick={onRetry}>
        <RotateCcw className="h-4 w-4" />
        RETRY
      </button>
    </Notice>
  ) : (
    <Notice
      icon={<LoaderCircle className="animate-spin" />}
      eyebrow="LOADING"
      title={`Loading ${label}`}
    >
      Waiting for the server.
    </Notice>
  );
}

function Notice({
  icon,
  eyebrow,
  title,
  children,
}: {
  readonly icon: ReactNode;
  readonly eyebrow: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-h-[360px] items-center justify-center bg-[#0a100f] p-8">
      <div className="max-w-md text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center border border-[#33ccbb]/30 bg-[#33ccbb]/5 text-[#33ccbb]">
          {icon}
        </div>
        <p className="mt-5 font-mono text-[10px] font-black tracking-[0.22em] text-[#33ccbb]">
          {eyebrow}
        </p>
        <h2 className="mt-2 text-xl font-black">{title}</h2>
        <div className="mt-2 text-sm leading-relaxed text-white/55">{children}</div>
      </div>
    </div>
  );
}

const inputClass =
  "h-10 w-full border border-white/15 bg-[#07100e] px-3 text-sm text-white outline-none transition placeholder:text-white/20 focus:border-[#33ccbb]/70 focus:ring-2 focus:ring-[#33ccbb]/10 disabled:cursor-not-allowed disabled:opacity-45";
const primaryButtonClass =
  "inline-flex h-10 items-center justify-center gap-2 border border-[#33ccbb] bg-[#33ccbb] px-4 text-xs font-black tracking-wide text-[#07100e] transition hover:bg-[#79e6d9] disabled:cursor-not-allowed disabled:opacity-35";
const secondaryButtonClass =
  "inline-flex h-10 items-center justify-center gap-2 border border-white/15 bg-[#0a100f] px-4 text-xs font-black tracking-wide text-white/70 transition hover:border-[#33ccbb]/45 hover:text-white disabled:cursor-not-allowed disabled:opacity-35";
const iconButtonClass =
  "flex h-10 w-10 shrink-0 items-center justify-center border border-[#33ccbb]/40 bg-[#33ccbb]/10 text-[#33ccbb] transition hover:bg-[#33ccbb]/20 disabled:cursor-not-allowed disabled:opacity-35";
