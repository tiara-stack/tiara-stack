import { Effect, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { BotOutboundMessage, RespondReceipt } from "sheet-bot-api";
import { InteractiveDeclaredFailure, SlotsOpen } from "sheet-workflow-contracts";
import { AuthorizedSlotOpenContext } from "../readOnly/authorization";
import {
  decodeWorkflowContractInputOrDie,
  workflowContractExecutionSchema,
} from "../shared/execution";
import {
  authorizeSlotOpenWorkflow as authorize,
  interactiveAuthorizationRevoked,
  preserveInteractiveDeclaredFailure as preserveDeclaredFailure,
} from "../shared/interactive";
import { slotSheetWorkflowDefinitionVersion } from "./catalog";
import { makeSlotDeliveryKey } from "./keys";
import { makeSlotViewEmbeds } from "./slotListDefinition";
import { SlotView } from "./slotListSchema";
import { SlotOpenWorkflowOperations } from "./slotOpenService";

const name = workflowContractKey(SlotsOpen);
const actionName = SlotsOpen.identity;
const executionSchema = workflowContractExecutionSchema(SlotsOpen);
const SlotOpenLoadResult = Schema.Struct({
  context: AuthorizedSlotOpenContext,
  view: SlotView,
});
const responseExecutionSchema = Schema.Struct({
  ...executionSchema.fields,
  context: AuthorizedSlotOpenContext,
  message: BotOutboundMessage,
});

const sameSlotContext = Schema.toEquivalence(AuthorizedSlotOpenContext);

export const makeSlotsOpenMessage = (
  day: number,
  view: SlotView,
): Effect.Effect<typeof BotOutboundMessage.Type, InteractiveDeclaredFailure> =>
  makeSlotViewEmbeds(day, view, "slots.open.loadSlotView").pipe(
    Effect.map((embeds) => ({ embeds, visibility: "ephemeral" as const })),
  );

export const executeSlotsOpenLoadAction = (execution: typeof executionSchema.Type) =>
  Effect.gen(function* () {
    const context = yield* preserveDeclaredFailure(authorize(execution));
    const operations = yield* SlotOpenWorkflowOperations;
    const view = yield* preserveDeclaredFailure(operations.loadSlotView(context));
    return { context, view };
  });

export const executeSlotsOpenRespondAction = (execution: typeof responseExecutionSchema.Type) =>
  Effect.gen(function* () {
    const context = yield* preserveDeclaredFailure(authorize(execution));
    if (!sameSlotContext(context, execution.context)) {
      return yield* Effect.fail(
        interactiveAuthorizationRevoked(SlotsOpen.authorizationPolicy.policy),
      );
    }
    const operations = yield* SlotOpenWorkflowOperations;
    const input = yield* decodeWorkflowContractInputOrDie(SlotsOpen, execution.input);
    return yield* preserveDeclaredFailure(
      operations.respond(
        input,
        execution.message,
        makeSlotDeliveryKey(SlotsOpen, execution.invocationId, "respond"),
        SlotsOpen.authorizationPolicy.policy,
      ),
    );
  });

const SlotsOpenLoadAction = makeAction({
  name: `${actionName}.load-slot-view`,
  version: slotSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: executionSchema,
  success: SlotOpenLoadResult,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeSlotsOpenLoadAction,
});

const SlotsOpenRespondAction = makeAction({
  name: `${actionName}.respond`,
  version: slotSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: responseExecutionSchema,
  success: RespondReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeSlotsOpenRespondAction,
});

const SlotsOpenWorkflow = Workflow.make({
  name,
  payload: executionSchema,
  success: SlotsOpen.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

export const makeSlotsOpenWorkflowBody = <E, R>(actions: {
  readonly load: (
    execution: typeof executionSchema.Type,
  ) => Effect.Effect<typeof SlotOpenLoadResult.Type, E, R>;
  readonly respond: (
    execution: typeof responseExecutionSchema.Type,
  ) => Effect.Effect<typeof RespondReceipt.Type, E, R>;
}) =>
  Effect.fnUntraced(function* (execution: typeof executionSchema.Type) {
    yield* decodeWorkflowContractInputOrDie(SlotsOpen, execution.input);
    const { context, view } = yield* actions.load(execution);
    const message = yield* makeSlotsOpenMessage(context.day, view);
    const receipt = yield* actions.respond({ ...execution, context, message });
    return {
      messageId: context.messageId,
      workspaceId: context.workspaceId,
      day: context.day,
      deliveryReceipts: [receipt],
    };
  });

export const makeSlotsOpenDefinition = () => ({
  contract: SlotsOpen,
  workflow: SlotsOpenWorkflow,
  actions: [SlotsOpenLoadAction, SlotsOpenRespondAction],
  workflowLayer: SlotsOpenWorkflow.toLayer(
    makeSlotsOpenWorkflowBody({
      load: (execution) => SlotsOpenLoadAction.await(execution),
      respond: (execution) => SlotsOpenRespondAction.await(execution),
    }),
  ),
});
