import { Cause, Layer, Schema } from "effect";
import {
  actionContextSqlLayer,
  type WorkflowDefinition,
  type WorkflowJson,
} from "effect-zero-workflow";
import { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import { materializeWorkflowFailure } from "../shared/failure";
import { makeUserScheduleDefinition } from "./definition";

const ScheduleSheetWorkflowDefinitions = Object.freeze([makeUserScheduleDefinition()] as const);

export const ScheduleSheetWorkflows = Object.freeze(
  ScheduleSheetWorkflowDefinitions.map(({ workflow }) => workflow as WorkflowDefinition),
);

const scheduleSheetWorkflowNames = new Set(ScheduleSheetWorkflows.map(({ name }) => name));

export const isScheduleSheetWorkflowName = (workflowName: string): boolean =>
  scheduleSheetWorkflowNames.has(workflowName);

const scheduleSheetWorkflowLayerList = [
  Layer.empty,
  ...ScheduleSheetWorkflowDefinitions.flatMap(({ actions, workflowLayer }) => [
    ...actions.map((action) => action.toLayer()),
    workflowLayer,
  ]),
] as const;

export const scheduleSheetWorkflowLayers = Layer.mergeAll(...scheduleSheetWorkflowLayerList).pipe(
  Layer.provide(actionContextSqlLayer),
);

export const materializeScheduleWorkflowFailure = (
  _workflow: WorkflowDefinition,
  cause: Cause.Cause<unknown>,
): WorkflowJson => materializeWorkflowFailure(Schema.is(InteractiveDeclaredFailure), cause);
