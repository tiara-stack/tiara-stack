import { Cause, Data, Effect, Layer, Predicate, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import {
  actionContextSqlLayer,
  makeAction,
  type WorkflowDefinition,
  type WorkflowJson,
} from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { DeleteMessageReceipt, RespondReceipt, SendMessageReceipt } from "sheet-bot-api";
import { InteractiveDeclaredFailure, SlotsPublishButton } from "sheet-workflow-contracts";
import { MessageSlotRow } from "sheet-zero-server/persistence";
import {
  decodeWorkflowContractInputOrDie,
  workflowContractExecutionSchema,
} from "../shared/execution";
import { materializeWorkflowFailure } from "../shared/failure";
import {
  authorizeInteractiveWorkflow as authorize,
  preserveInteractiveDeclaredFailure as preserveDeclaredFailure,
} from "../shared/interactive";
import { slotSheetWorkflowDefinitionVersion } from "./catalog";
import { makeSlotsDeliverListDefinition } from "./slotListDefinition";
import { makeSlotsOpenDefinition } from "./slotOpenDefinition";
import { loadCurrentSlotForWorkflow } from "./slotActionHelpers";
import { makeSlotDeliveryKey } from "./keys";
import {
  SlotBindingOutcome,
  SlotReplacementCleanupOutcome,
  SlotWorkflowOperations,
} from "./operations";
import { slotRefreshWorkflowDefinition } from "./slotRefreshDefinition";
import { makeSlotRemoveWorkflowDefinition } from "./slotRemoveDefinition";

export { makeSlotDeliveryKey } from "./keys";

class SlotBindingFailed extends Data.TaggedError("SlotBindingFailed")<{
  readonly cause: string;
}> {}

const name = workflowContractKey(SlotsPublishButton);
const actionName = SlotsPublishButton.identity;
const executionSchema = workflowContractExecutionSchema(SlotsPublishButton);
const loadedExecutionSchema = Schema.Struct({
  ...executionSchema.fields,
  currentSlot: Schema.NullOr(MessageSlotRow),
});
const publishedExecutionSchema = Schema.Struct({
  ...loadedExecutionSchema.fields,
  creatorAccountId: Schema.String,
  published: SendMessageReceipt,
});
const cleanupExecutionSchema = Schema.Struct({
  ...publishedExecutionSchema.fields,
  binding: SlotBindingOutcome,
});

const SlotsPublishButtonLoadAction = makeAction({
  name: `${actionName}.load-current-slot`,
  version: slotSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: executionSchema,
  success: Schema.NullOr(MessageSlotRow),
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    loadCurrentSlotForWorkflow(
      authorize(SlotsPublishButton, execution),
      decodeWorkflowContractInputOrDie(SlotsPublishButton, execution.input),
      preserveDeclaredFailure,
    ),
});

const SlotsPublishButtonPublishAction = makeAction({
  name: `${actionName}.publish-button`,
  version: slotSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: loadedExecutionSchema,
  success: Schema.Struct({
    currentSlot: Schema.NullOr(MessageSlotRow),
    creatorAccountId: Schema.String,
    published: SendMessageReceipt,
  }),
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(SlotsPublishButton, execution));
      const operations = yield* SlotWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(SlotsPublishButton, execution.input);
      const creatorAccountId = yield* preserveDeclaredFailure(
        operations.requireCreatorAccountId(
          execution.principal,
          SlotsPublishButton.authorizationPolicy.policy,
        ),
      );
      const published = yield* preserveDeclaredFailure(
        operations.publishButton(
          input,
          makeSlotDeliveryKey(SlotsPublishButton, execution.invocationId, "publish-button"),
          SlotsPublishButton.authorizationPolicy.policy,
        ),
      );
      return { currentSlot: execution.currentSlot, creatorAccountId, published };
    }),
});

const SlotsPublishButtonBindAction = makeAction({
  name: `${actionName}.bind-slot-state`,
  version: slotSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: publishedExecutionSchema,
  success: SlotBindingOutcome,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(SlotsPublishButton, execution));
      const operations = yield* SlotWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(SlotsPublishButton, execution.input);
      return yield* preserveDeclaredFailure(
        operations.bindSlotState(
          input,
          execution.published,
          execution.creatorAccountId,
          execution.currentSlot?.messageId,
        ),
      );
    }),
});

const SlotsPublishButtonCleanupAction = makeAction({
  name: `${actionName}.delete-provisional-button`,
  version: slotSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: cleanupExecutionSchema,
  success: DeleteMessageReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(SlotsPublishButton, execution));
      const operations = yield* SlotWorkflowOperations;
      return yield* preserveDeclaredFailure(
        operations.deleteProvisionalButton(
          execution.published,
          makeSlotDeliveryKey(
            SlotsPublishButton,
            execution.invocationId,
            "delete-provisional-button",
          ),
          SlotsPublishButton.authorizationPolicy.policy,
        ),
      );
    }),
});

const SlotsPublishButtonDeleteReplacedAction = makeAction({
  name: `${actionName}.delete-replaced-button`,
  version: slotSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: publishedExecutionSchema,
  success: SlotReplacementCleanupOutcome,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(SlotsPublishButton, execution));
      const operations = yield* SlotWorkflowOperations;
      return yield* preserveDeclaredFailure(
        operations.deleteReplacedButton(
          execution.currentSlot,
          execution.published,
          {
            current: makeSlotDeliveryKey(
              SlotsPublishButton,
              execution.invocationId,
              "delete-replaced-button-current",
            ),
            published: makeSlotDeliveryKey(
              SlotsPublishButton,
              execution.invocationId,
              "delete-replaced-button-published",
            ),
          },
          SlotsPublishButton.authorizationPolicy.policy,
        ),
      );
    }),
});

const SlotsPublishButtonResponseAction = makeAction({
  name: `${actionName}.respond`,
  version: slotSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: publishedExecutionSchema,
  success: RespondReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(SlotsPublishButton, execution));
      const operations = yield* SlotWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(SlotsPublishButton, execution.input);
      return yield* preserveDeclaredFailure(
        operations.respond(
          input,
          makeSlotDeliveryKey(SlotsPublishButton, execution.invocationId, "respond"),
          SlotsPublishButton.authorizationPolicy.policy,
        ),
      );
    }),
});

const SlotsPublishButtonWorkflow = Workflow.make({
  name,
  payload: executionSchema,
  success: SlotsPublishButton.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

export const makeSlotsPublishButtonWorkflowBody =
  <E, R>(actions: {
    readonly load: (
      execution: typeof executionSchema.Type,
    ) => Effect.Effect<typeof MessageSlotRow.Type | null, E, R>;
    readonly publish: (execution: typeof loadedExecutionSchema.Type) => Effect.Effect<
      {
        readonly currentSlot: typeof MessageSlotRow.Type | null;
        readonly creatorAccountId: string;
        readonly published: typeof SendMessageReceipt.Type;
      },
      E,
      R
    >;
    readonly bind: (
      execution: typeof publishedExecutionSchema.Type,
    ) => Effect.Effect<typeof SlotBindingOutcome.Type, E, R>;
    readonly cleanup: (
      execution: typeof cleanupExecutionSchema.Type,
    ) => Effect.Effect<typeof DeleteMessageReceipt.Type, E, R>;
    readonly deleteReplaced: (
      execution: typeof publishedExecutionSchema.Type,
    ) => Effect.Effect<typeof SlotReplacementCleanupOutcome.Type, E, R>;
    readonly respond: (
      execution: typeof publishedExecutionSchema.Type,
    ) => Effect.Effect<typeof RespondReceipt.Type, E, R>;
  }) =>
  (execution: typeof executionSchema.Type) =>
    Effect.gen(function* () {
      const input = yield* decodeWorkflowContractInputOrDie(SlotsPublishButton, execution.input);
      const currentSlot = yield* actions.load(execution);
      const published = yield* actions.publish({ ...execution, currentSlot });
      const publishedExecution = {
        ...execution,
        ...published,
      };
      const binding = yield* actions.bind({
        ...publishedExecution,
      });
      if (Predicate.isTagged("CleanupRequired")(binding)) {
        yield* actions.cleanup({
          ...publishedExecution,
          binding,
        });
        return yield* Effect.die(new SlotBindingFailed({ cause: binding.failure }));
      }
      const replaced = yield* actions.deleteReplaced(publishedExecution);
      if (replaced.authoritativeMessageId === null) {
        return yield* Effect.die(
          new SlotBindingFailed({
            cause:
              replaced.status === "missing"
                ? "SlotStateMissingAfterBind"
                : "SlotStateSupersededWithoutReplacement",
          }),
        );
      }
      const response = yield* actions.respond({
        ...publishedExecution,
      });
      const publishedReceipt = published.published;
      return {
        messageId: replaced.authoritativeMessageId,
        messageConversationId: publishedReceipt.target.message.conversation.conversationId,
        day: input.day,
        deliveryReceipts: [publishedReceipt, ...replaced.deliveryReceipts, response],
      };
    });

const SlotsPublishButtonDefinition = {
  contract: SlotsPublishButton,
  workflow: SlotsPublishButtonWorkflow,
  actions: [
    SlotsPublishButtonLoadAction,
    SlotsPublishButtonPublishAction,
    SlotsPublishButtonBindAction,
    SlotsPublishButtonCleanupAction,
    SlotsPublishButtonDeleteReplacedAction,
    SlotsPublishButtonResponseAction,
  ],
  workflowLayer: SlotsPublishButtonWorkflow.toLayer(
    makeSlotsPublishButtonWorkflowBody({
      load: (execution) => SlotsPublishButtonLoadAction.await(execution),
      publish: (execution) => SlotsPublishButtonPublishAction.await(execution),
      bind: (execution) => SlotsPublishButtonBindAction.await(execution),
      cleanup: (execution) => SlotsPublishButtonCleanupAction.await(execution),
      deleteReplaced: (execution) => SlotsPublishButtonDeleteReplacedAction.await(execution),
      respond: (execution) => SlotsPublishButtonResponseAction.await(execution),
    }),
  ),
};

const SlotsDeliverListDefinition = makeSlotsDeliverListDefinition();
const SlotsOpenDefinition = makeSlotsOpenDefinition();
const slotRemoveWorkflowDefinition = makeSlotRemoveWorkflowDefinition();

export const SlotSheetWorkflowDefinitions = Object.freeze([
  SlotsPublishButtonDefinition,
  slotRefreshWorkflowDefinition,
  SlotsDeliverListDefinition,
  SlotsOpenDefinition,
  slotRemoveWorkflowDefinition,
] as const);

export const SlotSheetWorkflows = Object.freeze(
  SlotSheetWorkflowDefinitions.map(({ workflow }) => workflow),
);

const slotSheetWorkflowNames = new Set(SlotSheetWorkflows.map(({ name }) => name));

export const isSlotSheetWorkflowName = (workflowName: string): boolean =>
  slotSheetWorkflowNames.has(workflowName);

const slotSheetWorkflowLayerList = [
  Layer.empty,
  ...SlotSheetWorkflowDefinitions.flatMap(({ actions, workflowLayer }) => [
    ...actions.map((action) => action.toLayer()),
    workflowLayer,
  ]),
] as const;

export const slotSheetWorkflowLayers = Layer.mergeAll(...slotSheetWorkflowLayerList).pipe(
  Layer.provide(actionContextSqlLayer),
);

export const materializeSlotWorkflowFailure = (
  _workflow: WorkflowDefinition,
  cause: Cause.Cause<unknown>,
): WorkflowJson => materializeWorkflowFailure(Schema.is(InteractiveDeclaredFailure), cause);
