import { ApplicationIntegrationType, InteractionContextType } from "discord-api-types/v10";
import {
  CommandHelper,
  InteractionResponse,
  type CommandInteractionResponseContext,
} from "dfx-discord-utils/utils";
import { Duration, Effect, Layer, Match, Schema } from "effect";
import { makeWorkflowInvocationId } from "sheet-workflow-http-client";
import { WorkspaceId } from "sheet-workflow-contracts/values";
import {
  BotCapabilityStore,
  enqueueScreenshotsCaptureAndDeliverWorkflow,
  SheetWorkflowHttpClient,
  SheetWorkflowHttpRequestContext,
  SheetWorkflowsClient,
  SheetWorkflowsRequestContext,
  type ScreenshotsCaptureAndDeliverInput,
  type SheetWorkflowHttpClientShape,
  type SheetWorkflowsClientShape,
} from "../services";
import { config } from "../config";
import { prefixedUnstorageLayer } from "../discord/cache";
import {
  makeDispatchBase,
  makeWorkflowEnqueueFailureReporter,
  optionalStringValue,
  requireNumber,
  requireString,
  requiredDayOption,
  resolveGuildId,
  serverIdOption,
} from "../utils/commandHelpers";
import { registerGlobalCommandLayer } from "../utils/registerGlobalCommandLayer";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";
import {
  enqueueReplacementWorkflow,
  evaluateRolloutGateWithLegacyFallback,
} from "../utils/workflowEnqueue";

const screenshotEnqueueRejectedMessage = "I couldn't start the screenshot. Please try again.";
const screenshotEnqueueUnauthorizedMessage = "You aren't allowed to capture screenshots.";
const screenshotEnqueuePendingMessage =
  "The screenshot is still processing. I'll update this message when it finishes.";
const screenshotRolloutGateEvaluationTimeout = Duration.seconds(5);

type ScreenshotRolloutGateDecision = Effect.Success<
  ReturnType<SheetWorkflowHttpClientShape["evaluateScreenshotsCaptureAndDeliverRolloutGate"]>
>;
type ScreenshotCommandInput = Omit<
  ScreenshotsCaptureAndDeliverInput,
  "responseReference" | "workspaceId"
> & { readonly workspaceId: string };

const screenshotGateUnavailableDecision: ScreenshotRolloutGateDecision = {
  gateKey: "unavailable",
  revision: 0,
  matched: false,
  executionPath: "legacy",
  reason: "control-unavailable",
};

const reportDefinitiveEnqueueFailure = makeWorkflowEnqueueFailureReporter({
  logMessage: "Sheet-bot screenshot workflow enqueue was rejected",
  rejectedMessage: screenshotEnqueueRejectedMessage,
  unauthorizedMessage: screenshotEnqueueUnauthorizedMessage,
});

const dispatchLegacyScreenshot = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  input: ScreenshotCommandInput,
) =>
  runSheetWorkflowsDispatch(
    response,
    "the screenshot",
    SheetWorkflowsRequestContext.asInteractionUser(
      Effect.fn("screenshot.dispatchLegacyPath")(function* () {
        const base = yield* makeDispatchBase;
        return yield* sheetWorkflowsClient.get().dispatch.screenshot({
          payload: { ...base, ...input },
        });
      }),
    )(),
  ).pipe(Effect.catch((error) => reportDefinitiveEnqueueFailure(response, error)));

export const enqueueScreenshot = Effect.fn("screenshot.enqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<
    SheetWorkflowHttpClientShape,
    "enqueueScreenshotsCaptureAndDeliver" | "evaluateScreenshotsCaptureAndDeliverRolloutGate"
  >,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">,
  input: Omit<ScreenshotsCaptureAndDeliverInput, "responseReference">,
  legacyInput: ScreenshotCommandInput,
) {
  const invocationId = yield* makeWorkflowInvocationId();
  const clientId = yield* config.sheetBotClientId;
  const decision = yield* evaluateRolloutGateWithLegacyFallback(
    SheetWorkflowHttpRequestContext.asInteractionUser(() =>
      workflowClient.evaluateScreenshotsCaptureAndDeliverRolloutGate({
        contractIdentity: "screenshots.captureAndDeliver",
        contractWireVersion: "1",
        client: { platform: "discord", clientId },
        invocationId,
        workspaceId: input.workspaceId,
      }),
    )(),
    screenshotRolloutGateEvaluationTimeout,
    screenshotGateUnavailableDecision,
    invocationId,
  );

  yield* Match.value(decision.executionPath).pipe(
    Match.when("legacy", () =>
      dispatchLegacyScreenshot(response, sheetWorkflowsClient, legacyInput),
    ),
    Match.when("replacement", () =>
      enqueueReplacementWorkflow(
        response,
        capabilityStore,
        input.workspaceId,
        invocationId,
        (responseReference, invocationId) =>
          enqueueScreenshotsCaptureAndDeliverWorkflow(
            workflowClient,
            { ...input, responseReference },
            { invocationId },
          ),
        "Sheet-bot screenshot workflow enqueue outcome is ambiguous",
        screenshotEnqueuePendingMessage,
        (error) => reportDefinitiveEnqueueFailure(response, error),
      ),
    ),
    Match.exhaustive,
  );
});

const makeScreenshotCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("screenshot")
        .setDescription("Day screenshot command")
        .addStringOption((option) =>
          option
            .setName("channel_name")
            .setDescription("The channel to get the screenshot for")
            .setRequired(true),
        )
        .addNumberOption(requiredDayOption("The day to get the slots for"))
        .addStringOption(serverIdOption("The server to get the teams for"))
        .setIntegrationTypes(
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        )
        .setContexts(
          InteractionContextType.BotDM,
          InteractionContextType.Guild,
          InteractionContextType.PrivateChannel,
        ),
    Effect.fn("screenshot")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      const workspaceId = yield* resolveGuildId(
        optionalStringValue(command.optionValueOptional("server_id")),
      );
      const conversationName = yield* requireString(
        command.optionValue("channel_name"),
        "channel name",
      );
      const day = yield* requireNumber(command.optionValue("day"), "day");
      const typedWorkspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(workspaceId);
      const input = { workspaceId: typedWorkspaceId, conversationName, day };

      yield* enqueueScreenshot(
        response,
        workflowClient,
        sheetWorkflowsClient,
        capabilityStore,
        input,
        { workspaceId, conversationName, day },
      );
    }),
  );
});

export const screenshotCommandLayer = registerGlobalCommandLayer(makeScreenshotCommand).pipe(
  Layer.provide(
    Layer.mergeAll(
      SheetWorkflowHttpClient.layer,
      BotCapabilityStore.layer.pipe(Layer.provide(prefixedUnstorageLayer)),
    ),
  ),
);
