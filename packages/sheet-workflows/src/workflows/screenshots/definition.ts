import { Effect } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { InteractiveDeclaredFailure, ScreenshotsCaptureAndDeliver } from "sheet-workflow-contracts";
import { preserveInteractiveDeclaredFailure as preserveDeclaredFailure } from "../shared/interactive";
import { decodeWorkflowContractInputOrDie } from "../shared/execution";
import { screenshotActionVersion } from "./catalog";
import { makeScreenshotActionKey } from "./keys";
import { ScreenshotCaptureExecution, ScreenshotCaptureResult, ScreenshotExecution } from "./schema";
import { ScreenshotCaptureOperations, ScreenshotSourceOperations } from "./service";

const name = workflowContractKey(ScreenshotsCaptureAndDeliver);
const actionName = ScreenshotsCaptureAndDeliver.identity;

export const screenshotShardGroups = Object.freeze({
  workflow: "dispatch",
  source: "dispatch",
  browser: "browser",
} as const);

const executeResolveScreenshotSourceAction = (execution: typeof ScreenshotExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* ScreenshotSourceOperations;
    return yield* preserveDeclaredFailure(operations.resolve(execution));
  });

const executeCaptureAndDeliverScreenshotAction = (
  execution: typeof ScreenshotCaptureExecution.Type,
) =>
  Effect.gen(function* () {
    const operations = yield* ScreenshotCaptureOperations;
    return yield* preserveDeclaredFailure(operations.captureAndDeliver(execution));
  });

export const ResolveScreenshotSourceAction = makeAction({
  name: `${actionName}.resolve-screenshot-source`,
  version: screenshotActionVersion,
  shardGroup: screenshotShardGroups.source,
  input: ScreenshotExecution,
  success: ScreenshotCaptureExecution.fields.target,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeScreenshotActionKey(invocationId, "resolve-screenshot-source"),
  execute: executeResolveScreenshotSourceAction,
});

export const CaptureAndDeliverScreenshotAction = makeAction({
  name: `${actionName}.capture-and-deliver-screenshot`,
  version: screenshotActionVersion,
  shardGroup: screenshotShardGroups.browser,
  input: ScreenshotCaptureExecution,
  success: ScreenshotCaptureResult,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeScreenshotActionKey(invocationId, "capture-and-deliver-screenshot"),
  execute: executeCaptureAndDeliverScreenshotAction,
});

const ScreenshotsCaptureAndDeliverWorkflow = Workflow.make({
  name,
  payload: ScreenshotExecution,
  success: ScreenshotsCaptureAndDeliver.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => screenshotShardGroups.workflow);

export const makeScreenshotsCaptureAndDeliverWorkflowBody = <
  ESource,
  RSource,
  ECapture,
  RCapture,
>(actions: {
  readonly resolve: (
    execution: typeof ScreenshotExecution.Type,
  ) => Effect.Effect<typeof ScreenshotCaptureExecution.fields.target.Type, ESource, RSource>;
  readonly captureAndDeliver: (
    execution: typeof ScreenshotCaptureExecution.Type,
  ) => Effect.Effect<typeof ScreenshotCaptureResult.Type, ECapture, RCapture>;
}) =>
  Effect.fnUntraced(function* (execution: typeof ScreenshotExecution.Type) {
    const input = yield* decodeWorkflowContractInputOrDie(
      ScreenshotsCaptureAndDeliver,
      execution.input,
    );
    const target = yield* actions.resolve(execution);
    const delivered = yield* actions.captureAndDeliver({ ...execution, target });
    return {
      workspaceId: input.workspaceId,
      conversationName: input.conversationName,
      day: input.day,
      byteLength: delivered.byteLength,
      deliveryReceipts: [delivered.receipt],
    };
  });

export const makeScreenshotsCaptureAndDeliverDefinition = () => ({
  contract: ScreenshotsCaptureAndDeliver,
  workflow: ScreenshotsCaptureAndDeliverWorkflow,
  actions: [ResolveScreenshotSourceAction, CaptureAndDeliverScreenshotAction] as const,
  workflowLayer: ScreenshotsCaptureAndDeliverWorkflow.toLayer(
    makeScreenshotsCaptureAndDeliverWorkflowBody({
      resolve: (execution) => ResolveScreenshotSourceAction.await(execution),
      captureAndDeliver: (execution) => CaptureAndDeliverScreenshotAction.await(execution),
    }),
  ),
});
