import { MessageFlags } from "discord-api-types/v10";
import { Effect, Layer, Schema } from "effect";
import { WorkspaceId } from "sheet-workflow-contracts/values";
import {
  CommandHelper,
  InteractionResponse,
  type CommandInteractionResponseContext,
} from "dfx-discord-utils/utils";
import { prefixedUnstorageLayer } from "../discord/cache";
import {
  BotCapabilityStore,
  enqueueScheduleWorkflow,
  SheetWorkflowHttpClient,
  type SchedulesDeliverUserScheduleInput,
  type SheetWorkflowHttpClientShape,
} from "../services";
import {
  makeInteractionResponseReferenceInput,
  requireNumber,
  resolveGuildId,
  resolveTargetUserIdentity,
  serverIdOption,
} from "../utils/commandHelpers";
import { registerSingleSubCommandLayer } from "../utils/registerGlobalCommandLayer";
import { enqueueSheetWorkflow } from "../utils/sheetWorkflowMigration";

const scheduleEnqueueRejectedMessage = "I couldn't start the schedule lookup. Please try again.";
const scheduleEnqueueUnauthorizedMessage = "You aren't allowed to view that user's schedule.";
const scheduleEnqueuePendingMessage =
  "The schedule lookup is still processing. I'll update this message when it finishes.";
type ScheduleWorkflowInput = Omit<SchedulesDeliverUserScheduleInput, "responseReference">;

export const makeScheduleResponseReferenceInput = makeInteractionResponseReferenceInput;

export const enqueueSchedule = Effect.fn("schedule.enqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<SheetWorkflowHttpClientShape, "enqueueSchedulesDeliverUserSchedule">,
  capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">,
  input: ScheduleWorkflowInput,
) {
  yield* enqueueSheetWorkflow({
    response,
    operation: "schedule lookup",
    workspaceId: input.workspaceId,
    capabilityStore,
    makeInput: (responseReference) => ({ ...input, responseReference }),
    enqueue: (workflowInput, options) =>
      enqueueScheduleWorkflow(workflowClient, workflowInput, options),
    rejectedMessage: scheduleEnqueueRejectedMessage,
    unauthorizedMessage: scheduleEnqueueUnauthorizedMessage,
    pendingMessage: scheduleEnqueuePendingMessage,
  });
});

const makeListSubCommand = Effect.gen(function* () {
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
      const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(guildId);
      const day = yield* requireNumber(command.optionValue("day"), "day");
      const targetUser = yield* resolveTargetUserIdentity(command.optionUserValueOptional("user"));

      yield* enqueueSchedule(response, workflowClient, capabilityStore, {
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
