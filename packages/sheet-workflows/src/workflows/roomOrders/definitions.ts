import { Layer } from "effect";
import { actionContextSqlLayer } from "effect-zero-workflow";
import { makeRoomOrdersNavigateDefinition } from "./definition";
import { makeRoomOrdersCreateDefinition } from "./createDefinition";
import { makeRoomOrdersSendDefinition } from "./sendDefinition";

const RoomOrdersNavigateDefinition = makeRoomOrdersNavigateDefinition();
const RoomOrdersSendDefinition = makeRoomOrdersSendDefinition();
const RoomOrdersCreateDefinition = makeRoomOrdersCreateDefinition();

const RoomOrderSheetWorkflowDefinitions = Object.freeze([
  RoomOrdersNavigateDefinition,
  RoomOrdersSendDefinition,
  RoomOrdersCreateDefinition,
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
