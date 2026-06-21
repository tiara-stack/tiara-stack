import { Effect, Layer, Option, pipe } from "effect";
import { InteractionsRegistry } from "dfx/gateway";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { discordGatewayLayer } from "../discord/gateway";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { SheetWorkflowsClient, SheetWorkflowsRequestContext } from "../services";
import { discordApplicationLayer } from "../discord/application";
import { makeDispatchBase, resolveChannelId, resolveGuildId } from "../utils/commandHelpers";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";

const makeManualSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("manual")
        .setDescription("Manually check in users")
        .addStringOption((option) =>
          option.setName("channel_name").setDescription("The name of the running channel"),
        )
        .addNumberOption((option) =>
          option.setName("hour").setDescription("The hour to check in users for"),
        )
        .addStringOption((option) =>
          option.setName("server_id").setDescription("The server to check in users for"),
        )
        .addStringOption((option) =>
          option
            .setName("template")
            .setDescription("Optional Handlebars template for the check-in message"),
        ),
    Effect.fn("checkin.manual")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply({ flags: MessageFlags.Ephemeral });

      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const templateOption = command.optionValueOptional("template");

      const channelNameOption = command.optionValueOptional("channel_name");
      const interactionChannelId = Option.isSome(channelNameOption)
        ? undefined
        : yield* resolveChannelId(Option.none());
      const base = yield* makeDispatchBase;

      yield* runSheetWorkflowsDispatch(
        response,
        "the check-in",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          sheetWorkflowsClient.get().dispatch.checkin({
            payload: {
              ...base,
              workspaceId: guildId,
              ...(Option.isSome(channelNameOption)
                ? { conversationName: channelNameOption.value }
                : {
                    conversationId: interactionChannelId,
                  }),
              ...pipe(
                command.optionValueOptional("hour"),
                Option.match({
                  onSome: (hour) => ({ hour }),
                  onNone: () => ({}),
                }),
              ),
              ...pipe(
                templateOption,
                Option.match({
                  onSome: (template) => ({ template }),
                  onNone: () => ({}),
                }),
              ),
            },
          }),
        )(),
      );
    }),
  );
});

const makeTestAutoSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("test_auto")
        .setDescription("Test first-hour automatic check-in configuration")
        .addStringOption((option) =>
          option.setName("server_id").setDescription("The server to test auto check-in for"),
        ),
    Effect.fn("checkin.test_auto")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply({});

      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const anchorChannelId = yield* resolveChannelId(Option.none());
      const base = yield* makeDispatchBase;

      yield* runSheetWorkflowsDispatch(
        response,
        "the auto check-in test",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          sheetWorkflowsClient.get().dispatch.autoCheckinTest({
            payload: {
              ...base,
              workspaceId: guildId,
              anchorConversationId: anchorChannelId,
            },
          }),
        )(),
      );
    }),
  );
});

const makeCheckinCommand = Effect.gen(function* () {
  const manualSubCommand = yield* makeManualSubCommand;
  const testAutoSubCommand = yield* makeTestAutoSubCommand;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("checkin")
        .setDescription("Checkin commands")
        .setIntegrationTypes(
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        )
        .setContexts(
          InteractionContextType.BotDM,
          InteractionContextType.Guild,
          InteractionContextType.PrivateChannel,
        )
        .addSubcommand(() => manualSubCommand.data)
        .addSubcommand(() => testAutoSubCommand.data),
    (command) =>
      command.subCommands({
        manual: manualSubCommand.handler,
        test_auto: testAutoSubCommand.handler,
      }),
  );
});

const makeGlobalCheckinCommand = Effect.gen(function* () {
  const checkinCommand = yield* makeCheckinCommand;

  return CommandHelper.makeGlobalCommand(checkinCommand.data, checkinCommand.handler as never);
});

export const checkinCommandLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeGlobalCheckinCommand;

    yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(discordGatewayLayer, discordApplicationLayer, SheetWorkflowsClient.layer),
  ),
);
