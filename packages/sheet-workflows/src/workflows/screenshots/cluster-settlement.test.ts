import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import {
  ClusterWorkflowEngine,
  MessageStorage,
  RunnerHealth,
  RunnerStorage,
  Runners,
  Sharding,
  ShardingConfig,
} from "effect/unstable/cluster";
import { ActionContext } from "effect-zero-workflow";
import {
  screenshotBrowserWorkflowRegistrationLayers,
  screenshotOrdinaryWorkflowRegistrationLayers,
  ScreenshotsCaptureAndDeliverDefinition,
} from "./definitions";
import { CaptureAndDeliverScreenshotAction, ResolveScreenshotSourceAction } from "./definition";
import {
  makeScreenshotDeliveryKey,
  makeScreenshotLogicalRequest,
  makeScreenshotSemanticFileIdentity,
} from "./keys";
import {
  ScreenshotCaptureResult,
  ScreenshotExecution,
  ScreenshotRenderTargetSchema,
} from "./schema";
import { ScreenshotCaptureOperations, ScreenshotSourceOperations } from "./service";
import { ScreenshotsCaptureAndDeliver } from "sheet-workflow-contracts";
import { ResponseReference } from "sheet-bot-api";
import { EffectivePrincipal } from "sheet-auth/identity";

const responseReference = Schema.decodeUnknownSync(ResponseReference)("response-1");
const screenshotInput = Schema.decodeUnknownSync(ScreenshotsCaptureAndDeliver.input)({
  workspaceId: "workspace-1",
  responseReference,
  conversationName: "alpha",
  day: 2,
});
const screenshotExecution: typeof ScreenshotExecution.Type = Schema.decodeUnknownSync(
  ScreenshotExecution,
)({
  invocationId: "27326d65-56cf-419e-8f8c-5e0802e8ec0c",
  input: screenshotInput,
  principal: Schema.decodeUnknownSync(EffectivePrincipal)({
    kind: "user",
    userId: "user-1",
    discordAccount: { accountId: "discord-user-1" },
  }),
});
const screenshotDeliveryBinding = {
  semanticIdentity: makeScreenshotSemanticFileIdentity(
    screenshotExecution.invocationId,
    screenshotInput.workspaceId,
    screenshotInput.conversationName,
    screenshotInput.day,
  ),
  logicalRequest: makeScreenshotLogicalRequest(
    screenshotInput.workspaceId,
    screenshotInput.conversationName,
    screenshotInput.day,
  ),
};

const actionContext = {
  query: () => Effect.die("unused"),
  mutate: () => Effect.die("unused"),
};

const clusterServicesLayer = Sharding.layer.pipe(
  Layer.provideMerge(Runners.layerNoop),
  Layer.provideMerge(MessageStorage.layerMemory),
  Layer.provide([RunnerStorage.layerMemory, RunnerHealth.layerNoop]),
  Layer.provide(
    ShardingConfig.layer({
      availableShardGroups: ["dispatch", "browser"],
      assignedShardGroups: ["dispatch", "browser"],
      entityMessagePollInterval: "10 millis",
      entityReplyPollInterval: "1 millis",
      refreshAssignmentsInterval: "10 millis",
      simulateRemoteSerialization: false,
    }),
  ),
);

layer(clusterServicesLayer, { excludeTestServices: true })(
  "screenshot cluster settlement",
  (it) => {
    it.effect(
      "settles the dispatch run after the browser action and resume lifecycle",
      () =>
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const dispatchEngine = yield* ClusterWorkflowEngine.make;
          const browserEngine = yield* ClusterWorkflowEngine.make;
          const messageDriver = yield* MessageStorage.MemoryDriver;
          const sharding = yield* Sharding.Sharding;
          const effects: Array<string> = [];

          const dispatchLayer = screenshotOrdinaryWorkflowRegistrationLayers.pipe(
            Layer.provide(
              Layer.succeed(ScreenshotSourceOperations, {
                resolve: () =>
                  Effect.sync(() => {
                    effects.push("resolve");
                    return Schema.decodeUnknownSync(ScreenshotRenderTargetSchema)({
                      url: "https://docs.google.com/render",
                    });
                  }),
              }),
            ),
            Layer.provide(Layer.succeed(WorkflowEngine.WorkflowEngine, dispatchEngine)),
            Layer.provide(Layer.succeed(ActionContext, actionContext)),
          );
          // Each ClusterWorkflowEngine owns a separate workflow registry, as do
          // the dispatch and browser runner processes in production.
          yield* Layer.buildWithMemoMap(dispatchLayer, Layer.makeMemoMapUnsafe(), scope);

          const browserLayer = screenshotBrowserWorkflowRegistrationLayers.pipe(
            Layer.provide(
              Layer.succeed(ScreenshotCaptureOperations, {
                captureAndDeliver: (execution) =>
                  Effect.sync(() => {
                    effects.push("capture-and-deliver");
                    return Schema.decodeUnknownSync(ScreenshotCaptureResult)({
                      receipt: {
                        deliveryKey: makeScreenshotDeliveryKey(execution.invocationId),
                        operation: "respond",
                        target: {
                          _tag: "Response",
                          responseReference: screenshotInput.responseReference,
                        },
                        files: [
                          {
                            name: "screenshot.png",
                            contentType: "image/png",
                            byteLength: 48_021,
                            deliveryBinding: screenshotDeliveryBinding,
                          },
                        ],
                      },
                      byteLength: 48_021,
                    });
                  }),
              }),
            ),
            Layer.provide(Layer.succeed(WorkflowEngine.WorkflowEngine, browserEngine)),
            Layer.provide(Layer.succeed(ActionContext, actionContext)),
          );
          yield* Layer.buildWithMemoMap(browserLayer, Layer.makeMemoMapUnsafe(), scope);

          yield* Effect.sleep("50 millis");
          const result = yield* ScreenshotsCaptureAndDeliverDefinition.workflow
            .execute(screenshotExecution, { discard: false })
            .pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, dispatchEngine));

          expect(result).toMatchObject({
            workspaceId: "workspace-1",
            conversationName: "alpha",
            day: 2,
            byteLength: 48_021,
            deliveryReceipts: [
              {
                deliveryKey: makeScreenshotDeliveryKey(screenshotExecution.invocationId),
                operation: "respond",
                target: {
                  _tag: "Response",
                  responseReference: screenshotInput.responseReference,
                },
                files: [
                  {
                    name: "screenshot.png",
                    contentType: "image/png",
                    byteLength: 48_021,
                    deliveryBinding: screenshotDeliveryBinding,
                  },
                ],
              },
            ],
          });
          expect(effects).toEqual(["resolve", "capture-and-deliver"]);

          const executionId =
            yield* ScreenshotsCaptureAndDeliverDefinition.workflow.executionId(screenshotExecution);
          expect(executionId).toBe("3eb97e9cba275d2a456aabec8f98b2f6");
          const polled = yield* ScreenshotsCaptureAndDeliverDefinition.workflow
            .poll(executionId)
            .pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, dispatchEngine));
          expect(Option.isSome(polled) && polled.value._tag === "Complete").toBe(true);

          // Resolve sends a resume while the parent run is still active. Polling
          // after the terminal parent reply proves that the stale control message
          // also gets reconciled.
          yield* sharding.pollStorage;
          yield* Effect.sleep("50 millis");

          expect(messageDriver.unprocessed).toHaveLength(0);
          expect(
            Array.from(messageDriver.requests.values()).every((entry) =>
              entry.replies.some((reply) => reply._tag === "WithExit"),
            ),
          ).toBe(true);
          expect(
            new Set(
              Array.from(messageDriver.requests.values(), (entry) =>
                entry.envelope._tag === "Request"
                  ? `${entry.envelope.address.entityType}:${entry.envelope.tag}`
                  : entry.envelope._tag,
              ),
            ),
          ).toEqual(
            new Set([
              `Workflow/${ScreenshotsCaptureAndDeliverDefinition.workflow.name}:run`,
              `Workflow/${ScreenshotsCaptureAndDeliverDefinition.workflow.name}:resume`,
              `Workflow/${ResolveScreenshotSourceAction.name}:run`,
              `Workflow/${ResolveScreenshotSourceAction.name}:activity`,
              `Workflow/${CaptureAndDeliverScreenshotAction.name}:run`,
              `Workflow/${CaptureAndDeliverScreenshotAction.name}:activity`,
            ]),
          );
        }),
      30_000,
    );
  },
);
