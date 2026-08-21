import { Layer } from "effect";
import { actionContextSqlLayer, type WorkflowDefinition } from "effect-zero-workflow";
import { makeServicesDeliverStatusDefinition } from "./definition";

const ServicesDeliverStatusDefinition = makeServicesDeliverStatusDefinition();

const ServiceSheetWorkflowDefinitions = Object.freeze([ServicesDeliverStatusDefinition] as const);

export const ServiceSheetWorkflows = Object.freeze(
  ServiceSheetWorkflowDefinitions.map(({ workflow }) => workflow as WorkflowDefinition),
);

const layerList = [
  Layer.empty,
  ...ServiceSheetWorkflowDefinitions.flatMap(({ actions, workflowLayer }) => [
    ...actions.map((action) => action.toLayer()),
    workflowLayer,
  ]),
] as const;

export const serviceSheetWorkflowLayers = Layer.mergeAll(...layerList).pipe(
  Layer.provide(actionContextSqlLayer),
);
