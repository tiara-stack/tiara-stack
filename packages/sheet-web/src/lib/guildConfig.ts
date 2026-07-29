import { useAtomSet, useAtomSuspense } from "@effect/atom-react";
import { Duration, HashSet, Option, Predicate, Schema } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";
import { isDiscordCategoryChannelType } from "sheet-ingress-api/guild-config";
import { DiscordGuildChannel, DiscordGuildRole } from "sheet-ingress-api/schemas/discord";
import { CurrentUserPermissions, type PermissionSet } from "sheet-ingress-api/schemas/permissions";
import {
  WorkspaceConfig,
  WorkspaceConversationConfig,
  WorkspaceMonitorRole,
} from "sheet-ingress-api/schemas/workspaceConfig";
import { ArgumentError, SchemaError, Unauthorized } from "typhoon-core/error";
import { QueryResultAppError, QueryResultParseError } from "typhoon-zero/error";
import { SheetApisClient } from "#/lib/sheetApis";

export type ServerConfigForm = {
  readonly sheetId: string;
  readonly autoCheckin: boolean;
  readonly monitorConversationId: string;
};

export type OptionalBooleanFormValue = "unset" | "enabled" | "disabled";

export type ChannelConfigDraft = {
  readonly running: OptionalBooleanFormValue;
  readonly nameConfigured: boolean;
  readonly name: string;
  readonly roleId: string;
  readonly checkinConversationId: string;
};

export type WorkspaceConfigValue = typeof WorkspaceConfig.Type;
export type WorkspaceConversationConfigValue = typeof WorkspaceConversationConfig.Type;

type ServerConfigPatch = {
  sheetId?: string;
  autoCheckin?: boolean;
  monitorConversationId?: string | null;
};

type ChannelConfigPatchValue = {
  name?: string | null;
  running?: boolean | null;
  roleId?: string | null;
  checkinConversationId?: string | null;
};

const configKey = (workspaceId: string) => `guildConfig:${workspaceId}`;
const permissionKey = (workspaceId: string) => `guildPermissions:${workspaceId}`;
const discordResourceKey = (workspaceId: string) => `guildDiscordResources:${workspaceId}`;

const QueryResultErrorSchema = Schema.Union([QueryResultAppError, QueryResultParseError]);
const PermissionsErrorSchema = Schema.revealCodec(
  Schema.Union([SchemaError, QueryResultErrorSchema, ArgumentError]),
);
const DiscordResourceErrorSchema = Schema.revealCodec(Schema.Union([SchemaError, ArgumentError]));
const ServerConfigErrorSchema = Schema.revealCodec(
  Schema.Union([SchemaError, QueryResultErrorSchema, ArgumentError, Unauthorized]),
);
const ConfigListErrorSchema = Schema.revealCodec(
  Schema.Union([SchemaError, QueryResultErrorSchema, Unauthorized]),
);

const asyncResultSchema = <Success extends Schema.Top, Error extends Schema.Top>(
  success: Success,
  error: Error,
) =>
  Schema.revealCodec(
    AsyncResult.Schema({
      success,
      error,
    }),
  );

const guildQueryFamily = <A, E>(
  key: string,
  schema: Schema.Codec<AsyncResult.AsyncResult<A, E>, unknown>,
  query: (workspaceId: string) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) =>
  Atom.family((workspaceId: string) =>
    query(workspaceId).pipe(
      Atom.setIdleTTL(Duration.minutes(2)),
      Atom.serializable({
        key: `${key}.${workspaceId}`,
        schema,
      }),
    ),
  );

export const guildPermissionsAtom = guildQueryFamily(
  "guildConfig.permissions",
  asyncResultSchema(CurrentUserPermissions, PermissionsErrorSchema),
  (workspaceId: string) =>
    SheetApisClient.query("permissions", "getCurrentUserPermissions", {
      query: { workspaceId },
      reactivityKeys: [permissionKey(workspaceId)],
    }),
);

export const guildChannelsAtom = guildQueryFamily(
  "guildConfig.discordChannels",
  asyncResultSchema(Schema.Array(DiscordGuildChannel), DiscordResourceErrorSchema),
  (workspaceId: string) =>
    SheetApisClient.query("discord", "getGuildChannels", {
      params: { workspaceId },
      reactivityKeys: [discordResourceKey(workspaceId)],
    }),
);

export const guildRolesAtom = guildQueryFamily(
  "guildConfig.discordRoles",
  asyncResultSchema(Schema.Array(DiscordGuildRole), DiscordResourceErrorSchema),
  (workspaceId: string) =>
    SheetApisClient.query("discord", "getGuildRoles", {
      params: { workspaceId },
      reactivityKeys: [discordResourceKey(workspaceId)],
    }),
);

export const workspaceConfigAtom = guildQueryFamily(
  "guildConfig.server",
  asyncResultSchema(WorkspaceConfig, ServerConfigErrorSchema),
  (workspaceId: string) =>
    SheetApisClient.query("workspaceConfig", "getWorkspaceConfig", {
      query: { workspaceId },
      reactivityKeys: [configKey(workspaceId)],
    }),
);

export const workspaceMonitorRolesAtom = guildQueryFamily(
  "guildConfig.monitorRoles",
  asyncResultSchema(Schema.Array(WorkspaceMonitorRole), ConfigListErrorSchema),
  (workspaceId: string) =>
    SheetApisClient.query("workspaceConfig", "getWorkspaceMonitorRoles", {
      query: { workspaceId },
      reactivityKeys: [configKey(workspaceId)],
    }),
);

export const workspaceConversationsAtom = guildQueryFamily(
  "guildConfig.conversations",
  asyncResultSchema(Schema.Array(WorkspaceConversationConfig), ConfigListErrorSchema),
  (workspaceId: string) =>
    SheetApisClient.query("workspaceConfig", "getWorkspaceConversations", {
      query: { workspaceId },
      reactivityKeys: [configKey(workspaceId)],
    }),
);

const upsertWorkspaceConfigMutation = SheetApisClient.mutation(
  "workspaceConfig",
  "upsertWorkspaceConfig",
);
const addMonitorRoleMutation = SheetApisClient.mutation(
  "workspaceConfig",
  "addWorkspaceMonitorRole",
);
const removeMonitorRoleMutation = SheetApisClient.mutation(
  "workspaceConfig",
  "removeWorkspaceMonitorRole",
);
const upsertConversationMutation = SheetApisClient.mutation(
  "workspaceConfig",
  "upsertWorkspaceConversationConfig",
);
const setupLockdownMutation = SheetApisClient.mutation(
  "workspaceConfig",
  "setupWorkspaceConversationLockdown",
);
const undoLockdownMutation = SheetApisClient.mutation(
  "workspaceConfig",
  "undoWorkspaceConversationLockdown",
);

const useGuildMutation = <Args extends ReadonlyArray<unknown>, Payload, Result, Err>(
  mutation: Atom.AtomResultFn<Payload, Result, Err>,
  request: (...args: Args) => Payload,
) => {
  const mutate = useAtomSet(mutation, { mode: "promise" });
  return useCallback((...args: Args) => mutate(request(...args)), [mutate, request]);
};

const workspaceConfigMutationRequest = (workspaceId: string, config: ServerConfigPatch) => ({
  payload: { workspaceId, config },
  reactivityKeys: [configKey(workspaceId)],
});

const monitorRoleMutationRequest = (workspaceId: string, roleId: string) => ({
  payload: { workspaceId, roleId },
  reactivityKeys: [configKey(workspaceId), permissionKey(workspaceId)],
});

const conversationMutationRequest = (
  workspaceId: string,
  conversationId: string,
  config: ChannelConfigPatchValue,
) => ({
  payload: { workspaceId, conversationId, config },
  reactivityKeys: [configKey(workspaceId)],
});

const lockdownMutationRequest = (workspaceId: string, conversationId: string) => ({
  payload: { workspaceId, conversationId },
  reactivityKeys: [discordResourceKey(workspaceId)],
});

const useGuildResourceSuspense = <A, E>(
  atomFamily: (workspaceId: string) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  workspaceId: string,
) => {
  const atom = useMemo(() => atomFamily(workspaceId), [atomFamily, workspaceId]);
  return useAtomSuspense(atom, { suspendOnWaiting: false, includeFailure: true });
};

export const useGuildPermissionsResult = (workspaceId: string) =>
  useGuildResourceSuspense(guildPermissionsAtom, workspaceId);

export const permissionsFromResult = <E>(
  result: AsyncResult.AsyncResult<{ readonly permissions: PermissionSet }, E>,
): PermissionSet => {
  if (AsyncResult.isSuccess(result)) {
    return result.value.permissions;
  }
  return AsyncResult.isFailure(result)
    ? Option.match(result.previousSuccess, {
        onNone: () => HashSet.empty(),
        onSome: ({ value }) => value.permissions,
      })
    : HashSet.empty();
};

export const useGuildChannelsResult = (workspaceId: string) =>
  useGuildResourceSuspense(guildChannelsAtom, workspaceId);

export const useGuildRolesResult = (workspaceId: string) =>
  useGuildResourceSuspense(guildRolesAtom, workspaceId);

export const useWorkspaceConfigResult = (workspaceId: string) =>
  useGuildResourceSuspense(workspaceConfigAtom, workspaceId);

export const useWorkspaceMonitorRolesResult = (workspaceId: string) =>
  useGuildResourceSuspense(workspaceMonitorRolesAtom, workspaceId);

export const useWorkspaceConversationsResult = (workspaceId: string) =>
  useGuildResourceSuspense(workspaceConversationsAtom, workspaceId);

export const useUpsertWorkspaceConfig = () =>
  useGuildMutation(upsertWorkspaceConfigMutation, workspaceConfigMutationRequest);

export const useAddWorkspaceMonitorRole = () =>
  useGuildMutation(addMonitorRoleMutation, monitorRoleMutationRequest);

export const useRemoveWorkspaceMonitorRole = () =>
  useGuildMutation(removeMonitorRoleMutation, monitorRoleMutationRequest);

export const useUpsertWorkspaceConversation = () =>
  useGuildMutation(upsertConversationMutation, conversationMutationRequest);

export const useSetupWorkspaceConversationLockdown = () =>
  useGuildMutation(setupLockdownMutation, lockdownMutationRequest);

export const useUndoWorkspaceConversationLockdown = () =>
  useGuildMutation(undoLockdownMutation, lockdownMutationRequest);

const hasWorkspacePermission = (
  permissions: PermissionSet,
  permission: "monitor_workspace" | "manage_workspace",
  workspaceId: string,
) => HashSet.has(permissions, `${permission}:${workspaceId}`);

export const guildCapabilities = (permissions: PermissionSet, workspaceId: string) => {
  const elevated = HashSet.has(permissions, "service") || HashSet.has(permissions, "app_owner");
  const canManage =
    elevated || hasWorkspacePermission(permissions, "manage_workspace", workspaceId);
  const canLockdown =
    canManage || hasWorkspacePermission(permissions, "monitor_workspace", workspaceId);
  return { canManage, canLockdown };
};

export const serverConfigFormFrom = (config: WorkspaceConfigValue): ServerConfigForm => ({
  sheetId: Option.getOrElse(config.sheetId, () => ""),
  autoCheckin: Option.getOrElse(config.autoCheckin, () => false),
  monitorConversationId: Option.getOrElse(config.monitorConversationId, () => ""),
});

export const serverConfigPatch = (
  config: WorkspaceConfigValue,
  form: ServerConfigForm,
): ServerConfigPatch => {
  const patch: ServerConfigPatch = {};
  const currentSheetId = Option.getOrElse(config.sheetId, () => "");
  const sheetId = form.sheetId.trim();
  if (sheetId !== currentSheetId && sheetId.length > 0) {
    patch.sheetId = sheetId;
  }
  const currentAutoCheckin = Option.getOrElse(config.autoCheckin, () => false);
  if (form.autoCheckin !== currentAutoCheckin) {
    patch.autoCheckin = form.autoCheckin;
  }
  const currentMonitorConversationId = Option.getOrElse(config.monitorConversationId, () => "");
  const monitorConversationId = form.monitorConversationId.trim();
  if (monitorConversationId !== currentMonitorConversationId) {
    patch.monitorConversationId = monitorConversationId.length > 0 ? monitorConversationId : null;
  }
  return patch;
};

const runningFormValue = (value: Option.Option<boolean>): OptionalBooleanFormValue =>
  Option.match(value, {
    onNone: () => "unset",
    onSome: (running) => (running ? "enabled" : "disabled"),
  });

const emptyChannelDraft = (): ChannelConfigDraft => ({
  running: "unset",
  nameConfigured: false,
  name: "",
  roleId: "",
  checkinConversationId: "",
});

export const channelDraftFrom = (
  config: WorkspaceConversationConfigValue | undefined,
): ChannelConfigDraft =>
  Predicate.isUndefined(config)
    ? emptyChannelDraft()
    : {
        running: runningFormValue(config.running),
        nameConfigured: Option.isSome(config.name),
        name: Option.getOrElse(config.name, () => ""),
        roleId: Option.getOrElse(config.roleId, () => ""),
        checkinConversationId: Option.getOrElse(config.checkinConversationId, () => ""),
      };

const booleanFormValues: Record<OptionalBooleanFormValue, boolean | null> = {
  unset: null,
  enabled: true,
  disabled: false,
};

const booleanFromDraft = (value: OptionalBooleanFormValue) => booleanFormValues[value];

const nullableOptionChanged = <A>(
  current: Option.Option<A>,
  desired: A | null,
  equals: (left: A, right: A) => boolean,
) =>
  Option.match(current, {
    onNone: () => desired !== null,
    onSome: (value) => desired === null || !equals(value, desired),
  });

export const channelConfigPatch = (
  config: WorkspaceConversationConfigValue | undefined,
  draft: ChannelConfigDraft,
): ChannelConfigPatchValue => {
  const desiredRunning = booleanFromDraft(draft.running);
  const trimmedName = draft.name.trim();
  const desiredName = draft.nameConfigured && trimmedName.length > 0 ? trimmedName : null;
  const desiredRoleId = draft.roleId.length > 0 ? draft.roleId : null;
  const desiredCheckinConversationId =
    draft.checkinConversationId.length > 0 ? draft.checkinConversationId : null;
  const shouldPatchNullableField = <Value>(current: Option.Option<Value>, desired: Value | null) =>
    Predicate.isUndefined(config)
      ? desired !== null
      : nullableOptionChanged(current, desired, Object.is);

  return {
    ...(shouldPatchNullableField(config?.running ?? Option.none(), desiredRunning)
      ? { running: desiredRunning }
      : {}),
    ...(shouldPatchNullableField(config?.name ?? Option.none(), desiredName)
      ? { name: desiredName }
      : {}),
    ...(shouldPatchNullableField(config?.roleId ?? Option.none(), desiredRoleId)
      ? { roleId: desiredRoleId }
      : {}),
    ...(shouldPatchNullableField(
      config?.checkinConversationId ?? Option.none(),
      desiredCheckinConversationId,
    )
      ? { checkinConversationId: desiredCheckinConversationId }
      : {}),
  };
};

export const isEmptyPatch = (patch: Readonly<Record<string, unknown>>) =>
  Object.keys(patch).length === 0;

export const sortGuildChannels = (channels: ReadonlyArray<DiscordGuildChannel>) =>
  [...channels].sort(
    (left, right) =>
      left.position - right.position ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );

export const sortGuildRoles = (roles: ReadonlyArray<DiscordGuildRole>) =>
  [...roles].sort(
    (left, right) =>
      right.position - left.position ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );

const channelLabelKey = (channel: DiscordGuildChannel, label: string) =>
  `${isDiscordCategoryChannelType(channel.type) ? "category" : "channel"}:${label}`;

const countChannelLabels = (
  channels: ReadonlyArray<DiscordGuildChannel>,
  labelById: ReadonlyMap<string, string>,
) => {
  const counts = new Map<string, number>();
  for (const channel of channels) {
    const label = labelById.get(channel.id) ?? channel.name;
    const key = channelLabelKey(channel, label);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

const makeChannelBaseLabels = (
  channels: ReadonlyArray<DiscordGuildChannel>,
  nameCounts: ReadonlyMap<string, number>,
  categoriesById: ReadonlyMap<string, DiscordGuildChannel>,
) => {
  const labels = new Map<string, string>();
  for (const channel of channels) {
    const duplicate = (nameCounts.get(channelLabelKey(channel, channel.name)) ?? 0) > 1;
    const category = Predicate.isString(channel.parentId)
      ? categoriesById.get(channel.parentId)
      : undefined;
    const context = category?.name ?? channel.id.slice(-4);
    labels.set(channel.id, duplicate ? `${channel.name} · ${context}` : channel.name);
  }
  return labels;
};

export const buildChannelLabels = (
  channels: ReadonlyArray<DiscordGuildChannel>,
): ReadonlyMap<string, string> => {
  const categoriesById = new Map<string, DiscordGuildChannel>();
  const channelNames = new Map<string, string>();
  for (const channel of channels) {
    channelNames.set(channel.id, channel.name);
    if (isDiscordCategoryChannelType(channel.type)) {
      categoriesById.set(channel.id, channel);
    }
  }

  const nameCounts = countChannelLabels(channels, channelNames);
  const baseLabels = makeChannelBaseLabels(channels, nameCounts, categoriesById);
  const baseLabelCounts = countChannelLabels(channels, baseLabels);
  const labels = new Map<string, string>();
  for (const channel of channels) {
    const baseLabel = baseLabels.get(channel.id) ?? channel.name;
    const baseLabelKey = channelLabelKey(channel, baseLabel);
    labels.set(
      channel.id,
      (baseLabelCounts.get(baseLabelKey) ?? 0) > 1 ? `${baseLabel} · ${channel.id}` : baseLabel,
    );
  }
  return labels;
};
