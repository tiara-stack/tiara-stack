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
  enqueueMembersKickWorkflow,
  SheetWorkflowHttpClient,
  SheetWorkflowHttpRequestContext,
  SheetWorkflowsClient,
  SheetWorkflowsRequestContext,
  type MembersKickInput,
  type SheetWorkflowHttpClientShape,
  type SheetWorkflowsClientShape,
} from "../services";
import { config } from "../config";
import { prefixedUnstorageLayer } from "../discord/cache";
import {
  makeDispatchBase,
  makeWorkflowEnqueueFailureReporter,
  optionalPayloadField,
  optionalNumberValue,
  optionalStringValue,
  resolveConversationTarget,
} from "../utils/commandHelpers";
import { registerSingleSubCommandLayer } from "../utils/registerGlobalCommandLayer";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";
import {
  enqueueReplacementWorkflow,
  evaluateRolloutGateWithLegacyFallback,
} from "../utils/workflowEnqueue";

const kickEnqueueRejectedMessage = "I couldn't start member cleanup. Please try again.";
const kickEnqueueUnauthorizedMessage = "You aren't allowed to run member cleanup.";
const kickEnqueuePendingMessage =
  "Member cleanup is still processing. I'll update this message when it finishes.";
const kickRolloutGateEvaluationTimeout = Duration.seconds(5);

type KickRolloutGateDecision = Effect.Success<
  ReturnType<SheetWorkflowHttpClientShape["evaluateMembersKickRolloutGate"]>
>;
type KickCommandInput = Omit<MembersKickInput, "responseReference" | "workspaceId"> & {
  readonly workspaceId: string;
};

const kickGateUnavailableDecision: KickRolloutGateDecision = {
  gateKey: "unavailable",
  revision: 0,
  matched: false,
  executionPath: "legacy",
  reason: "control-unavailable",
};

const reportDefinitiveEnqueueFailure = makeWorkflowEnqueueFailureReporter({
  logMessage: "Sheet-bot member cleanup enqueue was rejected",
  rejectedMessage: kickEnqueueRejectedMessage,
  unauthorizedMessage: kickEnqueueUnauthorizedMessage,
});

const dispatchLegacyKick = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  input: KickCommandInput,
) =>
  runSheetWorkflowsDispatch(
    response,
    "the kick",
    SheetWorkflowsRequestContext.asInteractionUser(
      Effect.fn("kick.dispatchLegacyPath")(function* () {
        const base = yield* makeDispatchBase;
        return yield* sheetWorkflowsClient.get().dispatch.kick({
          payload: { ...base, ...input },
        });
      }),
    )(),
  ).pipe(Effect.catch((error) => reportDefinitiveEnqueueFailure(response, error)));

export const enqueueKick = Effect.fn("kick.enqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<
    SheetWorkflowHttpClientShape,
    "enqueueMembersKick" | "evaluateMembersKickRolloutGate"
  >,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">,
  input: Omit<MembersKickInput, "responseReference">,
  legacyInput: KickCommandInput,
) {
  const invocationId = yield* makeWorkflowInvocationId();
  const clientId = yield* config.sheetBotClientId;
  const decision = yield* evaluateRolloutGateWithLegacyFallback(
    SheetWorkflowHttpRequestContext.asInteractionUser(() =>
      workflowClient.evaluateMembersKickRolloutGate({
        contractIdentity: "members.kick",
        contractWireVersion: "1",
        client: { platform: "discord", clientId },
        invocationId,
        workspaceId: input.workspaceId,
      }),
    )(),
    kickRolloutGateEvaluationTimeout,
    kickGateUnavailableDecision,
    invocationId,
  );

  yield* Match.value(decision.executionPath).pipe(
    Match.when("legacy", () => dispatchLegacyKick(response, sheetWorkflowsClient, legacyInput)),
    Match.when("replacement", () =>
      enqueueReplacementWorkflow(
        response,
        capabilityStore,
        input.workspaceId,
        invocationId,
        (responseReference, invocationId) =>
          enqueueMembersKickWorkflow(
            workflowClient,
            { ...input, responseReference },
            { invocationId },
          ),
        "Sheet-bot member cleanup workflow enqueue outcome is ambiguous",
        kickEnqueuePendingMessage,
        (error) => reportDefinitiveEnqueueFailure(response, error),
      ),
    ),
    Match.exhaustive,
  );
});

const makeManualSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("manual")
        .setDescription("Manually kick out users")
        .addNumberOption((builder) =>
          builder.setName("hour").setDescription("The hour to kick out users for"),
        )
        .addStringOption((builder) =>
          builder.setName("channel_name").setDescription("The name of the running channel"),
        )
        .addStringOption((builder) =>
          builder.setName("server_id").setDescription("The server to kick out users for"),
        ),
    Effect.fn("kick.manual")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      const target = yield* resolveConversationTarget(
        optionalStringValue(command.optionValueOptional("server_id")),
        optionalStringValue(command.optionValueOptional("channel_name")),
      );
      const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(target.workspaceId);
      const optionalFields = optionalPayloadField(
        "hour",
        optionalNumberValue(command.optionValueOptional("hour")),
      );
      const input = { ...target, ...optionalFields, workspaceId };

      yield* enqueueKick(response, workflowClient, sheetWorkflowsClient, capabilityStore, input, {
        ...target,
        ...optionalFields,
      });
    }),
  );
});

export const kickCommandLayer = registerSingleSubCommandLayer({
  commandName: "kick",
  commandDescription: "Kick commands",
  subCommandName: "manual",
  makeSubCommand: makeManualSubCommand,
}).pipe(
  Layer.provide(
    Layer.mergeAll(
      SheetWorkflowHttpClient.layer,
      BotCapabilityStore.layer.pipe(Layer.provide(prefixedUnstorageLayer)),
    ),
  ),
);
