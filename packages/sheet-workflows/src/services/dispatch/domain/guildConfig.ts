import { Effect, Option } from "effect";
import type {
  ConversationListConfigDispatchPayload,
  ConversationListConfigDispatchResult,
  ConversationSetDispatchPayload,
  ConversationSetDispatchResult,
  ConversationUnsetDispatchPayload,
  ConversationUnsetDispatchResult,
  WorkspaceAddMonitorRoleDispatchPayload,
  WorkspaceAddMonitorRoleDispatchResult,
  WorkspaceListConfigDispatchPayload,
  WorkspaceListConfigDispatchResult,
  WorkspaceRemoveMonitorRoleDispatchPayload,
  WorkspaceRemoveMonitorRoleDispatchResult,
  WorkspaceSetAutoCheckinDispatchPayload,
  WorkspaceSetAutoCheckinDispatchResult,
  WorkspaceSetSheetDispatchPayload,
  WorkspaceSetSheetDispatchResult,
} from "sheet-ingress-api/sheet-apis-rpc";
import { makeArgumentError } from "typhoon-core/error";
import { ClientDeliveryClient } from "../../clientDeliveryClient";
import * as MessageText from "sheet-message-content/text";
import { makeSheetApisServices } from "../clients/sheetApis";
import { requireSome } from "../pure/option";
import { resolveWorkspaceDisplayName } from "../clients/workspace";
import {
  conversationMentionValue,
  escapeMarkdown,
  formatConversationConfigFields,
  makeEmbed,
  roleMentionValue,
} from "sheet-message-content/rendering";
import { isAutoCheckinEnabled } from "../pure/workflowPolicy";

type WorkspaceConfigService = ReturnType<typeof makeSheetApisServices>["workspaceConfigService"];

export const makeGuildConfigOperations = ({
  botClient,
  workspaceConfigService,
}: {
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly workspaceConfigService: WorkspaceConfigService;
}) => {
  type ConversationPayload =
    | ConversationListConfigDispatchPayload
    | ConversationSetDispatchPayload
    | ConversationUnsetDispatchPayload;
  type ConversationConfig = Effect.Success<
    ReturnType<WorkspaceConfigService["upsertWorkspaceConversationConfig"]>
  >;
  type MonitorRolePayload = WorkspaceAddMonitorRoleDispatchPayload;

  const conversationResult = (payload: ConversationPayload) => ({
    workspaceId: payload.workspaceId,
    conversationId: payload.conversationId,
  });
  const respondConversationConfig = (
    payload: ConversationPayload,
    config: ConversationConfig,
    title: Parameters<typeof makeEmbed>[0]["title"],
    description?: Parameters<typeof makeEmbed>[0]["description"],
  ) =>
    botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
      embeds: [
        makeEmbed({
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description }),
          fields: formatConversationConfigFields({
            client: payload.client,
            workspaceId: payload.workspaceId,
            name: config.name,
            running: config.running,
            roleId: config.roleId,
            checkinConversationId: config.checkinConversationId,
          }),
        }),
      ],
    });
  const respondMonitorRoleChange = (
    payload: MonitorRolePayload,
    workspaceDisplayName: Effect.Success<ReturnType<typeof resolveWorkspaceDisplayName>>,
    relation: "is now a" | "is no longer a",
  ) =>
    botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
      embeds: [
        makeEmbed({
          title: "Success!",
          description: [
            ...roleMentionValue(payload.client, payload.workspaceId, payload.roleId),
            MessageText.text(` ${relation} `),
            MessageText.clientTerm("monitorRole"),
            MessageText.text(" for "),
            ...workspaceDisplayName,
          ],
        }),
      ],
    });
  const requireConversationMutation = <T extends Readonly<Record<string, unknown>>>(
    operation: "set" | "unset",
    mutation: T,
  ) =>
    Object.keys(mutation).length === 0
      ? Effect.fail(makeArgumentError(`Cannot ${operation} conversation config without changes`))
      : Effect.succeed(mutation);
  const updateConversationConfig = Effect.fn("DispatchService.updateConversationConfig")(function* (
    payload: ConversationPayload,
    mutation: Readonly<Record<string, unknown>>,
  ) {
    const config = yield* workspaceConfigService.upsertWorkspaceConversationConfig(
      payload.workspaceId,
      payload.conversationId,
      mutation,
    );
    yield* respondConversationConfig(payload, config, "Success!", [
      ...conversationMentionValue(payload.client, payload.workspaceId, payload.conversationId),
      MessageText.text(" configuration updated"),
    ]);
    return conversationResult(payload);
  });

  return {
    conversationListConfig: Effect.fn("DispatchService.conversationListConfig")(function* (
      payload: ConversationListConfigDispatchPayload,
    ) {
      yield* Effect.annotateCurrentSpan({
        workspaceId: payload.workspaceId,
        conversationId: payload.conversationId,
      });
      const maybeConfig = yield* workspaceConfigService.getWorkspaceConversationById({
        workspaceId: payload.workspaceId,
        conversationId: payload.conversationId,
      });
      const config = yield* requireSome(maybeConfig, () =>
        Effect.fail(
          makeArgumentError(
            `Cannot list conversation config, conversation ${payload.conversationId} is not configured`,
          ),
        ),
      );

      yield* respondConversationConfig(payload, config, [
        MessageText.text("Config for this "),
        MessageText.clientTerm("conversation"),
      ]);

      return conversationResult(payload) satisfies ConversationListConfigDispatchResult;
    }),
    conversationSet: Effect.fn("DispatchService.conversationSet")(function* (
      payload: ConversationSetDispatchPayload,
    ) {
      yield* Effect.annotateCurrentSpan({
        workspaceId: payload.workspaceId,
        conversationId: payload.conversationId,
      });
      const mutation = yield* requireConversationMutation("set", {
        ...(payload.running === undefined ? {} : { running: payload.running }),
        ...(payload.name === undefined ? {} : { name: payload.name }),
        ...(payload.roleId === undefined ? {} : { roleId: payload.roleId }),
        ...(payload.checkinConversationId === undefined
          ? {}
          : { checkinConversationId: payload.checkinConversationId }),
      });
      return (yield* updateConversationConfig(
        payload,
        mutation,
      )) satisfies ConversationSetDispatchResult;
    }),
    conversationUnset: Effect.fn("DispatchService.conversationUnset")(function* (
      payload: ConversationUnsetDispatchPayload,
    ) {
      yield* Effect.annotateCurrentSpan({
        workspaceId: payload.workspaceId,
        conversationId: payload.conversationId,
      });
      const existingConfig = yield* workspaceConfigService.getWorkspaceConversationById({
        workspaceId: payload.workspaceId,
        conversationId: payload.conversationId,
      });
      yield* requireSome(existingConfig, () =>
        Effect.fail(
          makeArgumentError(
            `Cannot unset conversation config, conversation ${payload.conversationId} is not configured`,
          ),
        ),
      );
      const mutation = yield* requireConversationMutation("unset", {
        ...(payload.running ? { running: null } : {}),
        ...(payload.name ? { name: null } : {}),
        ...(payload.role ? { roleId: null } : {}),
        ...(payload.checkinConversation ? { checkinConversationId: null } : {}),
      });
      return (yield* updateConversationConfig(
        payload,
        mutation,
      )) satisfies ConversationUnsetDispatchResult;
    }),
    workspaceListConfig: Effect.fn("DispatchService.workspaceListConfig")(function* (
      payload: WorkspaceListConfigDispatchPayload,
    ) {
      yield* Effect.annotateCurrentSpan({ workspaceId: payload.workspaceId });
      const [workspaceDisplayName, maybeWorkspaceConfig, monitorRoles] = yield* Effect.all(
        [
          resolveWorkspaceDisplayName(botClient, payload.workspaceId),
          workspaceConfigService.getWorkspaceConfig(payload.workspaceId),
          workspaceConfigService.getWorkspaceMonitorRoles(payload.workspaceId),
        ],
        { concurrency: 3 },
      );
      const workspaceConfig = yield* requireSome(maybeWorkspaceConfig, () =>
        Effect.fail(makeArgumentError(`Cannot list config for workspace ${payload.workspaceId}`)),
      );
      const sheetId = Option.match(workspaceConfig.sheetId, {
        onSome: escapeMarkdown,
        onNone: () => "None",
      });

      yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
        embeds: [
          makeEmbed({
            title: [MessageText.text("Config for "), ...workspaceDisplayName],
            description: MessageText.lines(
              [MessageText.text(`Sheet id: ${sheetId}`)],
              [
                MessageText.text(
                  `Auto check-in: ${
                    isAutoCheckinEnabled(workspaceConfig.autoCheckin) ? "Enabled" : "Disabled"
                  }`,
                ),
              ],
              [
                MessageText.clientTerm("monitorRole", {
                  form: "plural",
                  casing: "sentence",
                }),
                MessageText.text(": "),
                ...(monitorRoles.length > 0
                  ? MessageText.joinText(
                      monitorRoles.map((role) =>
                        roleMentionValue(payload.client, payload.workspaceId, role.roleId),
                      ),
                      ", ",
                    )
                  : [MessageText.text("None")]),
              ],
            ),
          }),
        ],
      });

      return {
        workspaceId: payload.workspaceId,
        monitorRoleCount: monitorRoles.length,
      } satisfies WorkspaceListConfigDispatchResult;
    }),
    workspaceAddMonitorRole: Effect.fn("DispatchService.workspaceAddMonitorRole")(function* (
      payload: WorkspaceAddMonitorRoleDispatchPayload,
    ) {
      yield* Effect.annotateCurrentSpan({
        workspaceId: payload.workspaceId,
        roleId: payload.roleId,
      });
      const workspaceDisplayName = yield* resolveWorkspaceDisplayName(
        botClient,
        payload.workspaceId,
      );
      yield* workspaceConfigService.addWorkspaceMonitorRole(payload.workspaceId, payload.roleId);
      yield* respondMonitorRoleChange(payload, workspaceDisplayName, "is now a");
      return {
        workspaceId: payload.workspaceId,
        roleId: payload.roleId,
      } satisfies WorkspaceAddMonitorRoleDispatchResult;
    }),
    workspaceRemoveMonitorRole: Effect.fn("DispatchService.workspaceRemoveMonitorRole")(function* (
      payload: WorkspaceRemoveMonitorRoleDispatchPayload,
    ) {
      yield* Effect.annotateCurrentSpan({
        workspaceId: payload.workspaceId,
        roleId: payload.roleId,
      });
      const workspaceDisplayName = yield* resolveWorkspaceDisplayName(
        botClient,
        payload.workspaceId,
      );
      yield* workspaceConfigService.removeWorkspaceMonitorRole(payload.workspaceId, payload.roleId);
      yield* respondMonitorRoleChange(payload, workspaceDisplayName, "is no longer a");
      return {
        workspaceId: payload.workspaceId,
        roleId: payload.roleId,
      } satisfies WorkspaceRemoveMonitorRoleDispatchResult;
    }),
    workspaceSetSheet: Effect.fn("DispatchService.workspaceSetSheet")(function* (
      payload: WorkspaceSetSheetDispatchPayload,
    ) {
      yield* Effect.annotateCurrentSpan({ workspaceId: payload.workspaceId });
      const workspaceDisplayName = yield* resolveWorkspaceDisplayName(
        botClient,
        payload.workspaceId,
      );
      yield* workspaceConfigService.upsertWorkspaceConfig(payload.workspaceId, {
        sheetId: payload.sheetId,
      });
      yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
        embeds: [
          makeEmbed({
            title: "Success!",
            description: [
              MessageText.text("Sheet id for "),
              ...workspaceDisplayName,
              MessageText.text(` is now set to ${escapeMarkdown(payload.sheetId)}`),
            ],
          }),
        ],
      });
      return {
        workspaceId: payload.workspaceId,
        sheetId: payload.sheetId,
      } satisfies WorkspaceSetSheetDispatchResult;
    }),
    workspaceSetAutoCheckin: Effect.fn("DispatchService.workspaceSetAutoCheckin")(function* (
      payload: WorkspaceSetAutoCheckinDispatchPayload,
    ) {
      yield* Effect.annotateCurrentSpan({ workspaceId: payload.workspaceId });
      const workspaceDisplayName = yield* resolveWorkspaceDisplayName(
        botClient,
        payload.workspaceId,
      );
      const workspaceConfig = yield* workspaceConfigService.upsertWorkspaceConfig(
        payload.workspaceId,
        {
          autoCheckin: payload.autoCheckin,
        },
      );
      const autoCheckin = isAutoCheckinEnabled(workspaceConfig.autoCheckin);
      yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
        embeds: [
          makeEmbed({
            title: "Success!",
            description: [
              MessageText.text("Auto check-in for "),
              ...workspaceDisplayName,
              MessageText.text(` is now ${autoCheckin ? "enabled" : "disabled"}.`),
            ],
          }),
        ],
      });
      return {
        workspaceId: payload.workspaceId,
        autoCheckin,
      } satisfies WorkspaceSetAutoCheckinDispatchResult;
    }),
  };
};
