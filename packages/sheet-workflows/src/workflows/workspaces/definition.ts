import { Effect, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { BotOutboundMessage, ConversationRef, SendMessageReceipt } from "sheet-bot-api";
import { welcomeEmbed } from "sheet-message-content/rendering";
import { AutonomousDeclaredFailure, WorkspacesDeliverWelcome } from "sheet-workflow-contracts";
import { workflowContractExecutionSchema } from "../shared/execution";
import {
  authorizeInteractiveWorkflow as authorize,
  preserveInteractiveDeclaredFailure as preserveDeclaredFailure,
} from "../shared/interactive";
import { workspaceSheetWorkflowDefinitionVersion } from "./catalog";
import { makeWorkspaceWelcomeDeliveryKey } from "./keys";
import { WorkspaceWelcomeWorkflowOperations } from "./service";

const name = workflowContractKey(WorkspacesDeliverWelcome);
const actionName = WorkspacesDeliverWelcome.identity;
const executionSchema = workflowContractExecutionSchema(WorkspacesDeliverWelcome);
const deliveryExecutionSchema = Schema.Struct({
  ...executionSchema.fields,
  conversation: ConversationRef,
  message: BotOutboundMessage,
});

const decodeInput = (input: unknown) =>
  Schema.is(WorkspacesDeliverWelcome.input)(input)
    ? Effect.succeed(input)
    : Schema.decodeUnknownEffect(WorkspacesDeliverWelcome.input)(input).pipe(Effect.orDie);

export const makeWorkspaceWelcomeMessage = (): typeof BotOutboundMessage.Type => ({
  embeds: [welcomeEmbed()],
  allowedMentions: "none",
});

export const executeSelectWelcomeConversationAction = (execution: typeof executionSchema.Type) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(WorkspacesDeliverWelcome, execution));
    const operations = yield* WorkspaceWelcomeWorkflowOperations;
    const input = yield* decodeInput(execution.input);
    return yield* preserveDeclaredFailure(
      operations.selectConversation(input, WorkspacesDeliverWelcome.authorizationPolicy.policy),
    );
  });

export const executeDeliverWorkspaceWelcomeAction = (
  execution: typeof deliveryExecutionSchema.Type,
) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(WorkspacesDeliverWelcome, execution));
    const operations = yield* WorkspaceWelcomeWorkflowOperations;
    const input = yield* decodeInput(execution.input);
    return yield* preserveDeclaredFailure(
      operations.deliverWelcome(
        input,
        execution.conversation,
        execution.message,
        makeWorkspaceWelcomeDeliveryKey(execution.invocationId),
        WorkspacesDeliverWelcome.authorizationPolicy.policy,
      ),
    );
  });

const SelectWelcomeConversationAction = makeAction({
  name: `${actionName}.select-welcome-conversation`,
  version: workspaceSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: executionSchema,
  success: ConversationRef,
  error: AutonomousDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeSelectWelcomeConversationAction,
});

const DeliverWorkspaceWelcomeAction = makeAction({
  name: `${actionName}.deliver-workspace-welcome`,
  version: workspaceSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: deliveryExecutionSchema,
  success: SendMessageReceipt,
  error: AutonomousDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeDeliverWorkspaceWelcomeAction,
});

const WorkspacesDeliverWelcomeWorkflow = Workflow.make({
  name,
  payload: executionSchema,
  success: WorkspacesDeliverWelcome.success,
  error: AutonomousDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

export const makeWorkspacesDeliverWelcomeWorkflowBody = <E, R>(actions: {
  readonly select: (
    execution: typeof executionSchema.Type,
  ) => Effect.Effect<typeof ConversationRef.Type, E, R>;
  readonly deliver: (
    execution: typeof deliveryExecutionSchema.Type,
  ) => Effect.Effect<typeof SendMessageReceipt.Type, E, R>;
}) =>
  Effect.fnUntraced(function* (execution: typeof executionSchema.Type) {
    const input = yield* decodeInput(execution.input);
    const conversation = yield* actions.select(execution);
    const receipt = yield* actions.deliver({
      ...execution,
      conversation,
      message: makeWorkspaceWelcomeMessage(),
    });
    return {
      workspaceId: input.workspaceId,
      conversationId: conversation.conversationId,
      messageId: receipt.target.message.messageId,
      deliveryReceipts: [receipt],
    };
  });

export const makeWorkspacesDeliverWelcomeDefinition = () => ({
  contract: WorkspacesDeliverWelcome,
  workflow: WorkspacesDeliverWelcomeWorkflow,
  actions: [SelectWelcomeConversationAction, DeliverWorkspaceWelcomeAction] as const,
  workflowLayer: WorkspacesDeliverWelcomeWorkflow.toLayer(
    makeWorkspacesDeliverWelcomeWorkflowBody({
      select: (execution) => SelectWelcomeConversationAction.await(execution),
      deliver: (execution) => DeliverWorkspaceWelcomeAction.await(execution),
    }),
  ),
});
