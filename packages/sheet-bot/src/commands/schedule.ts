import { MessageFlags } from "discord-api-types/v10";
import { Duration, Effect, Layer, Match, Predicate, Schema } from "effect";
import {
  CommandHelper,
  InteractionResponse,
  InteractionToken,
  type CommandInteractionResponseContext,
} from "dfx-discord-utils/utils";
import { Ix } from "dfx/index";
import { config } from "../config";
import { prefixedUnstorageLayer } from "../discord/cache";
import {
  BotCapabilityStore,
  enqueueScheduleWorkflow,
  SheetWorkflowHttpClient,
  SheetWorkflowHttpRequestContext,
  SheetWorkflowsClient,
  SheetWorkflowsRequestContext,
  type SchedulesDeliverUserScheduleEnqueueError,
  type SchedulesDeliverUserScheduleInput,
  type ScheduleRolloutGateEvaluation,
  type SheetWorkflowHttpClientShape,
  type SheetWorkflowsClientShape,
} from "../services";
import {
  makeDispatchBase,
  requireNumber,
  resolveGuildId,
  resolveTargetUserIdentity,
  serverIdOption,
} from "../utils/commandHelpers";
import { registerSingleSubCommandLayer } from "../utils/registerGlobalCommandLayer";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";
import { interactionDeadlineEpochMs } from "../utils/interactionDeadline";
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

export const makeScheduleResponseReferenceInput = ({
  applicationId,
  clientId,
  interactionId,
  interactionToken,
  workspaceId,
}: {
  readonly applicationId: string;
  readonly clientId: string;
  readonly interactionId: string;
  readonly interactionToken: string;
  readonly workspaceId: string;
}) => ({
  applicationId,
  client: { platform: "discord" as const, clientId },
  interactionToken,
  permittedOperations: ["respond" as const],
  expiresAt: interactionDeadlineEpochMs(interactionId),
  workspaceId,
});

const issueScheduleResponseReference = (
  capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">,
  workspaceId: string,
) =>
  Effect.gen(function* () {
    const interactionToken = yield* InteractionToken;
    const interaction = yield* Ix.Interaction;
    const clientId = yield* config.sheetBotClientId;

    return yield* capabilityStore.issueResponseReference(
      makeScheduleResponseReferenceInput({
        applicationId: interactionToken.applicationId,
        clientId,
        interactionId: interaction.id,
        interactionToken: interactionToken.token,
        workspaceId,
      }),
    );
  });

const reportDefinitiveEnqueueFailure = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  error: unknown,
) =>
  response
    .editReply({
      payload: {
        content: Predicate.isTagged("WorkflowInvocationUnauthorized")(error)
          ? scheduleEnqueueUnauthorizedMessage
          : scheduleEnqueueRejectedMessage,
      },
    })
    .pipe(
      Effect.tap(() =>
        Effect.logWarning("Sheet-bot schedule workflow enqueue was rejected", {
          error,
        }),
      ),
    );

const isTransportUnavailable = (
  error: unknown,
): error is Extract<
  SchedulesDeliverUserScheduleEnqueueError,
  { readonly _tag: "WorkflowTransportUnavailable" }
> => Predicate.isTagged("WorkflowTransportUnavailable")(error);

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
  const decision = yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
    workflowClient.evaluateScheduleRolloutGate({
      contractIdentity: "schedules.deliverUserSchedule",
      contractWireVersion: "1",
      client: { platform: "discord", clientId },
      invocationId,
      workspaceId: input.workspaceId,
    }),
  )().pipe(
    Effect.timeout(scheduleRolloutGateEvaluationTimeout),
    Effect.catch((error) =>
      Effect.logWarning("Rollout Gate Control could not be evaluated; using legacy path", {
        error,
        invocationId,
      }).pipe(Effect.as(scheduleGateUnavailableDecision)),
    ),
  );

  yield* Match.value(decision.executionPath).pipe(
    Match.when("legacy", () => dispatchLegacySchedule(response, sheetWorkflowsClient, input)),
    Match.when("replacement", () =>
      Effect.gen(function* () {
        const responseReference = yield* issueScheduleResponseReference(
          capabilityStore,
          input.workspaceId,
        );

        yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
          enqueueScheduleWorkflow(
            workflowClient,
            { ...input, responseReference },
            { invocationId },
          ),
        )().pipe(
          Effect.catch((error) =>
            isTransportUnavailable(error)
              ? Effect.gen(function* () {
                  yield* Effect.logWarning(
                    "Sheet-bot schedule workflow enqueue outcome is ambiguous",
                    {
                      error,
                    },
                  );
                  yield* response.editReply({
                    payload: { content: scheduleEnqueuePendingMessage },
                  });
                })
              : reportDefinitiveEnqueueFailure(response, error),
          ),
        );
      }),
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
