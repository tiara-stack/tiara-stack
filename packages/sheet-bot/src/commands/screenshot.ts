import { ApplicationIntegrationType, InteractionContextType } from "discord-api-types/v10";
import { Effect } from "effect";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { SheetWorkflowsClient, SheetWorkflowsRequestContext } from "../services";
import {
  makeDispatchBase,
  requireNumber,
  requireString,
  requiredDayOption,
  resolveGuildId,
  serverIdOption,
} from "../utils/commandHelpers";
import { registerGlobalCommandLayer } from "../utils/registerGlobalCommandLayer";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";

const makeScreenshotCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

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

      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const channelName = yield* requireString(command.optionValue("channel_name"), "channel name");
      const day = yield* requireNumber(command.optionValue("day"), "day");
      const base = yield* makeDispatchBase;

      yield* runSheetWorkflowsDispatch(
        response,
        "the screenshot",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          sheetWorkflowsClient.get().dispatch.screenshot({
            payload: {
              ...base,
              workspaceId: guildId,
              conversationName: channelName,
              day,
            },
          }),
        )(),
      );
    }),
  );
});

export const screenshotCommandLayer = registerGlobalCommandLayer(makeScreenshotCommand);
