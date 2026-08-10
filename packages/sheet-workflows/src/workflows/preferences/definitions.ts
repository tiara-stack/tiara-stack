import { Cause, Effect, Layer, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import {
  actionContextSqlLayer,
  makeAction,
  type WorkflowDefinition,
  type WorkflowJson,
} from "effect-zero-workflow";
import { InvocationId, workflowContractKey } from "effect-zero-workflow/contract";
import type { AnyWorkflowContract } from "effect-zero-workflow/contract";
import { DeliveryKey, DeliveryReceipt } from "sheet-bot-api";
import {
  InteractiveDeclaredFailure,
  PreferencesDeliverStatus,
  PreferencesUpdateAndDeliver,
} from "sheet-workflow-contracts";
import {
  decodeWorkflowContractInputOrDie,
  workflowContractExecutionSchema,
} from "../shared/execution";
import { materializeWorkflowFailure } from "../shared/failure";
import {
  authorizeInteractiveWorkflow as authorize,
  preserveInteractiveDeclaredFailure as preserveDeclaredFailure,
} from "../shared/interactive";
import { preferencesSheetWorkflowDefinitionVersion } from "./catalog";
import {
  PreferenceState,
  PreferencesWorkflowOperations,
  preferenceStatusHeadline,
} from "./operations";

export const makePreferencesDeliveryKey = (
  contract: AnyWorkflowContract,
  invocationId: typeof InvocationId.Type,
): typeof DeliveryKey.Type =>
  Schema.decodeUnknownSync(DeliveryKey)(
    `${workflowContractKey(contract)}:${preferencesSheetWorkflowDefinitionVersion}:${invocationId}:response`,
  );

const deliverStatusName = workflowContractKey(PreferencesDeliverStatus);
const deliverStatusExecution = workflowContractExecutionSchema(PreferencesDeliverStatus);
const deliverStatusDeliveryExecution = Schema.Struct({
  ...deliverStatusExecution.fields,
  state: PreferenceState,
});

const PreferencesDeliverStatusReadAction = makeAction({
  name: `${deliverStatusName}.read`,
  version: preferencesSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: deliverStatusExecution,
  success: PreferenceState,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(PreferencesDeliverStatus, execution));
      const operations = yield* PreferencesWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(
        PreferencesDeliverStatus,
        execution.input,
      );
      return yield* preserveDeclaredFailure(
        operations.load(
          execution.principal,
          input.platform ?? "discord",
          PreferencesDeliverStatus.authorizationPolicy.policy,
        ),
      );
    }),
});

const PreferencesDeliverStatusDeliveryAction = makeAction({
  name: `${deliverStatusName}.deliver`,
  version: preferencesSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: deliverStatusDeliveryExecution,
  success: DeliveryReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(PreferencesDeliverStatus, execution));
      const operations = yield* PreferencesWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(
        PreferencesDeliverStatus,
        execution.input,
      );
      return yield* preserveDeclaredFailure(
        operations.deliver(
          input,
          execution.state,
          makePreferencesDeliveryKey(PreferencesDeliverStatus, execution.invocationId),
          preferenceStatusHeadline(input.kind, execution.state),
          PreferencesDeliverStatus.authorizationPolicy.policy,
          { recoveryRequired: false },
        ),
      );
    }),
});

const PreferencesDeliverStatusWorkflow = Workflow.make({
  name: deliverStatusName,
  payload: deliverStatusExecution,
  success: PreferencesDeliverStatus.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

const PreferencesDeliverStatusDefinition = {
  contract: PreferencesDeliverStatus,
  workflow: PreferencesDeliverStatusWorkflow,
  actions: [PreferencesDeliverStatusReadAction, PreferencesDeliverStatusDeliveryAction],
  workflowLayer: PreferencesDeliverStatusWorkflow.toLayer((execution) =>
    Effect.gen(function* () {
      const state = yield* PreferencesDeliverStatusReadAction.await(execution);
      const receipt = yield* PreferencesDeliverStatusDeliveryAction.await({ ...execution, state });
      return { ...state, deliveryReceipts: [receipt] };
    }),
  ),
};

const updateAndDeliverName = workflowContractKey(PreferencesUpdateAndDeliver);
const updateAndDeliverExecution = workflowContractExecutionSchema(PreferencesUpdateAndDeliver);
const updateAndDeliverMutationExecution = Schema.Struct({
  ...updateAndDeliverExecution.fields,
  current: PreferenceState,
});
const updateAndDeliverDeliveryExecution = Schema.Struct({
  ...updateAndDeliverExecution.fields,
  state: PreferenceState,
});

const PreferencesUpdateAndDeliverReadAction = makeAction({
  name: `${updateAndDeliverName}.read`,
  version: preferencesSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: updateAndDeliverExecution,
  success: PreferenceState,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(PreferencesUpdateAndDeliver, execution));
      const operations = yield* PreferencesWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(
        PreferencesUpdateAndDeliver,
        execution.input,
      );
      return yield* preserveDeclaredFailure(
        operations.load(
          execution.principal,
          input.platform,
          PreferencesUpdateAndDeliver.authorizationPolicy.policy,
        ),
      );
    }),
});

const PreferencesUpdateAndDeliverMutationAction = makeAction({
  name: `${updateAndDeliverName}.update`,
  version: preferencesSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: updateAndDeliverMutationExecution,
  success: PreferenceState,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(PreferencesUpdateAndDeliver, execution));
      const operations = yield* PreferencesWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(
        PreferencesUpdateAndDeliver,
        execution.input,
      );
      return yield* preserveDeclaredFailure(
        operations.update(
          execution.principal,
          input,
          execution.current,
          PreferencesUpdateAndDeliver.authorizationPolicy.policy,
        ),
      );
    }),
});

const PreferencesUpdateAndDeliverDeliveryAction = makeAction({
  name: `${updateAndDeliverName}.deliver`,
  version: preferencesSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: updateAndDeliverDeliveryExecution,
  success: DeliveryReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(PreferencesUpdateAndDeliver, execution));
      const operations = yield* PreferencesWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(
        PreferencesUpdateAndDeliver,
        execution.input,
      );
      return yield* preserveDeclaredFailure(
        operations.deliver(
          input,
          execution.state,
          makePreferencesDeliveryKey(PreferencesUpdateAndDeliver, execution.invocationId),
          "Notification preferences updated.",
          PreferencesUpdateAndDeliver.authorizationPolicy.policy,
          { recoveryRequired: true },
        ),
      );
    }),
});

const PreferencesUpdateAndDeliverWorkflow = Workflow.make({
  name: updateAndDeliverName,
  payload: updateAndDeliverExecution,
  success: PreferencesUpdateAndDeliver.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

const PreferencesUpdateAndDeliverDefinition = {
  contract: PreferencesUpdateAndDeliver,
  workflow: PreferencesUpdateAndDeliverWorkflow,
  actions: [
    PreferencesUpdateAndDeliverReadAction,
    PreferencesUpdateAndDeliverMutationAction,
    PreferencesUpdateAndDeliverDeliveryAction,
  ],
  workflowLayer: PreferencesUpdateAndDeliverWorkflow.toLayer((execution) =>
    Effect.gen(function* () {
      const current = yield* PreferencesUpdateAndDeliverReadAction.await(execution);
      const state = yield* PreferencesUpdateAndDeliverMutationAction.await({
        ...execution,
        current,
      });
      const receipt = yield* PreferencesUpdateAndDeliverDeliveryAction.await({
        ...execution,
        state,
      });
      return { ...state, deliveryReceipts: [receipt] };
    }),
  ),
};

export const PreferencesSheetWorkflowDefinitions = Object.freeze([
  PreferencesDeliverStatusDefinition,
  PreferencesUpdateAndDeliverDefinition,
]);

export const PreferencesSheetWorkflows = Object.freeze(
  PreferencesSheetWorkflowDefinitions.map(({ workflow }) => workflow as WorkflowDefinition),
);

const preferencesSheetWorkflowNames = new Set(PreferencesSheetWorkflows.map(({ name }) => name));

export const isPreferencesSheetWorkflowName = (name: string): boolean =>
  preferencesSheetWorkflowNames.has(name);

const preferencesSheetWorkflowLayerList = [
  Layer.empty,
  ...PreferencesSheetWorkflowDefinitions.flatMap(({ actions, workflowLayer }) => [
    ...actions.map((action) => action.toLayer()),
    workflowLayer,
  ]),
] as const;

export const preferencesSheetWorkflowLayers = Layer.mergeAll(
  ...preferencesSheetWorkflowLayerList,
).pipe(Layer.provide(actionContextSqlLayer));

export const materializePreferencesWorkflowFailure = (
  _workflow: WorkflowDefinition,
  cause: Cause.Cause<unknown>,
): WorkflowJson => materializeWorkflowFailure(Schema.is(InteractiveDeclaredFailure), cause);
