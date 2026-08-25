import { Cause, Layer, Schema } from "effect";
import {
  actionContextSqlLayer,
  type WorkflowDefinition,
  type WorkflowJson,
} from "effect-zero-workflow";
import { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import { materializeWorkflowFailure } from "../shared/failure";
import {
  CaptureAndDeliverScreenshotAction,
  makeScreenshotsCaptureAndDeliverDefinition,
  ResolveScreenshotSourceAction,
} from "./definition";

export const ScreenshotsCaptureAndDeliverDefinition = makeScreenshotsCaptureAndDeliverDefinition();

const ScreenshotSheetWorkflowDefinitions = Object.freeze([
  ScreenshotsCaptureAndDeliverDefinition,
] as const);

export const ScreenshotSheetWorkflows = Object.freeze(
  ScreenshotSheetWorkflowDefinitions.map(({ workflow }) => workflow as WorkflowDefinition),
);

const screenshotWorkflowNames = new Set(ScreenshotSheetWorkflows.map(({ name }) => name));

export const isScreenshotSheetWorkflowName = (workflowName: string): boolean =>
  screenshotWorkflowNames.has(workflowName);

export const materializeScreenshotWorkflowFailure = (
  _workflow: WorkflowDefinition,
  cause: Cause.Cause<unknown>,
): WorkflowJson => materializeWorkflowFailure(Schema.is(InteractiveDeclaredFailure), cause);

export const screenshotOrdinaryWorkflowLayers = Layer.mergeAll(
  ResolveScreenshotSourceAction.toLayer(),
  ScreenshotsCaptureAndDeliverDefinition.workflowLayer,
).pipe(Layer.provide(actionContextSqlLayer));

export const screenshotBrowserWorkflowLayers = CaptureAndDeliverScreenshotAction.toLayer().pipe(
  Layer.provide(actionContextSqlLayer),
);
