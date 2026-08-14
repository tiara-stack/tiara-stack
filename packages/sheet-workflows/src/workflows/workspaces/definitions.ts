import { Layer } from "effect";
import { actionContextSqlLayer } from "effect-zero-workflow";
import { makeWorkspacesDeliverWelcomeDefinition } from "./definition";

const WorkspacesDeliverWelcomeDefinition = makeWorkspacesDeliverWelcomeDefinition();

const WorkspaceSheetWorkflowDefinitions = Object.freeze([
  WorkspacesDeliverWelcomeDefinition,
] as const);

const layerList = [
  Layer.empty,
  ...WorkspaceSheetWorkflowDefinitions.flatMap(({ actions, workflowLayer }) => [
    ...actions.map((action) => action.toLayer()),
    workflowLayer,
  ]),
] as const;

export const workspaceSheetWorkflowLayers = Layer.mergeAll(...layerList).pipe(
  Layer.provide(actionContextSqlLayer),
);
