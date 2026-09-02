import { Layer } from "effect";
import { actionContextSqlLayer } from "effect-zero-workflow";
import { makeTeamSubmissionsEntityLayer } from "@/entities/teamSubmissions";
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
  TeamSubmissionsSheetWorkflowDefinitions.map(({ workflow }) => workflow),
);

export const teamSubmissionsSheetWorkflowLayers = Layer.mergeAll(
  TeamSubmissionsProcessDefinition.workflowLayer,
  TeamSubmissionsDecideDefinition.workflowLayer,
  makeTeamSubmissionsEntityLayer(),
).pipe(Layer.provide(actionContextSqlLayer));
