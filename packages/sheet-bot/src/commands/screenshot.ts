import { InteractionsRegistry } from "dfx/gateway";
import { ApplicationIntegrationType, InteractionContextType } from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { Effect, Layer, Option, pipe } from "effect";
import { discordGatewayLayer } from "../discord/gateway";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { Interaction } from "dfx-discord-utils/utils";
import { EmbedService, ScreenshotService, SheetApisRequestContext } from "../services";
import { discordApplicationLayer } from "../discord/application";

const getInteractionGuildId = Effect.gen(function* () {
  const interactionGuild = yield* Interaction.guild();
  return pipe(
    interactionGuild,
    Option.map((guild) => (guild as { id: string }).id),
  );
});

const makeScreenshotCommand = Effect.gen(function* () {
  const screenshotService = yield* ScreenshotService;

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
    SheetApisRequestContext.asInteractionUser(
      Effect.fn("screenshot")(function* (command) {
        const response = yield* InteractionResponse;
        yield* response.deferReply();

        const serverId = command.optionValueOptional("server_id");
        const interactionGuildId = yield* getInteractionGuildId;
        const guildId = pipe(
          serverId,
          Option.orElse(() => interactionGuildId),
          Option.getOrThrow,
        );

        const channelName = command.optionValue("channel_name");
        const day = command.optionValue("day");

        const screenshot = yield* screenshotService.getScreenshot(guildId, channelName, day);

        yield* response.editReplyWithFiles(
          [new File([Buffer.from(screenshot)], "screenshot.png", { type: "image/png" })],
          {
            payload: {
              attachments: [
                {
                  id: "0",
                  description: `Day ${day}'s schedule screenshot`,
                  filename: "screenshot.png",
                },
              ],
            },
          },
        );
      }),
    ),
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
    Layer.mergeAll(
      discordGatewayLayer,
      discordApplicationLayer,
      EmbedService.layer,
      ScreenshotService.layer,
    ),
  ),
);
