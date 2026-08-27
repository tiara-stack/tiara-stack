import { Layer } from "effect";
import { actionContextSqlLayer } from "effect-zero-workflow";
import { makeServicesDeliverStatusDefinition } from "./definition";

const ServicesDeliverStatusDefinition = makeServicesDeliverStatusDefinition();

const ServiceSheetWorkflowDefinitions = Object.freeze([ServicesDeliverStatusDefinition] as const);

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
