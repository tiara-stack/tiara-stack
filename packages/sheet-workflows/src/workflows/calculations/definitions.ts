import { Cause, Layer, Schema } from "effect";
import {
  actionContextSqlLayer,
  type WorkflowDefinition,
  type WorkflowJson,
} from "effect-zero-workflow";
import { CalculationDeclaredFailure } from "sheet-workflow-contracts";
import { makeCalculationProjectionEntityLayer } from "@/entities/calculationProjection";
import { materializeWorkflowFailure } from "../shared/failure";
import {
  makeCalculationsRecalculateSheetDefinition,
  runCalculationsRecalculateSheetSerialized,
} from "./definition";

const CalculationsRecalculateSheetDefinition = makeCalculationsRecalculateSheetDefinition();

const CalculationSheetWorkflowDefinitions = Object.freeze([
  CalculationsRecalculateSheetDefinition,
] as const);

export const CalculationSheetWorkflows = Object.freeze(
  CalculationSheetWorkflowDefinitions.map(({ workflow }) => workflow as WorkflowDefinition),
);

const workflowNames = new Set(CalculationSheetWorkflows.map(({ name }) => name));

export const isCalculationSheetWorkflowName = (workflowName: string): boolean =>
  workflowNames.has(workflowName);

const calculationProjectionEntityLayer = makeCalculationProjectionEntityLayer({
  run: ({ payload }) => runCalculationsRecalculateSheetSerialized(payload),
});

const layers = [
  Layer.empty,
  ...CalculationSheetWorkflowDefinitions.flatMap(({ actions, workflowLayer }) => [
    ...actions.map((action) => action.toLayer()),
    workflowLayer,
  ]),
  calculationProjectionEntityLayer,
] as const;

export const calculationSheetWorkflowLayers = Layer.mergeAll(...layers).pipe(
  Layer.provide(actionContextSqlLayer),
);

export const materializeCalculationWorkflowFailure = (
  _workflow: WorkflowDefinition,
  cause: Cause.Cause<unknown>,
): WorkflowJson => materializeWorkflowFailure(Schema.is(CalculationDeclaredFailure), cause);
