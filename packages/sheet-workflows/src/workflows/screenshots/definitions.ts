import { Layer } from "effect";
import { actionContextSqlLayer } from "effect-zero-workflow";
import {
  CaptureAndDeliverScreenshotAction,
  makeScreenshotsCaptureAndDeliverDefinition,
  ResolveScreenshotSourceAction,
} from "./definition";

export const ScreenshotsCaptureAndDeliverDefinition = makeScreenshotsCaptureAndDeliverDefinition();

export const screenshotOrdinaryWorkflowRegistrationLayers = Layer.mergeAll(
  ResolveScreenshotSourceAction.toLayer(),
  ScreenshotsCaptureAndDeliverDefinition.workflowLayer,
);

export const screenshotOrdinaryWorkflowLayers = screenshotOrdinaryWorkflowRegistrationLayers.pipe(
  Layer.provide(actionContextSqlLayer),
);

export const screenshotBrowserWorkflowRegistrationLayers = Layer.mergeAll(
  // The browser runner does not own the dispatch shard, but it still needs the
  // parent workflow definition to resolve the parent shard when a browser
  // action completes and sends its resume signal.
  ScreenshotsCaptureAndDeliverDefinition.workflowLayer,
  CaptureAndDeliverScreenshotAction.toLayer(),
);

export const screenshotBrowserWorkflowLayers = screenshotBrowserWorkflowRegistrationLayers.pipe(
  Layer.provide(actionContextSqlLayer),
);
