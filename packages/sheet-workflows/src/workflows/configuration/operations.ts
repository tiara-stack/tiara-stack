import { Context, Data, Effect, Layer, Option, Predicate, Schema } from "effect";
import {
  type BotOutboundMessage,
  type BotPermissionOverwrite,
  type BotConversation,
  type ClientRef,
  DeliveryKey,
  type DeliveryReceipt,
  type ResponseReference,
  conversationRefFrom,
} from "sheet-bot-api";
import {
  isLockdownRoleIdAllowed,
  isSendableDiscordChannelType,
  lockdownEveryoneRoleErrorMessage,
  makeLockdownPermissionOverwrites,
} from "sheet-ingress-api/guild-config";
import {
  conversationMentionValue,
  escapeMarkdown,
  formatConversationConfigFields,
  makeEmbed,
  roleMentionValue,
} from "sheet-message-content/rendering";
import * as MessageText from "sheet-message-content/text";
import {
  InteractiveDeclaredFailure,
  type ConversationsSetLockdownInput,
  type ConversationsUpdateConfigAndDeliverInput,
  type WorkspacesSetMonitorRoleAndDeliverInput,
  type WorkspacesUpdateConfigAndDeliverInput,
} from "sheet-workflow-contracts";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { config } from "@/config";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  interactiveInvalidRequest as invalidRequest,
  interactiveResourceNotFound as resourceNotFound,
  mapBotCacheFailure,
  mapDeliveryFailure,
} from "../shared/interactive";

export const WorkspaceConfigurationState = Schema.Struct({
  workspaceId: Schema.String,
  workspaceName: Schema.NullOr(Schema.String),
  sheetId: Schema.NullOr(Schema.String),
  autoCheckin: Schema.Boolean,
  monitorConversationId: Schema.NullOr(Schema.String),
  monitorRoleIds: Schema.Array(Schema.String),
});
type WorkspaceConfigurationState = typeof WorkspaceConfigurationState.Type;

export const ConversationConfigurationState = Schema.Struct({
  workspaceId: Schema.String,
  conversationId: Schema.String,
  exists: Schema.Boolean,
  name: Schema.NullOr(Schema.String),
  running: Schema.NullOr(Schema.Boolean),
  roleId: Schema.NullOr(Schema.String),
  checkinConversationId: Schema.NullOr(Schema.String),
});
type ConversationConfigurationState = typeof ConversationConfigurationState.Type;

export const LockdownConfigurationState = Schema.Struct({
  workspaceId: Schema.String,
  conversationId: Schema.String,
  enabled: Schema.Boolean,
  roleId: Schema.NullOr(Schema.String),
  monitorRoleIds: Schema.Array(Schema.String),
});
type LockdownConfigurationState = typeof LockdownConfigurationState.Type;

class ConfigurationWorkflowOperationsError extends Data.TaggedError(
  "ConfigurationWorkflowOperationsError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type ConfigurationResult<A> = Effect.Effect<
  A,
  InteractiveDeclaredFailure | ConfigurationWorkflowOperationsError
>;

interface ConfigurationWorkflowOperationsShape {
  readonly loadWorkspace: (
    workspaceId: string,
    policy: string,
    options: { readonly requireConfig: boolean },
  ) => ConfigurationResult<WorkspaceConfigurationState>;
  readonly updateWorkspace: (
    input: WorkspacesUpdateConfigAndDeliverInput,
    current: WorkspaceConfigurationState,
    policy: string,
  ) => ConfigurationResult<WorkspaceConfigurationState>;
  readonly setMonitorRole: (
    input: WorkspacesSetMonitorRoleAndDeliverInput,
    current: WorkspaceConfigurationState,
    policy: string,
  ) => ConfigurationResult<WorkspaceConfigurationState>;
  readonly loadConversation: (
    workspaceId: string,
    conversationId: string,
    policy: string,
    options: { readonly requireConfig: boolean },
  ) => ConfigurationResult<ConversationConfigurationState>;
  readonly updateConversation: (
    input: ConversationsUpdateConfigAndDeliverInput,
    current: ConversationConfigurationState,
    policy: string,
  ) => ConfigurationResult<ConversationConfigurationState>;
  readonly loadLockdown: (
    input: ConversationsSetLockdownInput,
    policy: string,
  ) => ConfigurationResult<LockdownConfigurationState>;
  readonly replaceLockdownPermissions: (
    state: LockdownConfigurationState,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => ConfigurationResult<DeliveryReceipt>;
  readonly deliverWorkspaceConfig: (
    responseReference: ResponseReference,
    state: WorkspaceConfigurationState,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
    options: { readonly recoveryRequired: boolean },
  ) => ConfigurationResult<DeliveryReceipt>;
  readonly deliverMonitorRole: (
    input: WorkspacesSetMonitorRoleAndDeliverInput,
    workspaceName: string | null,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => ConfigurationResult<DeliveryReceipt>;
  readonly deliverConversationConfig: (
    responseReference: ResponseReference,
    state: ConversationConfigurationState,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
    options: {
      readonly recoveryRequired: boolean;
      readonly updated: boolean;
    },
  ) => ConfigurationResult<DeliveryReceipt>;
  readonly deliverLockdownResponse: (
    input: ConversationsSetLockdownInput,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => ConfigurationResult<DeliveryReceipt>;
}

export class ConfigurationWorkflowOperations extends Context.Service<
  ConfigurationWorkflowOperations,
  ConfigurationWorkflowOperationsShape
>()("sheet-workflows/ConfigurationWorkflowOperations") {}

const operationError = (operation: string, cause: unknown) =>
  new ConfigurationWorkflowOperationsError({ operation, cause });

const mapCacheFailure = (policy: string, resource: string, operation: string) =>
  mapBotCacheFailure(policy, resource, operation, operationError);

const mapPersistenceFailure = (operation: string, rejectionMessage?: string) => (error: unknown) =>
  Predicate.isString(rejectionMessage) && Predicate.isTagged("ArgumentError")(error)
    ? invalidRequest("ConfigurationRejected", rejectionMessage)
    : operationError(operation, error);

type ConversationConfigurationPatch = ConversationsUpdateConfigAndDeliverInput["patch"];
type WorkspaceConfigurationPatch = WorkspacesUpdateConfigAndDeliverInput["patch"];

const definedWorkspacePatch = (patch: WorkspaceConfigurationPatch) => ({
  ...(Predicate.isUndefined(patch.spreadsheetId) ? {} : { sheetId: patch.spreadsheetId }),
  ...(Predicate.isUndefined(patch.autoCheckin) ? {} : { autoCheckin: patch.autoCheckin }),
  ...(Predicate.isUndefined(patch.monitorConversationId)
    ? {}
    : { monitorConversationId: patch.monitorConversationId }),
});

const definedConversationPatch = (patch: ConversationConfigurationPatch) => ({
  ...(Predicate.isUndefined(patch.running) ? {} : { running: patch.running }),
  ...(Predicate.isUndefined(patch.name) ? {} : { name: patch.name }),
  ...(Predicate.isUndefined(patch.roleId) ? {} : { roleId: patch.roleId }),
  ...(Predicate.isUndefined(patch.checkinConversationId)
    ? {}
    : { checkinConversationId: patch.checkinConversationId }),
});

const workspaceDisplayName = (state: Pick<WorkspaceConfigurationState, "workspaceName">) =>
  Predicate.isString(state.workspaceName) && state.workspaceName.trim().length > 0
    ? [MessageText.text(escapeMarkdown(state.workspaceName.trim()))]
    : [MessageText.text("this "), MessageText.clientTerm("workspace")];

const workspaceConfigMessage = (
  client: ClientRef,
  state: WorkspaceConfigurationState,
): BotOutboundMessage => ({
  embeds: [
    makeEmbed({
      title: [MessageText.text("Config for "), ...workspaceDisplayName(state)],
      description: MessageText.lines(
        [
          MessageText.text(
            `Sheet id: ${state.sheetId === null ? "None" : escapeMarkdown(state.sheetId)}`,
          ),
        ],
        [MessageText.text(`Auto check-in: ${state.autoCheckin ? "Enabled" : "Disabled"}`)],
        [
          MessageText.text("Monitor channel: "),
          ...(state.monitorConversationId === null
            ? [MessageText.text("None")]
            : conversationMentionValue(client, state.workspaceId, state.monitorConversationId)),
        ],
        [
          MessageText.clientTerm("monitorRole", { form: "plural", casing: "sentence" }),
          MessageText.text(": "),
          ...(state.monitorRoleIds.length === 0
            ? [MessageText.text("None")]
            : MessageText.joinText(
                state.monitorRoleIds.map((roleId) =>
                  roleMentionValue(client, state.workspaceId, roleId),
                ),
                ", ",
              )),
        ],
      ),
    }),
  ],
});

const conversationConfigMessage = (
  client: ClientRef,
  state: ConversationConfigurationState,
  updated: boolean,
): BotOutboundMessage => ({
  embeds: [
    makeEmbed({
      title: updated
        ? "Success!"
        : [MessageText.text("Config for this "), MessageText.clientTerm("conversation")],
      ...(updated
        ? {
            description: [
              ...conversationMentionValue(client, state.workspaceId, state.conversationId),
              MessageText.text(" configuration updated"),
            ],
          }
        : {}),
      fields: formatConversationConfigFields({
        client,
        workspaceId: state.workspaceId,
        name: Option.fromNullishOr(state.name),
        running: Option.fromNullishOr(state.running),
        roleId: Option.fromNullishOr(state.roleId),
        checkinConversationId: Option.fromNullishOr(state.checkinConversationId),
      }),
    }),
  ],
});

const monitorRoleMessage = (
  client: ClientRef,
  input: WorkspacesSetMonitorRoleAndDeliverInput,
  workspaceName: string | null,
): BotOutboundMessage => ({
  embeds: [
    makeEmbed({
      title: "Success!",
      description: [
        ...roleMentionValue(client, input.workspaceId, input.roleId),
        MessageText.text(input.enabled ? " is now a " : " is no longer a "),
        MessageText.clientTerm("monitorRole"),
        MessageText.text(" for "),
        ...workspaceDisplayName({ workspaceName }),
      ],
    }),
  ],
});

const lockdownMessage = (
  client: ClientRef,
  input: ConversationsSetLockdownInput,
): BotOutboundMessage => ({
  embeds: [
    makeEmbed({
      title: "Success!",
      description: [
        MessageText.text("Lockdown permissions "),
        MessageText.text(input.enabled ? "set up" : "removed"),
        MessageText.text(" for "),
        ...conversationMentionValue(client, input.workspaceId, input.conversationId),
      ],
    }),
  ],
});

const requireChanges = (operation: string, patch: Readonly<Record<string, unknown>>) =>
  Object.values(patch).some(Predicate.isNotUndefined)
    ? Effect.void
    : Effect.fail(
        invalidRequest("ConfigurationPatchRequired", `Cannot ${operation} without changes`),
      );

const permissionOverwriteKind = {
  0: "role",
  1: "member",
} as const satisfies Record<0 | 1, BotPermissionOverwrite["targetKind"]>;

// TIA-87 defines lockdown as a complete overwrite replacement. Disabling it sends an empty
// replacement so the conversation returns entirely to its inherited permission defaults.
const botPermissionOverwrites = (
  state: LockdownConfigurationState,
): ReadonlyArray<BotPermissionOverwrite> =>
  state.enabled && Predicate.isNotNullish(state.roleId)
    ? makeLockdownPermissionOverwrites({
        workspaceId: state.workspaceId,
        lockdownRoleId: state.roleId,
        monitorRoleIds: state.monitorRoleIds,
      }).map(({ id, type, allow, deny }) => ({
        targetId: id,
        targetKind: permissionOverwriteKind[type],
        allow,
        deny,
      }))
    : [];

export const configurationWorkflowOperationsLayer = Layer.effect(
  ConfigurationWorkflowOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const cache = yield* SheetBotCacheClient;
    const delivery = yield* SheetBotDeliveryClient;
    const clientId = yield* config.sheetBotClientId;
    const client = { platform: "discord", clientId } as const;

    const loadWorkspace: ConfigurationWorkflowOperationsShape["loadWorkspace"] = (
      workspaceId,
      policy,
      { requireConfig },
    ) =>
      Effect.all(
        {
          provider: cache
            .get()
            .cache.getWorkspace({ params: { ...client, workspaceId } })
            .pipe(
              Effect.mapError(mapCacheFailure(policy, "workspace", "workspaces.loadProviderState")),
            ),
          config: persistence.workspaces
            .getWorkspaceConfigByWorkspaceId({ workspaceId })
            .pipe(Effect.mapError(mapPersistenceFailure("workspaces.loadConfig"))),
          monitorRoles: persistence.workspaces
            .getWorkspaceMonitorRoles({ workspaceId })
            .pipe(Effect.mapError(mapPersistenceFailure("workspaces.loadMonitorRoles"))),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.flatMap(({ provider, config: maybeConfig, monitorRoles }) => {
          const workspaceName = provider.name.trim().length > 0 ? provider.name : null;
          const monitorRoleIds = monitorRoles.map(({ roleId }) => roleId);
          return Option.match(maybeConfig, {
            onNone: () =>
              requireConfig
                ? Effect.fail(resourceNotFound("workspace-config"))
                : Effect.succeed({
                    workspaceId,
                    workspaceName,
                    sheetId: null,
                    autoCheckin: false,
                    monitorConversationId: null,
                    monitorRoleIds,
                  }),
            onSome: (workspaceConfig) =>
              Effect.succeed({
                workspaceId,
                workspaceName,
                sheetId: workspaceConfig.sheetId,
                autoCheckin: workspaceConfig.autoCheckin ?? false,
                monitorConversationId: workspaceConfig.monitorConversationId,
                monitorRoleIds,
              }),
          });
        }),
      );

    const validateConversation = (
      workspaceId: string,
      conversationId: string,
      policy: string,
      operation: string,
    ): ConfigurationResult<BotConversation> =>
      cache
        .get()
        .cache.getConversation({ params: { ...client, workspaceId, conversationId } })
        .pipe(
          Effect.mapError(mapCacheFailure(policy, "conversation", operation)),
          Effect.filterOrFail(
            (conversation) => conversation.workspaceId === workspaceId,
            () =>
              invalidRequest(
                "ConversationWorkspaceMismatch",
                "The conversation must belong to the configured workspace",
              ),
          ),
        );

    const updateWorkspace: ConfigurationWorkflowOperationsShape["updateWorkspace"] = (
      input,
      current,
      policy,
    ) =>
      Effect.gen(function* () {
        yield* requireChanges("update workspace config", input.patch);
        const projectedPatch = definedWorkspacePatch(input.patch);
        if (Predicate.isString(input.patch.monitorConversationId)) {
          const conversation = yield* validateConversation(
            input.workspaceId,
            input.patch.monitorConversationId,
            policy,
            "workspaces.validateMonitorConversation",
          );
          if (!isSendableDiscordChannelType(conversation.type)) {
            return yield* Effect.fail(
              invalidRequest(
                "MonitorConversationNotSendable",
                "The monitor channel must be a text or announcement channel",
              ),
            );
          }
        }
        yield* persistence.workspaces
          .upsertWorkspaceConfig({
            workspaceId: input.workspaceId,
            ...projectedPatch,
          })
          .pipe(
            Effect.mapError(
              mapPersistenceFailure(
                "workspaces.updateConfig",
                "The workspace configuration change was rejected",
              ),
            ),
          );
        return {
          ...current,
          ...projectedPatch,
        };
      });

    const setMonitorRole: ConfigurationWorkflowOperationsShape["setMonitorRole"] = (
      input,
      current,
      policy,
    ) =>
      Effect.gen(function* () {
        if (input.enabled) {
          yield* cache
            .get()
            .cache.getRole({
              params: { ...client, workspaceId: input.workspaceId, roleId: input.roleId },
            })
            .pipe(
              Effect.mapError(mapCacheFailure(policy, "role", "workspaces.validateMonitorRole")),
            );
        }
        yield* (
          input.enabled
            ? persistence.workspaces.addWorkspaceMonitorRole({
                workspaceId: input.workspaceId,
                roleId: input.roleId,
              })
            : persistence.workspaces.removeWorkspaceMonitorRole({
                workspaceId: input.workspaceId,
                roleId: input.roleId,
              })
        ).pipe(
          Effect.mapError(
            mapPersistenceFailure(
              "workspaces.setMonitorRole",
              "The monitor role change was rejected",
            ),
          ),
        );
        const monitorRoleIds = input.enabled
          ? [...new Set([...current.monitorRoleIds, input.roleId])]
          : current.monitorRoleIds.filter((roleId) => roleId !== input.roleId);
        return { ...current, monitorRoleIds };
      });

    const loadConversation: ConfigurationWorkflowOperationsShape["loadConversation"] = (
      workspaceId,
      conversationId,
      policy,
      { requireConfig },
    ) =>
      Effect.all(
        {
          validated: validateConversation(
            workspaceId,
            conversationId,
            policy,
            "conversations.loadProviderState",
          ).pipe(Effect.asVoid),
          config: persistence.workspaces
            .getWorkspaceConversationById({ workspaceId, conversationId })
            .pipe(Effect.mapError(mapPersistenceFailure("conversations.loadConfig"))),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.flatMap(({ config: maybeConfig }) =>
          Option.match(maybeConfig, {
            onNone: () =>
              requireConfig
                ? Effect.fail(resourceNotFound("conversation-config"))
                : Effect.succeed<ConversationConfigurationState>({
                    workspaceId,
                    conversationId,
                    exists: false,
                    name: null,
                    running: null,
                    roleId: null,
                    checkinConversationId: null,
                  }),
            onSome: (conversation) =>
              Effect.succeed<ConversationConfigurationState>({
                workspaceId,
                conversationId,
                exists: true,
                name: conversation.name ?? null,
                running: conversation.running ?? null,
                roleId: conversation.roleId ?? null,
                checkinConversationId: conversation.checkinConversationId ?? null,
              }),
          }),
        ),
      );

    const updateConversation: ConfigurationWorkflowOperationsShape["updateConversation"] = (
      input,
      current,
      policy,
    ) =>
      Effect.gen(function* () {
        yield* requireChanges("update conversation config", input.patch);
        if (!current.exists && Object.values(input.patch).every(Predicate.isNullish)) {
          return yield* Effect.fail(resourceNotFound("conversation-config"));
        }
        yield* Effect.all(
          [
            Predicate.isString(input.patch.roleId)
              ? isLockdownRoleIdAllowed(input.workspaceId, input.patch.roleId)
                ? cache
                    .get()
                    .cache.getRole({
                      params: {
                        ...client,
                        workspaceId: input.workspaceId,
                        roleId: input.patch.roleId,
                      },
                    })
                    .pipe(
                      Effect.mapError(
                        mapCacheFailure(policy, "role", "conversations.validateLockdownRole"),
                      ),
                      Effect.asVoid,
                    )
                : Effect.fail(
                    invalidRequest(
                      "LockdownEveryoneRoleForbidden",
                      lockdownEveryoneRoleErrorMessage,
                    ),
                  )
              : Effect.void,
            Predicate.isString(input.patch.checkinConversationId)
              ? validateConversation(
                  input.workspaceId,
                  input.patch.checkinConversationId,
                  policy,
                  "conversations.validateCheckinConversation",
                ).pipe(Effect.asVoid)
              : Effect.void,
          ],
          { concurrency: "unbounded" },
        );
        const projectedPatch = definedConversationPatch(input.patch);
        yield* persistence.workspaces
          .upsertWorkspaceConversationConfig({
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            ...projectedPatch,
          })
          .pipe(
            Effect.mapError(
              mapPersistenceFailure(
                "conversations.updateConfig",
                "The conversation configuration change was rejected",
              ),
            ),
          );
        return {
          ...current,
          exists: true,
          ...projectedPatch,
        };
      });

    const loadLockdown: ConfigurationWorkflowOperationsShape["loadLockdown"] = (input, policy) =>
      Effect.gen(function* () {
        yield* validateConversation(
          input.workspaceId,
          input.conversationId,
          policy,
          "conversations.validateLockdownConversation",
        );
        if (!input.enabled) {
          return {
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            enabled: false,
            roleId: null,
            monitorRoleIds: [],
          };
        }
        const [maybeConfig, monitorRoles] = yield* Effect.all(
          [
            persistence.workspaces.getWorkspaceConversationById({
              workspaceId: input.workspaceId,
              conversationId: input.conversationId,
            }),
            persistence.workspaces.getWorkspaceMonitorRoles({ workspaceId: input.workspaceId }),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.mapError(mapPersistenceFailure("conversations.loadLockdownConfig")));
        const conversationConfig = yield* Option.match(maybeConfig, {
          onNone: () => Effect.fail(resourceNotFound("conversation-config")),
          onSome: Effect.succeed,
        });
        const roleId = conversationConfig.roleId;
        if (Predicate.isNullish(roleId)) {
          return yield* Effect.fail(
            invalidRequest(
              "LockdownRoleRequired",
              `Cannot set up lockdown permissions, conversation ${input.conversationId} has no lockdown role`,
            ),
          );
        }
        if (!isLockdownRoleIdAllowed(input.workspaceId, roleId)) {
          return yield* Effect.fail(
            invalidRequest("LockdownEveryoneRoleForbidden", lockdownEveryoneRoleErrorMessage),
          );
        }
        return {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          enabled: true,
          roleId,
          monitorRoleIds: monitorRoles.map(({ roleId }) => roleId),
        };
      });

    const respond = (options: {
      readonly responseReference: ResponseReference;
      readonly message: BotOutboundMessage;
      readonly deliveryKey: typeof DeliveryKey.Type;
      readonly policy: string;
      readonly operation: string;
      readonly recoveryRequired: boolean;
      readonly rejectedMessage: string;
    }) =>
      delivery
        .get()
        .delivery.respond({
          payload: {
            responseReference: options.responseReference,
            deliveryKey: options.deliveryKey,
            message: options.message,
          },
        })
        .pipe(
          Effect.mapError(
            mapDeliveryFailure(
              options.policy,
              options.operation,
              "response",
              options.recoveryRequired,
              options.rejectedMessage,
              operationError,
            ),
          ),
        );

    return {
      loadWorkspace,
      updateWorkspace,
      setMonitorRole,
      loadConversation,
      updateConversation,
      loadLockdown,
      replaceLockdownPermissions: (state, deliveryKey, policy) =>
        delivery
          .get()
          .delivery.replaceConversationPermissionOverwrites({
            payload: {
              conversation: conversationRefFrom(client, state.workspaceId, state.conversationId),
              deliveryKey,
              permissionOverwrites: botPermissionOverwrites(state),
            },
          })
          .pipe(
            Effect.mapError(
              mapDeliveryFailure(
                policy,
                "conversations.setLockdown.permissionOverwrites",
                "conversation",
                true,
                "The lockdown permission update was rejected",
                operationError,
              ),
            ),
          ),
      deliverWorkspaceConfig: (
        responseReference,
        state,
        deliveryKey,
        policy,
        { recoveryRequired },
      ) =>
        respond({
          responseReference,
          message: workspaceConfigMessage(client, state),
          deliveryKey,
          policy,
          operation: "workspaces.config.respond",
          recoveryRequired,
          rejectedMessage: "The workspace configuration response was rejected",
        }),
      deliverMonitorRole: (input, workspaceName, deliveryKey, policy) =>
        respond({
          responseReference: input.responseReference,
          message: monitorRoleMessage(client, input, workspaceName),
          deliveryKey,
          policy,
          operation: "workspaces.setMonitorRole.respond",
          recoveryRequired: true,
          rejectedMessage: "The monitor role response was rejected",
        }),
      deliverConversationConfig: (
        responseReference,
        state,
        deliveryKey,
        policy,
        { recoveryRequired, updated },
      ) =>
        respond({
          responseReference,
          message: conversationConfigMessage(client, state, updated),
          deliveryKey,
          policy,
          operation: "conversations.config.respond",
          recoveryRequired,
          rejectedMessage: "The conversation configuration response was rejected",
        }),
      deliverLockdownResponse: (input, deliveryKey, policy) =>
        respond({
          responseReference: input.responseReference,
          message: lockdownMessage(client, input),
          deliveryKey,
          policy,
          operation: "conversations.setLockdown.respond",
          recoveryRequired: true,
          rejectedMessage: "The lockdown response was rejected",
        }),
    } satisfies ConfigurationWorkflowOperationsShape;
  }),
);
