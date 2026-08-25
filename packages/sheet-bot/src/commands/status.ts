import { InteractionsRegistry } from "dfx/gateway";
import { ApplicationIntegrationType, InteractionContextType } from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { Duration, Effect, Layer, Match } from "effect";
import {
  CommandHelper,
  InteractionResponse,
  type CommandInteractionResponseContext,
} from "dfx-discord-utils/utils";
import { config } from "../config";
import { prefixedUnstorageLayer } from "../discord/cache";
import { discordApplicationLayer } from "../discord/application";
import { discordGatewayLayer } from "../discord/gateway";
import {
  BotCapabilityStore,
  enqueueStatusWorkflow,
  SheetWorkflowsClient,
  SheetWorkflowsRequestContext,
  SheetWorkflowHttpClient,
  SheetWorkflowHttpRequestContext,
  type BotCapabilityStoreShape,
  type SheetWorkflowHttpClientShape,
  type SheetWorkflowsClientShape,
  type StatusRolloutGateEvaluation,
} from "../services";
import { makeWorkflowInvocationId } from "sheet-workflow-http-client";
import {
  issueInteractionResponseReference,
  makeDispatchBase,
  makeResponseReferenceInput,
  resolveInteractionWorkspaceId,
} from "../utils/commandHelpers";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";
import {
  isWorkflowTransportUnavailable,
  reportAmbiguousWorkflowEnqueueOutcome,
  reportDefinitiveWorkflowEnqueueFailure,
} from "../utils/workflowEnqueueOutcome";

const statusEnqueueRejectedMessage = "I couldn't start the service status check. Please try again.";
const statusEnqueueUnauthorizedMessage =
  "Only the application owner can start the service status check.";
const statusEnqueuePendingMessage =
  "The service status check is still processing. I'll update this message when it finishes.";
type StatusRolloutGateDecision = Effect.Success<ReturnType<StatusRolloutGateEvaluation>>;
const statusRolloutGateEvaluationTimeout = Duration.seconds(5);

const statusGateUnavailableDecision: StatusRolloutGateDecision = {
  gateKey: "unavailable",
  revision: 0,
  matched: false,
  executionPath: "legacy",
  reason: "control-unavailable",
};

export const makeStatusResponseReferenceInput = makeResponseReferenceInput;

const issueStatusResponseReference = issueInteractionResponseReference;

const dispatchLegacyStatus = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
) =>
  runSheetWorkflowsDispatch(
    response,
    "the service status check",
    SheetWorkflowsRequestContext.asInteractionUser(
      Effect.fn("status.dispatchLegacyPath")(function* () {
        const base = yield* makeDispatchBase;
        return yield* sheetWorkflowsClient.get().dispatch.serviceStatus({
          payload: base,
        });
      }),
    )(),
  ).pipe(
    Effect.catch((error) =>
      reportDefinitiveWorkflowEnqueueFailure(response, error, {
        rejectedMessage: statusEnqueueRejectedMessage,
        unauthorizedMessage: statusEnqueueUnauthorizedMessage,
        operation: "status",
      }),
    ),
  );

export const enqueueStatus = Effect.fn("status.enqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<
    SheetWorkflowHttpClientShape,
    "enqueueServicesDeliverStatus" | "evaluateStatusRolloutGate"
  >,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">,
) {
  const invocationId = yield* makeWorkflowInvocationId();
  const clientId = yield* config.sheetBotClientId;
  const workspaceId = yield* resolveInteractionWorkspaceId;
  const decision = yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
    workflowClient.evaluateStatusRolloutGate({
      contractIdentity: "services.deliverStatus",
      contractWireVersion: "1",
      client: { platform: "discord", clientId },
      invocationId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    }),
  )().pipe(
    Effect.timeout(statusRolloutGateEvaluationTimeout),
    Effect.catch((error) =>
      Effect.logWarning("Rollout Gate Control could not be evaluated; using legacy path", {
        error,
        invocationId,
      }).pipe(Effect.as(statusGateUnavailableDecision)),
    ),
  );

  yield* Match.value(decision.executionPath).pipe(
    Match.when("legacy", () => dispatchLegacyStatus(response, sheetWorkflowsClient)),
    Match.when("replacement", () =>
      Effect.gen(function* () {
        const responseReference = yield* issueStatusResponseReference(capabilityStore, workspaceId);

        yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
          enqueueStatusWorkflow(workflowClient, { responseReference }, { invocationId }),
        )().pipe(
          Effect.catch((error) =>
            isWorkflowTransportUnavailable(error)
              ? reportAmbiguousWorkflowEnqueueOutcome(response, error, {
                  pendingMessage: statusEnqueuePendingMessage,
                  operation: "status",
                })
              : reportDefinitiveWorkflowEnqueueFailure(response, error, {
                  rejectedMessage: statusEnqueueRejectedMessage,
                  unauthorizedMessage: statusEnqueueUnauthorizedMessage,
                  operation: "status",
                }),
          ),
        );
      }),
    ),
    Match.exhaustive,
  );
});

const makeStatusCommand = Effect.gen(function* () {
  const capabilityStore = yield* BotCapabilityStore;
  const workflowClient = yield* SheetWorkflowHttpClient;
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("status")
        .setDescription("Show service readiness status")
        .setIntegrationTypes(
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        )
        .setContexts(
          InteractionContextType.BotDM,
          InteractionContextType.Guild,
          InteractionContextType.PrivateChannel,
        ),
    Effect.fn("status")(function* () {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      yield* enqueueStatus(response, workflowClient, sheetWorkflowsClient, capabilityStore);
    }),
  );
});

const makeGlobalStatusCommand = Effect.gen(function* () {
  const statusCommand = yield* makeStatusCommand;

  return CommandHelper.makeGlobalCommand(statusCommand.data, statusCommand.handler as never);
});

export const statusCommandLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeGlobalStatusCommand;

    yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      discordGatewayLayer,
      discordApplicationLayer,
      SheetWorkflowHttpClient.layer,
      SheetWorkflowsClient.layer,
      BotCapabilityStore.layer.pipe(Layer.provide(prefixedUnstorageLayer)),
    ),
  ),
);
