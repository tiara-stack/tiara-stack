import { Layer } from "effect";
import { actionContextSqlLayer } from "effect-zero-workflow";
import { makeCalculationProjectionEntityLayer } from "@/entities/calculationProjection";
import {
  makeCalculationsRecalculateSheetDefinition,
  runCalculationsRecalculateSheetSerialized,
} from "./definition";

const CalculationsRecalculateSheetDefinition = makeCalculationsRecalculateSheetDefinition();

const CalculationSheetWorkflowDefinitions = Object.freeze([
  CalculationsRecalculateSheetDefinition,
] as const);

export const CalculationSheetWorkflows = Object.freeze(
  CalculationSheetWorkflowDefinitions.map(({ workflow }) => workflow),
);

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
