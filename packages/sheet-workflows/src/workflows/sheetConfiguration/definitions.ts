import { Effect, Layer, Option, Predicate, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { actionContextSqlLayer, makeAction } from "effect-zero-workflow";
import {
  workflowContractKey,
  type AnyWorkflowContract,
  type WorkflowContractInput,
} from "effect-zero-workflow/contract";
import {
  InteractiveDeclaredFailure,
  SheetConfigurationActivate,
  SheetConfigurationDiscardDraft,
  SheetConfigurationEditDraft,
  SheetConfigurationImportLegacy,
  SheetConfigurationRollback,
  SheetConfigurationSaveDraft,
  SheetConfigurationSaveRevision,
  WorkspaceId,
} from "sheet-workflow-contracts";
import {
  authorizeInteractiveWorkflow as authorize,
  preserveInteractiveDeclaredFailure as preserveDeclaredFailure,
} from "../shared/interactive";
import {
  decodeWorkflowContractInputOrDie,
  workflowContractExecutionSchema,
} from "../shared/execution";
import { sheetConfigurationWorkflowDefinitionVersion } from "./catalog";
import {
  SheetConfigurationWorkflowOperations,
  type Attribution,
  type SheetConfigurationWorkflowOperationsShape,
} from "./operations";

type LifecycleExecution<Contract extends AnyWorkflowContract> = {
  readonly invocationId: string;
  readonly input: WorkflowContractInput<Contract>;
  readonly principal: Attribution["principal"];
  readonly actorProvenance?: Attribution["actorProvenance"];
};

const attributionFor = <Contract extends AnyWorkflowContract>(
  execution: LifecycleExecution<Contract>,
) => ({
  invocationId: execution.invocationId,
  principal: execution.principal,
  actorProvenance: execution.actorProvenance,
});

const workspaceIdForAudit = (input: unknown): typeof WorkspaceId.Type | undefined => {
  if (!Predicate.isObject(input) || !Predicate.hasProperty(input, "workspaceId")) return undefined;
  return Option.getOrUndefined(Schema.decodeUnknownOption(WorkspaceId)(input.workspaceId));
};

const makeDefinition = <Contract extends AnyWorkflowContract>(
  contract: Contract,
  run: (
    operations: SheetConfigurationWorkflowOperationsShape,
    input: WorkflowContractInput<Contract>,
    attribution: Attribution,
  ) => Effect.Effect<Contract["success"]["Type"], unknown>,
) => {
  const name = workflowContractKey(contract);
  const payload = workflowContractExecutionSchema(contract);
  const action = makeAction({
    name: `${name}.execute`,
    version: sheetConfigurationWorkflowDefinitionVersion,
    shardGroup: "dispatch",
    input: payload,
    success: contract.success,
    error: InteractiveDeclaredFailure,
    idempotencyKey: ({ invocationId }) => invocationId,
    execute: (execution) =>
      Effect.gen(function* () {
        const operations = yield* SheetConfigurationWorkflowOperations;
        const input = yield* decodeWorkflowContractInputOrDie(contract, execution.input);
        const attribution = attributionFor(execution as LifecycleExecution<Contract>);
        const workspaceId = workspaceIdForAudit(input);
        const auditFailure = (error: unknown) =>
          workspaceId === undefined
            ? Effect.void
            : operations.recordFailureAudit({
                workspaceId,
                operation: name,
                attribution,
                error,
              });
        yield* preserveDeclaredFailure(
          authorize(contract, execution).pipe(Effect.tapError(auditFailure)),
        );
        return yield* preserveDeclaredFailure(
          run(operations, input, attribution).pipe(Effect.tapError(auditFailure)),
        );
      }),
  });
  const workflow = Workflow.make({
    name,
    payload,
    success: contract.success,
    error: InteractiveDeclaredFailure,
    idempotencyKey: ({ invocationId }) => invocationId,
  }).annotate(ClusterSchema.ShardGroup, () => "dispatch");
  return {
    contract,
    workflow,
    actions: [action] as const,
    workflowLayer: workflow.toLayer((execution) => action.await(execution)),
  };
};

const ImportLegacyDefinition = makeDefinition(
  SheetConfigurationImportLegacy,
  (operations, input, attribution) => operations.importLegacy(input, attribution),
);

const SaveDraftDefinition = makeDefinition(
  SheetConfigurationSaveDraft,
  (operations, input, attribution) => operations.saveDraft(input, attribution),
);

const EditDraftDefinition = makeDefinition(
  SheetConfigurationEditDraft,
  (operations, input, attribution) => operations.editDraft(input, attribution),
);

const SaveRevisionDefinition = makeDefinition(
  SheetConfigurationSaveRevision,
  (operations, input, attribution) => operations.saveRevision(input, attribution),
);

const ActivateDefinition = makeDefinition(
  SheetConfigurationActivate,
  (operations, input, attribution) => operations.activate(input, attribution),
);

const RollbackDefinition = makeDefinition(
  SheetConfigurationRollback,
  (operations, input, attribution) => operations.rollback(input, attribution),
);

const DiscardDraftDefinition = makeDefinition(
  SheetConfigurationDiscardDraft,
  (operations, input, attribution) => operations.discardDraft(input, attribution),
);

const SheetConfigurationWorkflowDefinitions = Object.freeze([
  ImportLegacyDefinition,
  SaveDraftDefinition,
  EditDraftDefinition,
  SaveRevisionDefinition,
  ActivateDefinition,
  RollbackDefinition,
  DiscardDraftDefinition,
]);

export const SheetConfigurationWorkflows = Object.freeze(
  SheetConfigurationWorkflowDefinitions.map(({ workflow }) => workflow),
);

const workflowLayers = SheetConfigurationWorkflowDefinitions.flatMap(
  ({ actions, workflowLayer }) => [...actions.map((action) => action.toLayer()), workflowLayer],
);

export const sheetConfigurationWorkflowLayers = Layer.mergeAll(Layer.empty, ...workflowLayers).pipe(
  Layer.provide(actionContextSqlLayer),
);
