import { Layer } from "effect";
import { actionContextSqlLayer } from "effect-zero-workflow";
import { makeRoomOrdersNavigateDefinition } from "./definition";
import { makeRoomOrdersCreateDefinition } from "./createDefinition";
import { makeRoomOrdersSendDefinition } from "./sendDefinition";
import { makeRoomOrdersPinTentativeDefinition } from "./pinTentativeDefinition";

const RoomOrdersNavigateDefinition = makeRoomOrdersNavigateDefinition();
const RoomOrdersSendDefinition = makeRoomOrdersSendDefinition();
const RoomOrdersCreateDefinition = makeRoomOrdersCreateDefinition();
const RoomOrdersPinTentativeDefinition = makeRoomOrdersPinTentativeDefinition();

const RoomOrderSheetWorkflowDefinitions = Object.freeze([
  RoomOrdersNavigateDefinition,
  RoomOrdersSendDefinition,
  RoomOrdersCreateDefinition,
  RoomOrdersPinTentativeDefinition,
] as const);

export const RoomOrderSheetWorkflows = Object.freeze(
  RoomOrderSheetWorkflowDefinitions.map(({ workflow }) => workflow),
);

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
