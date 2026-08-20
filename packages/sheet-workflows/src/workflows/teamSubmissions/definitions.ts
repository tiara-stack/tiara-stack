import { Cause, Layer, Schema } from "effect";
import type { WorkflowDefinition, WorkflowJson } from "effect-zero-workflow";
import { actionContextSqlLayer } from "effect-zero-workflow";
import { AutonomousDeclaredFailure } from "sheet-workflow-contracts";
import { makeTeamSubmissionsEntityLayer } from "@/entities/teamSubmissions";
import { materializeWorkflowFailure } from "../shared/failure";
import {
  makeTeamSubmissionsDecideDefinition,
  makeTeamSubmissionsProcessDefinition,
} from "./definition";

const TeamSubmissionsProcessDefinition = makeTeamSubmissionsProcessDefinition();
const TeamSubmissionsDecideDefinition = makeTeamSubmissionsDecideDefinition();

export const TeamSubmissionsSheetWorkflowDefinitions = Object.freeze([
  TeamSubmissionsProcessDefinition,
  TeamSubmissionsDecideDefinition,
] as const);

export const TeamSubmissionsSheetWorkflows = Object.freeze(
  TeamSubmissionsSheetWorkflowDefinitions.map(({ workflow }) => workflow as WorkflowDefinition),
);

const teamSubmissionsWorkflowNames = new Set(TeamSubmissionsSheetWorkflows.map(({ name }) => name));

export const isTeamSubmissionsSheetWorkflowName = (workflowName: string): boolean =>
  teamSubmissionsWorkflowNames.has(workflowName);

export const teamSubmissionsSheetWorkflowLayers = Layer.mergeAll(
  TeamSubmissionsProcessDefinition.workflowLayer,
  TeamSubmissionsDecideDefinition.workflowLayer,
  makeTeamSubmissionsEntityLayer(),
).pipe(Layer.provide(actionContextSqlLayer));

export const materializeTeamSubmissionsWorkflowFailure = (
  _workflow: WorkflowDefinition,
  cause: Cause.Cause<unknown>,
): WorkflowJson => materializeWorkflowFailure(Schema.is(AutonomousDeclaredFailure), cause);
