import { Layer } from "effect";
import { actionContextSqlLayer } from "effect-zero-workflow";
import { makeWorkspaceFeatureFlagEntityLayer } from "@/entities/workspaceFeatureFlag";
import { makeWorkspacesDeliverWelcomeDefinition } from "./definition";
import {
  makeWorkspacesFeatureFlagsSetAndDeliverDefinition,
  SetWorkspaceFeatureFlagAction,
} from "./featureFlagDefinition";

const WorkspacesDeliverWelcomeDefinition = makeWorkspacesDeliverWelcomeDefinition();
const WorkspacesFeatureFlagsSetAndDeliverDefinition =
  makeWorkspacesFeatureFlagsSetAndDeliverDefinition();

const WorkspaceSheetWorkflowDefinitions = Object.freeze([
  WorkspacesDeliverWelcomeDefinition,
  WorkspacesFeatureFlagsSetAndDeliverDefinition,
] as const);

export const WorkspaceSheetWorkflows = Object.freeze(
  WorkspaceSheetWorkflowDefinitions.map(({ workflow }) => workflow),
);

const workspaceFeatureFlagEntityLayer = makeWorkspaceFeatureFlagEntityLayer({
  set: ({ payload }) => SetWorkspaceFeatureFlagAction.await(payload),
});

const layerList = [
  Layer.empty,
  ...WorkspaceSheetWorkflowDefinitions.flatMap(({ actions, workflowLayer }) => [
    ...actions.map((action) => action.toLayer()),
    workflowLayer,
  ]),
  workspaceFeatureFlagEntityLayer,
] as const;

export const workspaceSheetWorkflowLayers = Layer.mergeAll(...layerList).pipe(
  Layer.provide(actionContextSqlLayer),
);
