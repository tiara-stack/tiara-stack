import { Layer } from "effect";
import { actionContextSqlLayer } from "effect-zero-workflow";
import { makeRoomOrdersNavigateDefinition } from "./definition";
import { makeRoomOrdersSendDefinition } from "./sendDefinition";

const RoomOrdersNavigateDefinition = makeRoomOrdersNavigateDefinition();
const RoomOrdersSendDefinition = makeRoomOrdersSendDefinition();

const RoomOrderSheetWorkflowDefinitions = Object.freeze([
  RoomOrdersNavigateDefinition,
  RoomOrdersSendDefinition,
] as const);

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
