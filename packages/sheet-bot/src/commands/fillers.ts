import { MembersCache } from "dfx-discord-utils/discord/cache";
import { CommandHelper, type CommandInteractionResponseContext } from "dfx-discord-utils/utils";
import { Effect, Layer, Schema } from "effect";
import {
  BotCapabilityStore,
  enqueueChannelFillersWorkflow,
  SheetWorkflowHttpClient,
  type SchedulesDeliverChannelFillersInput,
  type SheetWorkflowHttpClientShape,
  SheetZeroClient,
} from "../services";
import { prefixedUnstorageLayer } from "../discord/cache";
import { discordConfigLayer } from "../discord/config";
import {
  deferEphemeralReply,
  requireNumber,
  requireString,
  resolveWorkspaceId,
  serverIdOption,
} from "../utils/commandHelpers";
import { channelNameOption, makeChannelNameAutocomplete } from "../utils/channelNameAutocomplete";
import {
  registerGlobalAutocompleteLayer,
  registerSingleSubCommandLayer,
} from "../utils/registerGlobalCommandLayer";
import { enqueueSheetWorkflow } from "../utils/sheetWorkflowMigration";

const fillersEnqueueRejectedMessage = "I couldn't start the filler lookup. Please try again.";
const fillersEnqueueUnauthorizedMessage = "You aren't allowed to view fillers in that workspace.";
const fillersEnqueuePendingMessage =
  "The filler lookup is still processing. I'll update this message when it finishes.";

type ChannelFillersWorkflowInput = Omit<SchedulesDeliverChannelFillersInput, "responseReference">;

export const enqueueChannelFillers = Effect.fn("fillers.enqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<SheetWorkflowHttpClientShape, "enqueueSchedulesDeliverChannelFillers">,
  capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">,
  input: ChannelFillersWorkflowInput,
) {
  yield* enqueueSheetWorkflow({
    response,
    operation: "filler lookup",
    workspaceId: input.workspaceId,
    capabilityStore,
    makeInput: (responseReference) => ({ ...input, responseReference }),
    enqueue: (workflowInput, options) =>
      enqueueChannelFillersWorkflow(workflowClient, workflowInput, options),
    rejectedMessage: fillersEnqueueRejectedMessage,
    unauthorizedMessage: fillersEnqueueUnauthorizedMessage,
    pendingMessage: fillersEnqueuePendingMessage,
  });
});

const HourRange = Schema.Struct({
  startHour: Schema.Int,
  finishHour: Schema.Int,
}).check(
  Schema.makeFilter(({ finishHour, startHour }) =>
    startHour <= finishHour
      ? undefined
      : "The start hour must be less than or equal to the finish hour",
  ),
);

const makeListSubCommand = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("list")
        .setDescription("List unique fillers for a running channel and hour range")
        .addStringOption((option) =>
          channelNameOption("The name of the running channel")(option).setRequired(true),
        )
        .addIntegerOption((option) =>
          option.setName("start_hour").setDescription("The first schedule hour").setRequired(true),
        )
        .addIntegerOption((option) =>
          option.setName("finish_hour").setDescription("The last schedule hour").setRequired(true),
        )
        .addStringOption(serverIdOption("The server to get the fillers for")),
    Effect.fn("fillers.list")(function* (command) {
      const response = yield* deferEphemeralReply;
      const workspaceId = yield* resolveWorkspaceId(command.optionValueOptional("server_id"));
      const conversationName = yield* requireString(
        command.optionValue("channel_name"),
        "channel name",
      );
      const startHour = yield* requireNumber(command.optionValue("start_hour"), "start hour");
      const finishHour = yield* requireNumber(command.optionValue("finish_hour"), "finish hour");
      const hours = yield* Schema.decodeUnknownEffect(HourRange)({ startHour, finishHour });

      yield* enqueueChannelFillers(response, workflowClient, capabilityStore, {
        workspaceId,
        conversationName,
        startHour: hours.startHour,
        finishHour: hours.finishHour,
      });
    }),
  );
});

export const fillersCommandLayer = Layer.merge(
  registerSingleSubCommandLayer({
    commandName: "fillers",
    commandDescription: "Filler commands",
    subCommandName: "list",
    makeSubCommand: makeListSubCommand,
  }),
  registerGlobalAutocompleteLayer(makeChannelNameAutocomplete("fillers")),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      SheetWorkflowHttpClient.layer,
      SheetZeroClient.layer,
      MembersCache.layer.pipe(Layer.provide([prefixedUnstorageLayer, discordConfigLayer])),
      BotCapabilityStore.layer.pipe(Layer.provide(prefixedUnstorageLayer)),
    ),
  ),
);
