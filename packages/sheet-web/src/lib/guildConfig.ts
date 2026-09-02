import { useAtomSet, useAtomSuspense } from "@effect/atom-react";
import { Duration, Effect, HashSet, Option, Predicate, Schema } from "effect";
import { AsyncResult, Atom, Reactivity } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";
import { isDiscordCategoryChannelType } from "sheet-bot-api";
import { api as sheetZeroApi } from "sheet-zero-api";
import {
  ConfigWorkspaceConversationRow,
  ConfigWorkspaceMonitorRoleRow,
  ConfigWorkspaceRow,
} from "sheet-zero-api/rows";
import {
  ConversationsSetLockdownInput,
  ConversationsSetLockdownSuccess,
  DiscordChannel,
  DiscordLoadWorkspaceChannelsSuccess,
  DiscordRole,
  DiscordLoadWorkspaceRolesSuccess,
  WorkspaceCapabilities,
  WorkspaceInput,
} from "sheet-workflow-contracts";
import { runSheetWorkflow, sheetZeroClientAtom } from "#/lib/sheetZero";
import { runtimeAtom } from "#/lib/runtime";
import { makeQuery } from "typhoon-zero/zeroApiAtom";
import { decodeOptionalQueryResult } from "./zeroQuery";

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

export type Permission = string;
export type PermissionSet = Schema.Schema.Type<typeof PermissionSetSchema>;
export type WorkspaceConfigValue = ConfigWorkspaceRow;
export type WorkspaceConversationConfigValue = ConfigWorkspaceConversationRow;

const PermissionSchema = Schema.String;
const PermissionSetSchema = Schema.HashSet(PermissionSchema);
const CurrentUserPermissions = Schema.Struct({ permissions: PermissionSetSchema });

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

class WorkspaceNotRegisteredError extends Schema.TaggedErrorClass<WorkspaceNotRegisteredError>()(
  "WorkspaceNotRegisteredError",
  { message: Schema.Literal("The workspace is not registered") },
) {}

class WorkspaceConfigurationNotReturnedError extends Schema.TaggedErrorClass<WorkspaceConfigurationNotReturnedError>()(
  "WorkspaceConfigurationNotReturnedError",
  { message: Schema.Literal("The workspace configuration was not returned") },
) {}

class ConversationConfigurationNotReturnedError extends Schema.TaggedErrorClass<ConversationConfigurationNotReturnedError>()(
  "ConversationConfigurationNotReturnedError",
  { message: Schema.Literal("The conversation configuration was not returned") },
) {}

const configKey = (workspaceId: string) => `guildConfig.server.${workspaceId}`;
const permissionKey = (workspaceId: string) => `guildConfig.permissions.${workspaceId}`;
const monitorRolesKey = (workspaceId: string) => `guildConfig.monitorRoles.${workspaceId}`;
const discordChannelsKey = (workspaceId: string) => `guildConfig.discordChannels.${workspaceId}`;
const discordRolesKey = (workspaceId: string) => `guildConfig.discordRoles.${workspaceId}`;
const conversationsKey = (workspaceId: string) => `guildConfig.conversations.${workspaceId}`;

const asyncResultSchema = <Success extends Schema.Top>(success: Success) =>
  Schema.revealCodec(
    AsyncResult.Schema({
      success,
      error: Schema.Unknown,
    }),
  );

const makeUuid = () => {
  const browserCrypto = globalThis.crypto;
  const randomUUID = browserCrypto?.randomUUID?.bind(browserCrypto);
  if (Predicate.isFunction(randomUUID)) {
    return randomUUID();
  }

  const bytes = new Uint8Array(16);
  const getRandomValues = browserCrypto?.getRandomValues?.bind(browserCrypto);
  if (Predicate.isFunction(getRandomValues)) {
    getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hexadecimal = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hexadecimal.slice(0, 4).join(""),
    hexadecimal.slice(4, 6).join(""),
    hexadecimal.slice(6, 8).join(""),
    hexadecimal.slice(8, 10).join(""),
    hexadecimal.slice(10).join(""),
  ].join("-");
};

const guildQueryFamily = <A>(
  key: string,
  schema: Schema.Codec<AsyncResult.AsyncResult<A, unknown>, unknown>,
  query: (workspaceId: string) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
) =>
  Atom.family((workspaceId: string) =>
    query(workspaceId).pipe(
      Atom.setIdleTTL(Duration.minutes(2)),
      Atom.serializable({
        key: `${key}.${workspaceId}`,
        schema,
      }),
      Atom.withReactivity([`${key}.${workspaceId}`]),
    ),
  );

type SheetZeroClient = Atom.Success<typeof sheetZeroClientAtom>;

const makeWorkspaceRowsAtom = <A>(
  key: string,
  rowSchema: Schema.Codec<A, unknown, never, never>,
  query: (
    sheet: SheetZeroClient["sheet"],
    workspaceId: string,
  ) => Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>,
) =>
  (() => {
    const rowsSchema = Schema.Array(rowSchema);
    return guildQueryFamily(key, asyncResultSchema(rowsSchema), (workspaceId: string) =>
      Atom.make(
        Effect.fnUntraced(function* (get) {
          const runtime = yield* get.result(sheetZeroClientAtom);
          const rawRows = yield* get.result(query(runtime.sheet, workspaceId));
          return yield* Schema.decodeUnknownEffect(rowsSchema)(rawRows);
        }),
      ),
    );
  })();

const makeWorkspaceWorkflowAtom = <A>(
  key: string,
  serializedSchema: Schema.Codec<AsyncResult.AsyncResult<A, unknown>, unknown, never, never>,
  load: (
    runtime: SheetZeroClient,
    input: Schema.Schema.Type<typeof WorkspaceInput>,
  ) => Effect.Effect<A, unknown>,
) =>
  guildQueryFamily(key, serializedSchema, (workspaceId: string) =>
    Atom.make(
      Effect.fnUntraced(function* (get) {
        const runtime = yield* get.result(sheetZeroClientAtom);
        const input = yield* Schema.decodeUnknownEffect(WorkspaceInput)({ workspaceId });
        return yield* load(runtime, input);
      }),
    ),
  );

const invalidateMonitorRoleConfiguration = (workspaceId: string) =>
  Reactivity.invalidate([
    configKey(workspaceId),
    permissionKey(workspaceId),
    monitorRolesKey(workspaceId),
  ]);

type WorkspaceConfigClient = SheetZeroClient["sheet"]["grouped"]["workspaceConfig"];
type MonitorRoleMutationPayload = Parameters<WorkspaceConfigClient["addWorkspaceMonitorRole"]>[0];
type MonitorRoleMutation = (
  workspaceConfig: WorkspaceConfigClient,
  payload: MonitorRoleMutationPayload,
) => ReturnType<WorkspaceConfigClient["addWorkspaceMonitorRole"]>;

const makeMonitorRoleMutation = (update: MonitorRoleMutation) =>
  runtimeAtom.fn(
    Effect.fnUntraced(function* (payload: MonitorRoleMutationPayload, ctx: Atom.FnContext) {
      const runtime = yield* ctx.result(sheetZeroClientAtom);
      yield* update(runtime.sheet.grouped.workspaceConfig, payload);
      yield* invalidateMonitorRoleConfiguration(payload.workspaceId);
    }),
  );

export const guildPermissionsAtom = makeWorkspaceWorkflowAtom(
  "guildConfig.permissions",
  asyncResultSchema(CurrentUserPermissions),
  (runtime, input) =>
    Effect.gen(function* () {
      const capabilities = yield* runSheetWorkflow(
        runtime.workflows.authorization.loadWorkspaceCapabilities,
        input,
        WorkspaceCapabilities,
      );
      const permissionForCapability: Record<
        (typeof capabilities.capabilities)[number],
        (workspace: string) => string
      > = {
        member: (workspace) => `member_workspace:${workspace}`,
        monitor: (workspace) => `monitor_workspace:${workspace}`,
        manage: (workspace) => `manage_workspace:${workspace}`,
        participant: (workspace) => `member_workspace:${workspace}`,
        app_owner: () => "app_owner",
      };
      const permissions = yield* Effect.forEach(capabilities.capabilities, (capability) =>
        Schema.decodeUnknownEffect(PermissionSchema)(
          permissionForCapability[capability](input.workspaceId),
        ),
      );
      return { permissions: HashSet.fromIterable(permissions) };
    }),
);

export const guildChannelsAtom = makeWorkspaceWorkflowAtom(
  "guildConfig.discordChannels",
  asyncResultSchema(DiscordLoadWorkspaceChannelsSuccess),
  (runtime, input) =>
    runSheetWorkflow(
      runtime.workflows.discord.loadWorkspaceChannels,
      input,
      DiscordLoadWorkspaceChannelsSuccess,
    ),
);

export const guildRolesAtom = makeWorkspaceWorkflowAtom(
  "guildConfig.discordRoles",
  asyncResultSchema(DiscordLoadWorkspaceRolesSuccess),
  (runtime, input) =>
    runSheetWorkflow(
      runtime.workflows.discord.loadWorkspaceRoles,
      input,
      DiscordLoadWorkspaceRolesSuccess,
    ),
);

export const workspaceConfigAtom = guildQueryFamily(
  "guildConfig.server",
  asyncResultSchema(ConfigWorkspaceRow),
  (workspaceId: string) =>
    Atom.make(
      Effect.fnUntraced(function* (get) {
        const runtime = yield* get.result(sheetZeroClientAtom);
        const row = yield* get.result(
          makeQuery(runtime.sheet, sheetZeroApi.workspaceConfig.getWorkspaceConfigByWorkspaceId, {
            workspaceId,
          }),
        );
        const decodedRow = yield* decodeOptionalQueryResult(ConfigWorkspaceRow, row);
        if (Option.isNone(decodedRow)) {
          return yield* Effect.fail(
            new WorkspaceNotRegisteredError({ message: "The workspace is not registered" }),
          );
        }
        return decodedRow.value;
      }),
    ),
);

export const workspaceMonitorRolesAtom = makeWorkspaceRowsAtom(
  "guildConfig.monitorRoles",
  ConfigWorkspaceMonitorRoleRow,
  (sheet, workspaceId) =>
    makeQuery(sheet, sheetZeroApi.workspaceConfig.getWorkspaceMonitorRoles, { workspaceId }),
);

export const workspaceConversationsAtom = makeWorkspaceRowsAtom(
  "guildConfig.conversations",
  ConfigWorkspaceConversationRow,
  (sheet, workspaceId) =>
    makeQuery(sheet, sheetZeroApi.workspaceConfig.getWorkspaceConversations, { workspaceId }),
);

const upsertWorkspaceConfigMutation = runtimeAtom.fn(
  Effect.fnUntraced(function* (
    payload: { readonly workspaceId: string; readonly config: ServerConfigPatch },
    ctx: Atom.FnContext,
  ) {
    const runtime = yield* ctx.result(sheetZeroClientAtom);
    yield* runtime.sheet.grouped.workspaceConfig.upsertWorkspaceConfig({
      workspaceId: payload.workspaceId,
      ...payload.config,
    });
    yield* Reactivity.invalidate([configKey(payload.workspaceId)]);
    const rawRow = yield* runtime.sheet.grouped.workspaceConfig.getWorkspaceConfigByWorkspaceId({
      workspaceId: payload.workspaceId,
    });
    const row = yield* decodeOptionalQueryResult(ConfigWorkspaceRow, rawRow);
    if (Option.isNone(row)) {
      return yield* Effect.fail(
        new WorkspaceConfigurationNotReturnedError({
          message: "The workspace configuration was not returned",
        }),
      );
    }
    return row.value;
  }),
);

const addMonitorRoleMutation = makeMonitorRoleMutation((workspaceConfig, payload) =>
  workspaceConfig.addWorkspaceMonitorRole(payload),
);

const removeMonitorRoleMutation = makeMonitorRoleMutation((workspaceConfig, payload) =>
  workspaceConfig.removeWorkspaceMonitorRole(payload),
);

const upsertConversationMutation = runtimeAtom.fn(
  Effect.fnUntraced(function* (
    payload: {
      readonly workspaceId: string;
      readonly conversationId: string;
      readonly config: ChannelConfigPatchValue;
    },
    ctx: Atom.FnContext,
  ) {
    const runtime = yield* ctx.result(sheetZeroClientAtom);
    yield* runtime.sheet.grouped.workspaceConfig.upsertWorkspaceConversationConfig({
      workspaceId: payload.workspaceId,
      conversationId: payload.conversationId,
      ...payload.config,
    });
    yield* Reactivity.invalidate([configKey(payload.workspaceId)]);
    const rawRows = yield* runtime.sheet.grouped.workspaceConfig.getWorkspaceConversations({
      workspaceId: payload.workspaceId,
    });
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ConfigWorkspaceConversationRow))(
      rawRows,
    );
    const row = rows.find((candidate) => candidate.conversationId === payload.conversationId);
    if (Predicate.isUndefined(row)) {
      return yield* Effect.fail(
        new ConversationConfigurationNotReturnedError({
          message: "The conversation configuration was not returned",
        }),
      );
    }
    return row;
  }),
);

const lockdownMutation = runtimeAtom.fn(
  Effect.fnUntraced(function* (
    payload: {
      readonly workspaceId: string;
      readonly conversationId: string;
      readonly enabled: boolean;
    },
    ctx: Atom.FnContext,
  ) {
    const runtime = yield* ctx.result(sheetZeroClientAtom);
    const input = yield* Schema.decodeUnknownEffect(ConversationsSetLockdownInput)({
      workspaceId: payload.workspaceId,
      conversationId: payload.conversationId,
      enabled: payload.enabled,
      responseReference: `sheet-web:${makeUuid()}`,
    });
    const result = yield* runSheetWorkflow(
      runtime.workflows.conversations.setLockdown,
      input,
      ConversationsSetLockdownSuccess,
    );
    yield* Reactivity.invalidate([
      configKey(payload.workspaceId),
      discordChannelsKey(payload.workspaceId),
      discordRolesKey(payload.workspaceId),
      conversationsKey(payload.workspaceId),
    ]);
    return result;
  }),
);

const useGuildMutation = <Args extends ReadonlyArray<unknown>, Payload, Result, Err>(
  mutation: Atom.AtomResultFn<Payload, Result, Err>,
  request: (...args: Args) => Payload,
) => {
  const mutate = useAtomSet(mutation, { mode: "promise" });
  return useCallback((...args: Args) => mutate(request(...args)), [mutate, request]);
};

const workspaceConfigMutationRequest = (workspaceId: string, config: ServerConfigPatch) => ({
  workspaceId,
  config,
});

const monitorRoleMutationRequest = (workspaceId: string, roleId: string) => ({
  workspaceId,
  roleId,
});

const conversationMutationRequest = (
  workspaceId: string,
  conversationId: string,
  config: ChannelConfigPatchValue,
) => ({
  workspaceId,
  conversationId,
  config,
});

const lockdownMutationRequest = (
  workspaceId: string,
  conversationId: string,
  enabled: boolean,
) => ({
  workspaceId,
  conversationId,
  enabled,
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

export const useSetupWorkspaceConversationLockdown = () => {
  const mutate = useAtomSet(lockdownMutation, { mode: "promise" });
  return useCallback(
    (workspaceId: string, conversationId: string) =>
      mutate(lockdownMutationRequest(workspaceId, conversationId, true)),
    [mutate],
  );
};

export const useUndoWorkspaceConversationLockdown = () => {
  const mutate = useAtomSet(lockdownMutation, { mode: "promise" });
  return useCallback(
    (workspaceId: string, conversationId: string) =>
      mutate(lockdownMutationRequest(workspaceId, conversationId, false)),
    [mutate],
  );
};

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
  sheetId: config.sheetId ?? "",
  autoCheckin: config.autoCheckin ?? false,
  monitorConversationId: config.monitorConversationId ?? "",
});

export const serverConfigPatch = (
  config: WorkspaceConfigValue,
  form: ServerConfigForm,
): ServerConfigPatch => {
  const patch: ServerConfigPatch = {};
  const currentSheetId = config.sheetId ?? "";
  const sheetId = form.sheetId.trim();
  if (sheetId !== currentSheetId && sheetId.length > 0) {
    patch.sheetId = sheetId;
  }
  const currentAutoCheckin = config.autoCheckin ?? false;
  if (form.autoCheckin !== currentAutoCheckin) {
    patch.autoCheckin = form.autoCheckin;
  }
  const currentMonitorConversationId = config.monitorConversationId ?? "";
  const monitorConversationId = form.monitorConversationId.trim();
  if (monitorConversationId !== currentMonitorConversationId) {
    patch.monitorConversationId = monitorConversationId.length > 0 ? monitorConversationId : null;
  }
  return patch;
};

const runningFormValue = (value: boolean | null): OptionalBooleanFormValue =>
  value === null ? "unset" : value ? "enabled" : "disabled";

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
        nameConfigured: config.name !== null,
        name: config.name ?? "",
        roleId: config.roleId ?? "",
        checkinConversationId: config.checkinConversationId ?? "",
      };

const booleanFormValues: Record<OptionalBooleanFormValue, boolean | null> = {
  unset: null,
  enabled: true,
  disabled: false,
};

const booleanFromDraft = (value: OptionalBooleanFormValue) => booleanFormValues[value];

const nullableValueChanged = <A>(
  current: A | null,
  desired: A | null,
  equals: (left: A, right: A) => boolean,
) => (current === null ? desired !== null : desired === null || !equals(current, desired));

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
  const shouldPatchNullableField = <Value>(current: Value | null, desired: Value | null) =>
    Predicate.isUndefined(config)
      ? desired !== null
      : nullableValueChanged(current, desired, Object.is);

  return {
    ...(shouldPatchNullableField(config?.running ?? null, desiredRunning)
      ? { running: desiredRunning }
      : {}),
    ...(shouldPatchNullableField(config?.name ?? null, desiredName) ? { name: desiredName } : {}),
    ...(shouldPatchNullableField(config?.roleId ?? null, desiredRoleId)
      ? { roleId: desiredRoleId }
      : {}),
    ...(shouldPatchNullableField(
      config?.checkinConversationId ?? null,
      desiredCheckinConversationId,
    )
      ? { checkinConversationId: desiredCheckinConversationId }
      : {}),
  };
};

export const isEmptyPatch = (patch: Readonly<Record<string, unknown>>) =>
  Object.keys(patch).length === 0;

export const sortGuildChannels = (channels: ReadonlyArray<typeof DiscordChannel.Type>) =>
  [...channels].sort(
    (left, right) =>
      left.position - right.position ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );

export const sortGuildRoles = (roles: ReadonlyArray<typeof DiscordRole.Type>) =>
  [...roles].sort(
    (left, right) =>
      right.position - left.position ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );

const channelLabelKey = (channel: typeof DiscordChannel.Type, label: string) =>
  `${isDiscordCategoryChannelType(channel.type) ? "category" : "channel"}:${label}`;

const countChannelLabels = (
  channels: ReadonlyArray<typeof DiscordChannel.Type>,
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
  channels: ReadonlyArray<typeof DiscordChannel.Type>,
  nameCounts: ReadonlyMap<string, number>,
  categoriesById: ReadonlyMap<string, typeof DiscordChannel.Type>,
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
  channels: ReadonlyArray<typeof DiscordChannel.Type>,
): ReadonlyMap<string, string> => {
  const categoriesById = new Map<string, typeof DiscordChannel.Type>();
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
