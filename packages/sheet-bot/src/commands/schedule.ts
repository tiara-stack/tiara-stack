import { MessageFlags } from "discord-api-types/v10";
import { Duration, Effect, Layer, Match, Schema } from "effect";
import {
  CommandHelper,
  InteractionResponse,
  type CommandInteractionResponseContext,
} from "dfx-discord-utils/utils";
import { config } from "../config";
import { prefixedUnstorageLayer } from "../discord/cache";
import {
  BotCapabilityStore,
  enqueueScheduleWorkflow,
  SheetWorkflowHttpClient,
  SheetWorkflowHttpRequestContext,
  SheetWorkflowsClient,
  SheetWorkflowsRequestContext,
  type SchedulesDeliverUserScheduleInput,
  type ScheduleRolloutGateEvaluation,
  type SheetWorkflowHttpClientShape,
  type SheetWorkflowsClientShape,
} from "../services";
import {
  makeDispatchBase,
  makeInteractionResponseReferenceInput,
  makeWorkflowEnqueueFailureReporter,
  requireNumber,
  resolveGuildId,
  resolveTargetUserIdentity,
  serverIdOption,
} from "../utils/commandHelpers";
import { registerSingleSubCommandLayer } from "../utils/registerGlobalCommandLayer";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";
import {
  enqueueReplacementWorkflow,
  evaluateRolloutGateWithLegacyFallback,
} from "../utils/workflowEnqueue";
import { makeWorkflowInvocationId } from "sheet-workflow-http-client";

const scheduleEnqueueRejectedMessage = "I couldn't start the schedule lookup. Please try again.";
const scheduleEnqueueUnauthorizedMessage = "You aren't allowed to view that user's schedule.";
const scheduleEnqueuePendingMessage =
  "The schedule lookup is still processing. I'll update this message when it finishes.";
type ScheduleWorkflowInput = Omit<SchedulesDeliverUserScheduleInput, "responseReference">;
type ScheduleRolloutGateDecision = Effect.Success<ReturnType<ScheduleRolloutGateEvaluation>>;
const scheduleRolloutGateEvaluationTimeout = Duration.seconds(5);
const scheduleWorkspaceId = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(
  Schema.brand("sheet-workflow-contracts/WorkspaceId"),
);

const scheduleGateUnavailableDecision: ScheduleRolloutGateDecision = {
  gateKey: "unavailable",
  revision: 0,
  matched: false,
  executionPath: "legacy",
  reason: "control-unavailable",
};

export const makeScheduleResponseReferenceInput = makeInteractionResponseReferenceInput;

const reportDefinitiveEnqueueFailure = makeWorkflowEnqueueFailureReporter({
  logMessage: "Sheet-bot schedule workflow enqueue was rejected",
  rejectedMessage: scheduleEnqueueRejectedMessage,
  unauthorizedMessage: scheduleEnqueueUnauthorizedMessage,
});

const dispatchLegacySchedule = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  input: ScheduleWorkflowInput,
) =>
  runSheetWorkflowsDispatch(
    response,
    "the schedule lookup",
    SheetWorkflowsRequestContext.asInteractionUser(
      Effect.fn("schedule.dispatchLegacyPath")(function* () {
        const base = yield* makeDispatchBase;
        return yield* sheetWorkflowsClient.get().dispatch.scheduleList({
          payload: { ...base, ...input },
        });
      }),
    )(),
  ).pipe(Effect.catch((error) => reportDefinitiveEnqueueFailure(response, error)));

export const enqueueSchedule = Effect.fn("schedule.enqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<
    SheetWorkflowHttpClientShape,
    "enqueueSchedulesDeliverUserSchedule" | "evaluateScheduleRolloutGate"
  >,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">,
  input: ScheduleWorkflowInput,
) {
  const invocationId = yield* makeWorkflowInvocationId();
  const clientId = yield* config.sheetBotClientId;
  const decision = yield* evaluateRolloutGateWithLegacyFallback(
    SheetWorkflowHttpRequestContext.asInteractionUser(() =>
      workflowClient.evaluateScheduleRolloutGate({
        contractIdentity: "schedules.deliverUserSchedule",
        contractWireVersion: "1",
        client: { platform: "discord", clientId },
        invocationId,
        workspaceId: input.workspaceId,
      }),
    )(),
    scheduleRolloutGateEvaluationTimeout,
    scheduleGateUnavailableDecision,
    invocationId,
  );

  yield* Match.value(decision.executionPath).pipe(
    Match.when("legacy", () => dispatchLegacySchedule(response, sheetWorkflowsClient, input)),
    Match.when("replacement", () =>
      enqueueReplacementWorkflow(
        response,
        capabilityStore,
        input.workspaceId,
        invocationId,
        (responseReference, invocationId) =>
          enqueueScheduleWorkflow(
            workflowClient,
            { ...input, responseReference },
            { invocationId },
          ),
        "Sheet-bot schedule workflow enqueue outcome is ambiguous",
        scheduleEnqueuePendingMessage,
        (error) => reportDefinitiveEnqueueFailure(response, error),
      ),
    ),
    Match.exhaustive,
  );
});

const makeListSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("list")
        .setDescription("Get your schedule (fill/overfill/standby) for a day")
        .addNumberOption((option) =>
          option.setName("day").setDescription("The day to get the schedule for").setRequired(true),
        )
        .addUserOption((option) =>
          option.setName("user").setDescription("The user to get the schedule for"),
        )
        .addStringOption(serverIdOption("The server to get the schedule for")),
    Effect.fn("schedule.list")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply({ flags: MessageFlags.Ephemeral });

      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const workspaceId = yield* Schema.decodeUnknownEffect(scheduleWorkspaceId)(guildId);
      const day = yield* requireNumber(command.optionValue("day"), "day");
      const targetUser = yield* resolveTargetUserIdentity(command.optionUserValueOptional("user"));

      yield* enqueueSchedule(response, workflowClient, sheetWorkflowsClient, capabilityStore, {
        workspaceId,
        day,
        targetUserId: targetUser.id,
        targetUsername: targetUser.username,
      });
    }),
  );
});

export const scheduleCommandLayer = registerSingleSubCommandLayer({
  commandName: "schedule",
  commandDescription: "Schedule commands",
  subCommandName: "list",
  makeSubCommand: makeListSubCommand,
}).pipe(
  Layer.provide(
    Layer.mergeAll(
      SheetWorkflowHttpClient.layer,
      BotCapabilityStore.layer.pipe(Layer.provide(prefixedUnstorageLayer)),
    ),
  ),
);
