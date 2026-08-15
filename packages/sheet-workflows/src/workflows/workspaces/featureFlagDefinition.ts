import { Effect, Predicate, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { BotOutboundMessage, ConversationRef, RespondReceipt } from "sheet-bot-api";
import { escapeInlineCode, makeEmbed } from "sheet-message-content/rendering";
import {
  InteractiveDeclaredFailure,
  WorkspacesFeatureFlagsSetAndDeliver,
} from "sheet-workflow-contracts";
import { config } from "@/config";
import { WorkspaceFeatureFlagEntity } from "@/entities/workspaceFeatureFlag";
import { decodeWorkflowContractInputOrDie } from "../shared/execution";
import {
  authorizeInteractiveWorkflow as authorize,
  preserveInteractiveDeclaredFailure as preserveDeclaredFailure,
} from "../shared/interactive";
import { workspaceSheetWorkflowDefinitionVersion } from "./catalog";
import {
  OptionalWorkspaceFeatureFlagAnnouncementReceipt,
  OptionalWorkspaceFeatureFlagConversation,
  WorkspaceFeatureFlagExecution,
  WorkspaceFeatureFlagState,
} from "./featureFlagSchema";
import { WorkspaceFeatureFlagWorkflowOperations } from "./featureFlagService";
import {
  makeWorkspaceFeatureFlagDeliveryKey,
  makeWorkspaceFeatureFlagSerializationKey,
} from "./keys";

const name = workflowContractKey(WorkspacesFeatureFlagsSetAndDeliver);
const actionName = WorkspacesFeatureFlagsSetAndDeliver.identity;
const executionSchema = WorkspaceFeatureFlagExecution;
const stateExecutionSchema = Schema.Struct({
  ...executionSchema.fields,
  state: WorkspaceFeatureFlagState,
});
const responseExecutionSchema = Schema.Struct({
  ...stateExecutionSchema.fields,
  message: BotOutboundMessage,
});
const announcementExecutionSchema = Schema.Struct({
  ...responseExecutionSchema.fields,
  conversation: ConversationRef,
});

export const makeWorkspaceFeatureFlagMessage = (
  flagName: string,
  enabled: boolean,
): typeof BotOutboundMessage.Type => ({
  embeds: [
    makeEmbed({
      title: enabled ? "Feature flag enabled" : "Feature flag disabled",
      description: enabled
        ? `This server has been enlisted for \`${escapeInlineCode(flagName)}\`.`
        : `This server has been delisted from \`${escapeInlineCode(flagName)}\`.`,
      color: enabled ? 0x57f287 : 0xed4245,
    }),
  ],
  allowedMentions: "none",
});

export const executeSetWorkspaceFeatureFlagAction = (execution: typeof executionSchema.Type) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(WorkspacesFeatureFlagsSetAndDeliver, execution));
    const operations = yield* WorkspaceFeatureFlagWorkflowOperations;
    const input = yield* decodeWorkflowContractInputOrDie(
      WorkspacesFeatureFlagsSetAndDeliver,
      execution.input,
    );
    return yield* preserveDeclaredFailure(operations.setDesiredState(input));
  });

export const executeSelectFeatureFlagAnnouncementConversationAction = (
  execution: typeof stateExecutionSchema.Type,
) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(WorkspacesFeatureFlagsSetAndDeliver, execution));
    const operations = yield* WorkspaceFeatureFlagWorkflowOperations;
    const input = yield* decodeWorkflowContractInputOrDie(
      WorkspacesFeatureFlagsSetAndDeliver,
      execution.input,
    );
    return yield* preserveDeclaredFailure(
      operations.selectAnnouncementConversation(
        input,
        execution.state,
        WorkspacesFeatureFlagsSetAndDeliver.authorizationPolicy.policy,
      ),
    );
  });

export const executeDeliverFeatureFlagResponseAction = (
  execution: typeof responseExecutionSchema.Type,
) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(WorkspacesFeatureFlagsSetAndDeliver, execution));
    const operations = yield* WorkspaceFeatureFlagWorkflowOperations;
    const input = yield* decodeWorkflowContractInputOrDie(
      WorkspacesFeatureFlagsSetAndDeliver,
      execution.input,
    );
    return yield* preserveDeclaredFailure(
      operations.respond(
        input,
        execution.state,
        execution.message,
        makeWorkspaceFeatureFlagDeliveryKey(
          execution.invocationId,
          "deliver-feature-flag-response",
        ),
        WorkspacesFeatureFlagsSetAndDeliver.authorizationPolicy.policy,
      ),
    );
  });

export const executeDeliverFeatureFlagAnnouncementAction = (
  execution: typeof announcementExecutionSchema.Type,
) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(WorkspacesFeatureFlagsSetAndDeliver, execution));
    const operations = yield* WorkspaceFeatureFlagWorkflowOperations;
    const input = yield* decodeWorkflowContractInputOrDie(
      WorkspacesFeatureFlagsSetAndDeliver,
      execution.input,
    );
    return yield* preserveDeclaredFailure(
      operations.announce(
        input,
        execution.state,
        execution.conversation,
        execution.message,
        makeWorkspaceFeatureFlagDeliveryKey(
          execution.invocationId,
          "deliver-feature-flag-announcement",
        ),
        WorkspacesFeatureFlagsSetAndDeliver.authorizationPolicy.policy,
      ),
    );
  });

export const SetWorkspaceFeatureFlagAction = makeAction({
  name: `${actionName}.set-workspace-feature-flag`,
  version: workspaceSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: executionSchema,
  success: WorkspaceFeatureFlagState,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeSetWorkspaceFeatureFlagAction,
});

const SelectFeatureFlagAnnouncementConversationAction = makeAction({
  name: `${actionName}.select-feature-flag-announcement-conversation`,
  version: workspaceSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: stateExecutionSchema,
  success: OptionalWorkspaceFeatureFlagConversation,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeSelectFeatureFlagAnnouncementConversationAction,
});

const DeliverFeatureFlagResponseAction = makeAction({
  name: `${actionName}.deliver-feature-flag-response`,
  version: workspaceSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: responseExecutionSchema,
  success: RespondReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeDeliverFeatureFlagResponseAction,
});

const DeliverFeatureFlagAnnouncementAction = makeAction({
  name: `${actionName}.deliver-feature-flag-announcement`,
  version: workspaceSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: announcementExecutionSchema,
  success: OptionalWorkspaceFeatureFlagAnnouncementReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeDeliverFeatureFlagAnnouncementAction,
});

const WorkspacesFeatureFlagsSetAndDeliverWorkflow = Workflow.make({
  name,
  payload: executionSchema,
  success: WorkspacesFeatureFlagsSetAndDeliver.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

const setThroughEntity = (execution: typeof executionSchema.Type) =>
  Effect.gen(function* () {
    const input = yield* decodeWorkflowContractInputOrDie(
      WorkspacesFeatureFlagsSetAndDeliver,
      execution.input,
    );
    const clientId = yield* config.sheetBotClientId;
    const clientFor = yield* WorkspaceFeatureFlagEntity.client;
    return yield* clientFor(
      makeWorkspaceFeatureFlagSerializationKey(clientId, input.workspaceId, input.flagName),
    ).set(execution);
  }).pipe(preserveDeclaredFailure);

type FeatureFlagActions<E, RSet, RSelect, RRespond, RAnnounce> = {
  readonly set: (
    execution: typeof executionSchema.Type,
  ) => Effect.Effect<typeof WorkspaceFeatureFlagState.Type, E, RSet>;
  readonly select: (
    execution: typeof stateExecutionSchema.Type,
  ) => Effect.Effect<typeof OptionalWorkspaceFeatureFlagConversation.Type, E, RSelect>;
  readonly respond: (
    execution: typeof responseExecutionSchema.Type,
  ) => Effect.Effect<typeof RespondReceipt.Type, E, RRespond>;
  readonly announce: (
    execution: typeof announcementExecutionSchema.Type,
  ) => Effect.Effect<typeof OptionalWorkspaceFeatureFlagAnnouncementReceipt.Type, E, RAnnounce>;
};

export const makeWorkspacesFeatureFlagsSetAndDeliverWorkflowBody = <
  E,
  RSet,
  RSelect,
  RRespond,
  RAnnounce,
>(
  actions: FeatureFlagActions<E, RSet, RSelect, RRespond, RAnnounce>,
) =>
  Effect.fnUntraced(function* (execution: typeof executionSchema.Type) {
    const input = yield* decodeWorkflowContractInputOrDie(
      WorkspacesFeatureFlagsSetAndDeliver,
      execution.input,
    );
    const state = yield* actions.set(execution);
    const message = makeWorkspaceFeatureFlagMessage(state.flagName, state.enabled);
    if (Predicate.isNotUndefined(input.responseReference)) {
      const receipt = yield* actions.respond({ ...execution, state, message });
      return {
        workspaceId: state.workspaceId,
        flagName: state.flagName,
        enabled: state.enabled,
        announcementConversationId: null,
        announcementMessageId: null,
        deliveryReceipts: [receipt],
      };
    }
    const conversation = yield* actions.select({ ...execution, state });
    if (Predicate.isNull(conversation)) {
      return {
        workspaceId: state.workspaceId,
        flagName: state.flagName,
        enabled: state.enabled,
        announcementConversationId: null,
        announcementMessageId: null,
        deliveryReceipts: [],
      };
    }
    const receipt = yield* actions.announce({ ...execution, state, message, conversation });
    return Predicate.isNull(receipt)
      ? {
          workspaceId: state.workspaceId,
          flagName: state.flagName,
          enabled: state.enabled,
          announcementConversationId: null,
          announcementMessageId: null,
          deliveryReceipts: [],
        }
      : {
          workspaceId: state.workspaceId,
          flagName: state.flagName,
          enabled: state.enabled,
          announcementConversationId: receipt.target.message.conversation.conversationId,
          announcementMessageId: receipt.target.message.messageId,
          deliveryReceipts: [receipt],
        };
  });

export const makeWorkspacesFeatureFlagsSetAndDeliverDefinition = () => ({
  contract: WorkspacesFeatureFlagsSetAndDeliver,
  workflow: WorkspacesFeatureFlagsSetAndDeliverWorkflow,
  actions: [
    SetWorkspaceFeatureFlagAction,
    SelectFeatureFlagAnnouncementConversationAction,
    DeliverFeatureFlagResponseAction,
    DeliverFeatureFlagAnnouncementAction,
  ] as const,
  workflowLayer: WorkspacesFeatureFlagsSetAndDeliverWorkflow.toLayer(
    makeWorkspacesFeatureFlagsSetAndDeliverWorkflowBody({
      set: setThroughEntity,
      select: (execution) => SelectFeatureFlagAnnouncementConversationAction.await(execution),
      respond: (execution) => DeliverFeatureFlagResponseAction.await(execution),
      announce: (execution) => DeliverFeatureFlagAnnouncementAction.await(execution),
    }),
  ),
});
