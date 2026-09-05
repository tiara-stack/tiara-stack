import { Data, Effect, Predicate, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { DeleteMessageReceipt, SendMessageReceipt } from "sheet-bot-api";
import { MessageSlotRow } from "sheet-zero-server/persistence";
import { AutonomousDeclaredFailure, SlotsRefreshButton } from "sheet-workflow-contracts";
import {
  decodeWorkflowContractInputOrDie,
  workflowContractExecutionSchema,
} from "../shared/execution";
import {
  authorizeAutonomousWorkflow as authorize,
  preserveAutonomousDeclaredFailure as preserveDeclaredFailure,
} from "../shared/interactive";
import { slotSheetWorkflowDefinitionVersion } from "./catalog";
import { makeSlotDeliveryKey } from "./keys";
import { loadCurrentSlotForWorkflow } from "./slotActionHelpers";
import {
  SlotBindingOutcome,
  SlotReplacementCleanupOutcome,
  SlotWorkflowOperations,
} from "./operations";

class SlotRefreshBindingFailed extends Data.TaggedError("SlotRefreshBindingFailed")<{
  readonly cause: string;
}> {}

const name = workflowContractKey(SlotsRefreshButton);
const actionName = SlotsRefreshButton.identity;
const executionSchema = workflowContractExecutionSchema(SlotsRefreshButton);
const loadedExecutionSchema = Schema.Struct({
  ...executionSchema.fields,
  currentSlot: MessageSlotRow,
});
const publishedExecutionSchema = Schema.Struct({
  ...loadedExecutionSchema.fields,
  published: SendMessageReceipt,
});

const SlotsRefreshButtonLoadAction = makeAction({
  name: `${actionName}.load-current-slot`,
  version: slotSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: executionSchema,
  success: Schema.NullOr(MessageSlotRow),
  error: AutonomousDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    loadCurrentSlotForWorkflow(
      authorize(SlotsRefreshButton, {
        principal: execution.principal,
        input: execution.input,
      }),
      decodeWorkflowContractInputOrDie(SlotsRefreshButton, execution.input),
      preserveDeclaredFailure,
    ),
});

const SlotsRefreshButtonPublishAction = makeAction({
  name: `${actionName}.publish-button`,
  version: slotSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: loadedExecutionSchema,
  success: SendMessageReceipt,
  error: AutonomousDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(
        authorize(SlotsRefreshButton, {
          principal: execution.principal,
          input: execution.input,
        }),
      );
      const operations = yield* SlotWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(SlotsRefreshButton, execution.input);
      return yield* preserveDeclaredFailure(
        operations.publishButton(
          {
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            day: execution.currentSlot.day,
          },
          makeSlotDeliveryKey(SlotsRefreshButton, execution.invocationId, "publish-button"),
          SlotsRefreshButton.authorizationPolicy.policy,
        ),
      );
    }),
});

const SlotsRefreshButtonBindAction = makeAction({
  name: `${actionName}.bind-slot-state`,
  version: slotSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: publishedExecutionSchema,
  success: SlotBindingOutcome,
  error: AutonomousDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(
        authorize(SlotsRefreshButton, {
          principal: execution.principal,
          input: execution.input,
        }),
      );
      const operations = yield* SlotWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(SlotsRefreshButton, execution.input);
      return yield* preserveDeclaredFailure(
        operations.bindSlotState(
          {
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            day: execution.currentSlot.day,
          },
          execution.published,
          execution.currentSlot.createdByUserId,
          execution.currentSlot.messageId,
        ),
      );
    }),
});

const cleanupExecutionSchema = Schema.Struct({
  ...publishedExecutionSchema.fields,
  binding: SlotBindingOutcome,
});

const SlotsRefreshButtonCleanupAction = makeAction({
  name: `${actionName}.delete-provisional-button`,
  version: slotSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: cleanupExecutionSchema,
  success: DeleteMessageReceipt,
  error: AutonomousDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(
        authorize(SlotsRefreshButton, {
          principal: execution.principal,
          input: execution.input,
        }),
      );
      const operations = yield* SlotWorkflowOperations;
      return yield* preserveDeclaredFailure(
        operations.deleteProvisionalButton(
          execution.published,
          makeSlotDeliveryKey(
            SlotsRefreshButton,
            execution.invocationId,
            "delete-provisional-button",
          ),
          SlotsRefreshButton.authorizationPolicy.policy,
        ),
      );
    }),
});

const SlotsRefreshButtonDeleteReplacedAction = makeAction({
  name: `${actionName}.delete-replaced-button`,
  version: slotSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: publishedExecutionSchema,
  success: SlotReplacementCleanupOutcome,
  error: AutonomousDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(
        authorize(SlotsRefreshButton, {
          principal: execution.principal,
          input: execution.input,
        }),
      );
      const operations = yield* SlotWorkflowOperations;
      return yield* preserveDeclaredFailure(
        operations.deleteReplacedButton(
          execution.currentSlot,
          execution.published,
          {
            current: makeSlotDeliveryKey(
              SlotsRefreshButton,
              execution.invocationId,
              "delete-replaced-button-current",
            ),
            published: makeSlotDeliveryKey(
              SlotsRefreshButton,
              execution.invocationId,
              "delete-replaced-button-published",
            ),
          },
          SlotsRefreshButton.authorizationPolicy.policy,
        ),
      );
    }),
});

const SlotsRefreshButtonWorkflow = Workflow.make({
  name,
  payload: executionSchema,
  success: SlotsRefreshButton.success,
  error: AutonomousDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

export const makeSlotsRefreshButtonWorkflowBody =
  <E, R>(actions: {
    readonly load: (
      execution: typeof executionSchema.Type,
    ) => Effect.Effect<typeof MessageSlotRow.Type | null, E, R>;
    readonly publish: (
      execution: typeof loadedExecutionSchema.Type,
    ) => Effect.Effect<typeof SendMessageReceipt.Type, E, R>;
    readonly bind: (
      execution: typeof publishedExecutionSchema.Type,
    ) => Effect.Effect<typeof SlotBindingOutcome.Type, E, R>;
    readonly cleanup: (
      execution: typeof cleanupExecutionSchema.Type,
    ) => Effect.Effect<typeof DeleteMessageReceipt.Type, E, R>;
    readonly deleteReplaced: (
      execution: typeof publishedExecutionSchema.Type,
    ) => Effect.Effect<typeof SlotReplacementCleanupOutcome.Type, E, R>;
  }) =>
  (execution: typeof executionSchema.Type) =>
    Effect.gen(function* () {
      const input = yield* decodeWorkflowContractInputOrDie(SlotsRefreshButton, execution.input);
      const currentSlot = yield* actions.load(execution);
      if (currentSlot === null) {
        return {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          status: "skipped" as const,
          messageId: null,
          day: null,
          deliveryReceipts: [],
        };
      }

      const published = yield* actions.publish({ ...execution, currentSlot });
      const publishedExecution = { ...execution, currentSlot, published };
      const binding = yield* actions.bind(publishedExecution);
      if (Predicate.isTagged("CleanupRequired")(binding)) {
        yield* actions.cleanup({ ...publishedExecution, binding });
        return yield* Effect.die(new SlotRefreshBindingFailed({ cause: binding.failure }));
      }

      const replaced = yield* actions.deleteReplaced(publishedExecution);
      if (replaced.status !== "authoritative") {
        return {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          status: "skipped" as const,
          messageId: null,
          day: null,
          deliveryReceipts: [published, ...replaced.deliveryReceipts],
        };
      }

      return {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        status: "refreshed" as const,
        messageId: published.target.message.messageId,
        day: currentSlot.day,
        deliveryReceipts: [published, ...replaced.deliveryReceipts],
      };
    });

const slotsRefreshButtonDefinition = {
  contract: SlotsRefreshButton,
  workflow: SlotsRefreshButtonWorkflow,
  actions: [
    SlotsRefreshButtonLoadAction,
    SlotsRefreshButtonPublishAction,
    SlotsRefreshButtonBindAction,
    SlotsRefreshButtonCleanupAction,
    SlotsRefreshButtonDeleteReplacedAction,
  ] as const,
  workflowLayer: SlotsRefreshButtonWorkflow.toLayer(
    makeSlotsRefreshButtonWorkflowBody({
      load: (execution) => SlotsRefreshButtonLoadAction.await(execution),
      publish: (execution) => SlotsRefreshButtonPublishAction.await(execution),
      bind: (execution) => SlotsRefreshButtonBindAction.await(execution),
      cleanup: (execution) => SlotsRefreshButtonCleanupAction.await(execution),
      deleteReplaced: (execution) => SlotsRefreshButtonDeleteReplacedAction.await(execution),
    }),
  ),
};

export const slotRefreshWorkflowDefinition = slotsRefreshButtonDefinition;
