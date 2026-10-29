import { Effect } from "effect";
import { workflowPreviewRuntimeContractCatalogIdentity } from "./workflow-runtime-contract-catalog";
import type {
  IncompatibleWorkflowRecreationRuntimeApi,
  WorkflowExecutionArtifacts,
  WorkflowExecutionCessationEvidence,
  WorkflowExecutionEvidenceBinding,
  WorkflowOldWorkDrainEvidence,
  WorkflowOldWorkSettlementEvidence,
  WorkflowPreviewDefinition,
  WorkflowProducerFenceEvidence,
} from "./owned-workflow-execution";

export const producerFenceEvidence = (
  binding: WorkflowExecutionEvidenceBinding,
): WorkflowProducerFenceEvidence => ({
  binding,
  submissionConnectionsFenced: true,
  autonomousTriggersFenced: true,
  unknownProducerOwnership: false,
});

export const drainedOldWork = (
  binding: WorkflowExecutionEvidenceBinding,
  drain: WorkflowOldWorkDrainEvidence["drain"] = "completed",
): WorkflowOldWorkDrainEvidence => ({ binding, drain });

const settledOldWorkFacts: Omit<WorkflowOldWorkSettlementEvidence, "binding"> = {
  disposition: "settled",
  drain: "completed",
  cancellation: "not-required",
  reconciliation: "not-required",
};

export const settledOldWork = (
  binding: WorkflowExecutionEvidenceBinding,
  facts: Omit<WorkflowOldWorkSettlementEvidence, "binding"> = settledOldWorkFacts,
): WorkflowOldWorkSettlementEvidence => ({ ...facts, binding });

export const ambiguousOldWork = (
  binding: WorkflowExecutionEvidenceBinding,
): WorkflowOldWorkSettlementEvidence => ({
  disposition: "ambiguous",
  drain: "completed",
  cancellation: "ambiguous",
  reconciliation: "not-required",
  binding,
});

export const cessationEvidence = (
  binding: WorkflowExecutionEvidenceBinding,
  overrides: Partial<Omit<WorkflowExecutionCessationEvidence, "binding">> = {},
): WorkflowExecutionCessationEvidence => ({
  binding,
  providerOperationsTerminal: true,
  apiFenced: true,
  runnerPodsTerminated: true,
  staleRunnersTerminated: true,
  reclaimedCommandLeasesReconciled: true,
  hostDependenciesAccountedFor: true,
  activeExternalCallsTerminated: true,
  acceptedWorkSettled: true,
  unknownOwnership: false,
  ...overrides,
});

export type OldWorkSettlementInput = Parameters<
  IncompatibleWorkflowRecreationRuntimeApi["settleWithOldCode"]
>[0];
export type OldProducerFenceInput = Parameters<
  IncompatibleWorkflowRecreationRuntimeApi["fenceProducers"]
>[0];
export type OldWorkDrainInput = Parameters<
  IncompatibleWorkflowRecreationRuntimeApi["drainOldWork"]
>[0];
export type OldWorkCessationInput = Parameters<
  IncompatibleWorkflowRecreationRuntimeApi["proveOldCessation"]
>[0];

export const boundOldWork: IncompatibleWorkflowRecreationRuntimeApi["settleWithOldCode"] = ({
  expectedBinding,
}: OldWorkSettlementInput) => Effect.succeed(settledOldWork(expectedBinding));

export const boundOldCessation: IncompatibleWorkflowRecreationRuntimeApi["proveOldCessation"] = ({
  expectedBinding,
}: OldWorkCessationInput) => Effect.succeed(cessationEvidence(expectedBinding));

export const workflowDefinition = (
  sourceRevision: string,
  artifacts: WorkflowExecutionArtifacts,
  requiredGroups: ReadonlyArray<string>,
  workloadRoles: ReadonlyArray<string> = ["workflow_api", "ordinary_runner"],
): WorkflowPreviewDefinition => ({
  sourceRevision,
  artifacts,
  requiredGroups,
  workloadRoles,
  compatibility: {
    catalogVersion: 1,
    catalogDigest: workflowPreviewRuntimeContractCatalogIdentity.digest,
    declarations: workloadRoles.map((role) => {
      const connectedRoleByWorkflowRole: Readonly<Record<string, string>> = {
        workflow_api: "sheet-workflows-api",
        ordinary_runner: "sheet-workflows-runner",
        browser_runner: "sheet-workflows-browser-runner",
      };
      const artifactDigestByWorkflowRole: Readonly<Record<string, string>> = {
        workflow_api: artifacts.api,
        ordinary_runner: artifacts.runnerArtifacts?.ordinary_runner ?? artifacts.runner,
        browser_runner: artifacts.runnerArtifacts?.browser_runner ?? artifacts.runner,
      };
      const connectedRole = connectedRoleByWorkflowRole[role];
      const artifactDigest = artifactDigestByWorkflowRole[role];
      if (connectedRole === undefined || artifactDigest === undefined)
        throw new Error(`Unsupported test workflow role ${role}`);
      return {
        role: connectedRole,
        contract:
          role === "workflow_api" && workloadRoles.length === 1
            ? "workflow.enqueue"
            : "workflow.execution",
        classification: "compatible",
        sourceRevision,
        artifactDigest,
        deployedManifestDigest: artifacts.deployment,
        catalogVersion: 1,
      };
    }),
  },
});
