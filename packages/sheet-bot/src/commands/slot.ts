import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord-api-types/v10";
import { Effect, Layer, Option, Schema } from "effect";
import { WorkspaceId } from "sheet-workflow-contracts/values";
import {
  CommandHelper,
  InteractionResponse,
  type CommandInteractionResponseContext,
} from "dfx-discord-utils/utils";
import { prefixedUnstorageLayer } from "../discord/cache";
import {
  BotCapabilityStore,
  enqueueSlotsDeliverListWorkflow,
  enqueueSlotsPublishButtonWorkflow,
  SheetWorkflowHttpClient,
  type BotCapabilityStoreShape,
  type SheetWorkflowHttpClientShape,
  type SlotsDeliverListInput,
  type SlotsPublishButtonInput,
} from "../services";
import {
  makeResponseReferenceInput,
  requiredDayOption,
  resolveChannelId,
  resolveGuildId,
  serverIdOption,
} from "../utils/commandHelpers";
import { registerGlobalCommandLayer } from "../utils/registerGlobalCommandLayer";
import { enqueueSheetWorkflow } from "../utils/sheetWorkflowMigration";

type SlotListWorkflowInput = Omit<SlotsDeliverListInput, "responseReference">;
type SlotPublishButtonWorkflowInput = Omit<SlotsPublishButtonInput, "responseReference">;

const slotListEnqueueRejectedMessage = "I couldn't start the slot list. Please try again.";
const slotListEnqueueUnauthorizedMessage = "You aren't allowed to view slots in that workspace.";
const slotPublishButtonEnqueueRejectedMessage =
  "I couldn't publish the slot button. Please try again.";
const slotPublishButtonEnqueueUnauthorizedMessage =
  "You aren't allowed to publish a slot button in that workspace.";
const slotEnqueuePendingMessage =
  "The slot request is still processing. I'll update this message when it finishes.";

export const makeSlotResponseReferenceInput = makeResponseReferenceInput;

export const enqueueSlotList = Effect.fn("slot.enqueueListWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<SheetWorkflowHttpClientShape, "enqueueSlotsDeliverList">,
  capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">,
  input: SlotListWorkflowInput,
) {
  yield* enqueueSheetWorkflow({
    response,
    operation: "slot list",
    workspaceId: input.workspaceId,
    capabilityStore,
    makeInput: (responseReference) => ({ ...input, responseReference }),
    enqueue: (workflowInput, options) =>
      enqueueSlotsDeliverListWorkflow(workflowClient, workflowInput, options),
    rejectedMessage: slotListEnqueueRejectedMessage,
    unauthorizedMessage: slotListEnqueueUnauthorizedMessage,
    pendingMessage: slotEnqueuePendingMessage,
  });
});

export const enqueueSlotButton = Effect.fn("slot.enqueueButtonWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<SheetWorkflowHttpClientShape, "enqueueSlotsPublishButton">,
  capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">,
  input: SlotPublishButtonWorkflowInput,
) {
  yield* enqueueSheetWorkflow({
    response,
    operation: "slot button",
    workspaceId: input.workspaceId,
    capabilityStore,
    makeInput: (responseReference) => ({ ...input, responseReference }),
    enqueue: (workflowInput, options) =>
      enqueueSlotsPublishButtonWorkflow(workflowClient, workflowInput, options),
    rejectedMessage: slotPublishButtonEnqueueRejectedMessage,
    unauthorizedMessage: slotPublishButtonEnqueueUnauthorizedMessage,
    pendingMessage: slotEnqueuePendingMessage,
  });
});

const makeListSubCommand = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("list")
        .setDescription("Get the open slots for the day")
        .addNumberOption(requiredDayOption("The day to get the slots for"))
        .addStringOption(serverIdOption("The server to get the teams for"))
        .addStringOption((option) =>
          option
            .setName("message_type")
            .setDescription("The type of message to send")
            .addChoices(
              { name: "persistent", value: "persistent" },
              { name: "ephemeral", value: "ephemeral" },
            ),
        ),
    Effect.fn("slot.list")(function* (command) {
      const response = yield* InteractionResponse;

      const messageType = yield* Schema.decodeUnknownEffect(
        Schema.Literals(["persistent", "ephemeral"]),
      )(Option.getOrElse(command.optionValueOptional("message_type"), () => "ephemeral"));

      const isEphemeral = messageType === "ephemeral";
      yield* response.deferReply({ flags: isEphemeral ? MessageFlags.Ephemeral : undefined });

      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(guildId);
      const day = command.optionValue("day");

      yield* enqueueSlotList(response, workflowClient, capabilityStore, {
        workspaceId,
        day,
        messageType,
      });
    }),
  );
});

const makeButtonSubCommand = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("button")
        .setDescription("Show the button to get the open slots")
        .addNumberOption(requiredDayOption("The day to get the slots for"))
        .addStringOption(serverIdOption("The server to get the teams for")),
    Effect.fn("slot.button")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply({ flags: MessageFlags.Ephemeral });

      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(guildId);

      const day = command.optionValue("day");
      const channelId = yield* resolveChannelId(Option.none());
      yield* enqueueSlotButton(response, workflowClient, capabilityStore, {
        workspaceId,
        conversationId: channelId,
        day,
      });
    }),
  );
});

const makeSlotCommand = Effect.gen(function* () {
  const listSubCommand = yield* makeListSubCommand;
  const buttonSubCommand = yield* makeButtonSubCommand;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("slot")
        .setDescription("Day slots commands")
        .setIntegrationTypes(
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        )
        .setContexts(
          InteractionContextType.BotDM,
          InteractionContextType.Guild,
          InteractionContextType.PrivateChannel,
        )
        .addSubcommand(() => listSubCommand.data)
        .addSubcommand(() => buttonSubCommand.data),
    (command) =>
      command.subCommands({
        list: listSubCommand.handler,
        button: buttonSubCommand.handler,
      }),
  );
});

export const slotCommandLayer = registerGlobalCommandLayer(makeSlotCommand).pipe(
  Layer.provide(
    Layer.mergeAll(
      SheetWorkflowHttpClient.layer,
      BotCapabilityStore.layer.pipe(Layer.provide(prefixedUnstorageLayer)),
    ),
  ),
);
