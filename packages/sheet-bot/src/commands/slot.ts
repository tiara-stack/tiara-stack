import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord-api-types/v10";
import { Effect, Option, Schema } from "effect";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { SheetWorkflowsClient, SheetWorkflowsRequestContext } from "../services";
import {
  makeDispatchBase,
  requiredDayOption,
  resolveChannelId,
  resolveGuildId,
  serverIdOption,
} from "../utils/commandHelpers";
import { registerGlobalCommandLayer } from "../utils/registerGlobalCommandLayer";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";

const makeListSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

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
      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));

      const messageType = yield* Schema.decodeUnknownEffect(
        Schema.Literals(["persistent", "ephemeral"]),
      )(Option.getOrElse(command.optionValueOptional("message_type"), () => "ephemeral"));

      const isEphemeral = messageType === "ephemeral";
      const day = command.optionValue("day");

      yield* response.deferReply({ flags: isEphemeral ? MessageFlags.Ephemeral : undefined });

      const base = yield* makeDispatchBase;
      yield* runSheetWorkflowsDispatch(
        response,
        "the slot list",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          sheetWorkflowsClient.get().dispatch.slotList({
            payload: {
              ...base,
              workspaceId: guildId,
              day,
              messageType,
            },
          }),
        )(),
      );
    }),
  );
});

const makeButtonSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("button")
        .setDescription("Show the button to get the open slots")
        .addNumberOption(requiredDayOption("The day to get the slots for"))
        .addStringOption(serverIdOption("The server to get the teams for")),
    Effect.fn("slot.button")(function* (command) {
      const response = yield* InteractionResponse;
      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));

      yield* response.deferReply({ flags: MessageFlags.Ephemeral });

      const day = command.optionValue("day");
      const channelId = yield* resolveChannelId(Option.none());
      const base = yield* makeDispatchBase;
      yield* runSheetWorkflowsDispatch(
        response,
        "the slot button",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          sheetWorkflowsClient.get().dispatch.slotButton({
            payload: {
              ...base,
              workspaceId: guildId,
              conversationId: channelId,
              day,
            },
          }),
        )(),
      );
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

export const slotCommandLayer = registerGlobalCommandLayer(makeSlotCommand);
