import { Effect, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { DeleteMessageReceipt, RespondReceipt } from "sheet-bot-api";
import { InteractiveDeclaredFailure, SlotsRemoveButton } from "sheet-workflow-contracts";
import { MessageSlotRow } from "sheet-zero-server/persistence";
import {
  decodeWorkflowContractInputOrDie,
  workflowContractExecutionSchema,
} from "../shared/execution";
import {
  authorizeInteractiveWorkflow as authorize,
  preserveInteractiveDeclaredFailure as preserveDeclaredFailure,
} from "../shared/interactive";
import { slotSheetWorkflowDefinitionVersion } from "./catalog";
import { makeSlotDeliveryKey } from "./keys";
import { loadCurrentSlotForWorkflow } from "./slotActionHelpers";
import { SlotWorkflowOperations } from "./operations";

const name = workflowContractKey(SlotsRemoveButton);
const actionName = SlotsRemoveButton.identity;
const executionSchema = workflowContractExecutionSchema(SlotsRemoveButton);
const loadedExecutionSchema = Schema.Struct({
  ...executionSchema.fields,
  currentSlot: MessageSlotRow,
});
const responseExecutionSchema = Schema.Struct({
  ...executionSchema.fields,
  status: Schema.Literals(["removed", "skipped"]),
  messageId: Schema.NullOr(Schema.String),
});

const SlotsRemoveButtonLoadAction = makeAction({
  name: `${actionName}.load-current-slot`,
  version: slotSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: executionSchema,
  success: Schema.NullOr(MessageSlotRow),
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    loadCurrentSlotForWorkflow(
      authorize(SlotsRemoveButton, execution),
      decodeWorkflowContractInputOrDie(SlotsRemoveButton, execution.input),
      preserveDeclaredFailure,
    ),
});

const SlotsRemoveButtonDeleteAction = makeAction({
  name: `${actionName}.delete-button`,
  version: slotSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: loadedExecutionSchema,
  success: DeleteMessageReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(SlotsRemoveButton, execution));
      const operations = yield* SlotWorkflowOperations;
      return yield* preserveDeclaredFailure(
        operations.removeButton(
          execution.currentSlot,
          makeSlotDeliveryKey(SlotsRemoveButton, execution.invocationId, "remove-button"),
          SlotsRemoveButton.authorizationPolicy.policy,
        ),
      );
    }),
});

const SlotsRemoveButtonResponseAction = makeAction({
  name: `${actionName}.respond`,
  version: slotSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: responseExecutionSchema,
  success: RespondReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(SlotsRemoveButton, execution));
      const operations = yield* SlotWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(SlotsRemoveButton, execution.input);
      return yield* preserveDeclaredFailure(
        operations.respondRemoval(
          input,
          execution.status === "removed",
          makeSlotDeliveryKey(SlotsRemoveButton, execution.invocationId, "respond"),
          SlotsRemoveButton.authorizationPolicy.policy,
        ),
      );
    }),
});

const SlotsRemoveButtonWorkflow = Workflow.make({
  name,
  payload: executionSchema,
  success: SlotsRemoveButton.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

export const makeSlotsRemoveButtonWorkflowBody =
  <E, R>(actions: {
    readonly load: (
      execution: typeof executionSchema.Type,
    ) => Effect.Effect<typeof MessageSlotRow.Type | null, E, R>;
    readonly remove: (
      execution: typeof loadedExecutionSchema.Type,
    ) => Effect.Effect<typeof DeleteMessageReceipt.Type, E, R>;
    readonly respond: (
      execution: typeof responseExecutionSchema.Type,
    ) => Effect.Effect<typeof RespondReceipt.Type, E, R>;
  }) =>
  (execution: typeof executionSchema.Type) =>
    Effect.gen(function* () {
      const input = yield* decodeWorkflowContractInputOrDie(SlotsRemoveButton, execution.input);
      const currentSlot = yield* actions.load(execution);
      const status = currentSlot === null ? ("skipped" as const) : ("removed" as const);
      const removal =
        currentSlot === null ? null : yield* actions.remove({ ...execution, currentSlot });
      const response = yield* actions.respond({
        ...execution,
        status,
        messageId: currentSlot?.messageId ?? null,
      });

      return {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        status,
        messageId: currentSlot?.messageId ?? null,
        deliveryReceipts: removal === null ? [response] : [removal, response],
      };
    });

export const makeSlotRemoveWorkflowDefinition = () => ({
  contract: SlotsRemoveButton,
  workflow: SlotsRemoveButtonWorkflow,
  actions: [
    SlotsRemoveButtonLoadAction,
    SlotsRemoveButtonDeleteAction,
    SlotsRemoveButtonResponseAction,
  ] as const,
  workflowLayer: SlotsRemoveButtonWorkflow.toLayer(
    makeSlotsRemoveButtonWorkflowBody({
      load: (execution) => SlotsRemoveButtonLoadAction.await(execution),
      remove: (execution) => SlotsRemoveButtonDeleteAction.await(execution),
      respond: (execution) => SlotsRemoveButtonResponseAction.await(execution),
    }),
  ),
});
