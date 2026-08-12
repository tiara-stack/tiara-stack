import { Cause, Layer, Schema } from "effect";
import {
  actionContextSqlLayer,
  type WorkflowDefinition,
  type WorkflowJson,
} from "effect-zero-workflow";
import { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import { materializeWorkflowFailure } from "../shared/failure";
import { makeTeamsDeliverListDefinition } from "./definition";

const TeamSheetWorkflowDefinitions = Object.freeze([makeTeamsDeliverListDefinition()] as const);

export const TeamSheetWorkflows = Object.freeze(
  TeamSheetWorkflowDefinitions.map(({ workflow }) => workflow as WorkflowDefinition),
);

const teamSheetWorkflowNames = new Set(TeamSheetWorkflows.map(({ name }) => name));

export const isTeamSheetWorkflowName = (workflowName: string): boolean =>
  teamSheetWorkflowNames.has(workflowName);

const teamSheetWorkflowLayerList = [
  Layer.empty,
  ...TeamSheetWorkflowDefinitions.flatMap(({ actions, workflowLayer }) => [
    ...actions.map((action) => action.toLayer()),
    workflowLayer,
  ]),
] as const;

export const teamSheetWorkflowLayers = Layer.mergeAll(...teamSheetWorkflowLayerList).pipe(
  Layer.provide(actionContextSqlLayer),
);

export const materializeTeamWorkflowFailure = (
  _workflow: WorkflowDefinition,
  cause: Cause.Cause<unknown>,
): WorkflowJson => materializeWorkflowFailure(Schema.is(InteractiveDeclaredFailure), cause);
