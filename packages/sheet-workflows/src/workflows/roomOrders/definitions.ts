import { Layer } from "effect";
import { actionContextSqlLayer } from "effect-zero-workflow";
import { makeRoomOrdersNavigateDefinition } from "./definition";

const RoomOrdersNavigateDefinition = makeRoomOrdersNavigateDefinition();

const RoomOrderSheetWorkflowDefinitions = Object.freeze([RoomOrdersNavigateDefinition] as const);

const layerList = [
  Layer.empty,
  ...RoomOrderSheetWorkflowDefinitions.flatMap(({ actions, workflowLayer }) => [
    ...actions.map((action) => action.toLayer()),
    workflowLayer,
  ]),
] as const;

export const roomOrderSheetWorkflowLayers = Layer.mergeAll(...layerList).pipe(
  Layer.provide(actionContextSqlLayer),
);
