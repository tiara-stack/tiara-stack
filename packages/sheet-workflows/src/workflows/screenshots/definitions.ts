import { Layer } from "effect";
import { actionContextSqlLayer } from "effect-zero-workflow";
import {
  CaptureAndDeliverScreenshotAction,
  makeScreenshotsCaptureAndDeliverDefinition,
  ResolveScreenshotSourceAction,
} from "./definition";

const screenshotsCaptureAndDeliverDefinition = makeScreenshotsCaptureAndDeliverDefinition();

export const screenshotOrdinaryWorkflowLayers = Layer.mergeAll(
  ResolveScreenshotSourceAction.toLayer(),
  screenshotsCaptureAndDeliverDefinition.workflowLayer,
).pipe(Layer.provide(actionContextSqlLayer));

export const screenshotBrowserWorkflowLayers = CaptureAndDeliverScreenshotAction.toLayer().pipe(
  Layer.provide(actionContextSqlLayer),
);
