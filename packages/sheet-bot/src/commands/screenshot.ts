import { InteractionsRegistry } from "dfx/gateway";
import { Ix } from "dfx/index";
import { ApplicationIntegrationType, InteractionContextType } from "discord-api-types/v10";
import { Effect, Layer } from "effect";
import { discordGatewayLayer } from "../discord/gateway";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { SheetWorkflowsClient, SheetWorkflowsRequestContext } from "../services";
import { discordApplicationLayer } from "../discord/application";
import {
  makeDispatchBase,
  requireNumber,
  requireString,
  resolveGuildId,
} from "../utils/commandHelpers";
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
        .addNumberOption((option) =>
          option.setName("day").setDescription("The day to get the slots for").setRequired(true),
        )
        .addStringOption((option) =>
          option.setName("server_id").setDescription("The server to get the teams for"),
        )
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
              guildId,
              channelName,
              day,
            },
          }),
        )(),
      );
    }),
  );
});

const makeGlobalScreenshotCommand = Effect.gen(function* () {
  const screenshotCommand = yield* makeScreenshotCommand;

  return CommandHelper.makeGlobalCommand(
    screenshotCommand.data,
    screenshotCommand.handler as never,
  );
});

export const screenshotCommandLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeGlobalScreenshotCommand;

    yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(discordGatewayLayer, discordApplicationLayer, SheetWorkflowsClient.layer),
  ),
);
