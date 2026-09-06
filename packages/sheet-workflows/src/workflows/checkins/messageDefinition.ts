import { Effect, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import {
  CheckinMessagesLoad,
  CheckinMessagesSave,
  CheckinMessagesDeclaredFailure,
  InteractiveDeclaredFailure,
} from "sheet-workflow-contracts";
import { CheckinMessagesWorkflowOperations } from "./messageService";
import { checkinSheetWorkflowDefinitionVersion } from "./catalog";
import { workflowContractExecutionSchema } from "../shared/execution";
import { authorizeInteractiveWorkflow } from "../shared/interactive";

const loadName = workflowContractKey(CheckinMessagesLoad);
const saveName = workflowContractKey(CheckinMessagesSave);
const loadExecutionSchema = workflowContractExecutionSchema(CheckinMessagesLoad);
const saveExecutionSchema = workflowContractExecutionSchema(CheckinMessagesSave);

const preserveDeclaredFailure = <A, R>(
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, typeof CheckinMessagesDeclaredFailure.Type, R> =>
  effect.pipe(
    Effect.catch((error) =>
      Schema.is(CheckinMessagesDeclaredFailure)(error) ? Effect.fail(error) : Effect.die(error),
    ),
  );

const authorize = (
  contract: typeof CheckinMessagesLoad | typeof CheckinMessagesSave,
  execution: {
    readonly principal: (typeof loadExecutionSchema.Type)["principal"];
    readonly input: unknown;
  },
) =>
  authorizeInteractiveWorkflow(contract, execution).pipe(
    Effect.mapError((error) =>
      Schema.is(InteractiveDeclaredFailure)(error)
        ? error
        : {
            _tag: "ExternalOperationRejected" as const,
            operation: `${contract.identity}.authorize`,
            code: "AuthorizationUnavailable",
            message: "The workflow authorization dependency was unavailable",
          },
    ),
  );

const executeLoad = (execution: typeof loadExecutionSchema.Type) =>
  Effect.gen(function* () {
    const input = yield* Effect.orDie(
      Schema.decodeUnknownEffect(CheckinMessagesLoad.input)(execution.input),
    );
    yield* preserveDeclaredFailure(authorize(CheckinMessagesLoad, execution));
    const operations = yield* CheckinMessagesWorkflowOperations;
    return yield* preserveDeclaredFailure(operations.load(input, execution.principal));
  });

const executeSave = (execution: typeof saveExecutionSchema.Type) =>
  Effect.gen(function* () {
    const input = yield* Effect.orDie(
      Schema.decodeUnknownEffect(CheckinMessagesSave.input)(execution.input),
    );
    yield* preserveDeclaredFailure(authorize(CheckinMessagesSave, execution));
    const operations = yield* CheckinMessagesWorkflowOperations;
    return yield* preserveDeclaredFailure(
      operations.save(input, execution.invocationId, execution.principal),
    );
  });

const CheckinMessagesLoadAction = makeAction({
  name: `${loadName}.read`,
  version: checkinSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: loadExecutionSchema,
  success: CheckinMessagesLoad.success,
  error: CheckinMessagesDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeLoad,
});

const CheckinMessagesSaveAction = makeAction({
  name: `${saveName}.save`,
  version: checkinSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: saveExecutionSchema,
  success: CheckinMessagesSave.success,
  error: CheckinMessagesDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeSave,
});

const CheckinMessagesLoadWorkflow = Workflow.make({
  name: loadName,
  payload: loadExecutionSchema,
  success: CheckinMessagesLoad.success,
  error: CheckinMessagesDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

const CheckinMessagesSaveWorkflow = Workflow.make({
  name: saveName,
  payload: saveExecutionSchema,
  success: CheckinMessagesSave.success,
  error: CheckinMessagesDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

export const makeCheckinMessagesDefinitions = () => ({
  load: {
    contract: CheckinMessagesLoad,
    workflow: CheckinMessagesLoadWorkflow,
    actions: [CheckinMessagesLoadAction] as const,
    workflowLayer: CheckinMessagesLoadWorkflow.toLayer((execution) =>
      CheckinMessagesLoadAction.await(execution),
    ),
  },
  save: {
    contract: CheckinMessagesSave,
    workflow: CheckinMessagesSaveWorkflow,
    actions: [CheckinMessagesSaveAction] as const,
    workflowLayer: CheckinMessagesSaveWorkflow.toLayer((execution) =>
      CheckinMessagesSaveAction.await(execution),
    ),
  },
});
