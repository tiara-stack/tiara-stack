import { InteractionsRegistry } from "dfx/gateway";
import { Ix } from "dfx/index";
import { ApplicationIntegrationType, InteractionContextType } from "discord-api-types/v10";
import { Effect, Layer, Option } from "effect";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { discordGatewayLayer } from "../discord/gateway";
import { discordApplicationLayer } from "../discord/application";
import { SheetWorkflowsClient, SheetWorkflowsRequestContext } from "../services";
import {
  makeDispatchBase,
  requireBoolean,
  requireResolvedId,
  requireString,
  resolveChannelId,
  resolveGuildId,
} from "../utils/commandHelpers";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";

const makeListConfigSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("list_config")
        .setDescription("List the config for the channel")
        .addChannelOption((builder) =>
          builder.setName("channel").setDescription("The channel to list the config for"),
        )
        .addStringOption((builder) =>
          builder.setName("server_id").setDescription("The server id to list the config for"),
        ),
    Effect.fn("channel.list_config")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const channelId = yield* resolveChannelId(command.optionChannelValueOptional("channel"));
      const base = yield* makeDispatchBase;

      yield* runSheetWorkflowsDispatch(
        response,
        "the channel config list",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          sheetWorkflowsClient.get().dispatch.channelListConfig({
            payload: { ...base, guildId, channelId },
          }),
        )(),
      );
    }),
  );
});

const makeSetSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("set")
        .setDescription("Set the config for the channel")
        .addChannelOption((builder) =>
          builder.setName("channel").setDescription("The channel to configure"),
        )
        .addBooleanOption((builder) =>
          builder.setName("running").setDescription("The running flag for the channel"),
        )
        .addStringOption((builder) =>
          builder.setName("name").setDescription("The name of the channel"),
        )
        .addRoleOption((builder) =>
          builder.setName("role").setDescription("The role to assign to the channel"),
        )
        .addChannelOption((builder) =>
          builder
            .setName("checkin_channel")
            .setDescription("The channel to send check in messages to"),
        )
        .addStringOption((builder) =>
          builder.setName("server_id").setDescription("The server id to set the config for"),
        ),
    Effect.fn("channel.set")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const channelId = yield* resolveChannelId(command.optionChannelValueOptional("channel"));
      const running = command.optionValueOptional("running");
      const name = command.optionValueOptional("name");
      const role = command.optionRoleValueOptional("role");
      const checkinChannel = command.optionChannelValueOptional("checkin_channel");
      const runningValue = Option.isSome(running)
        ? yield* requireBoolean(running.value, "running")
        : undefined;
      const nameValue = Option.isSome(name) ? yield* requireString(name.value, "name") : undefined;
      const roleId = Option.isSome(role) ? yield* requireResolvedId(role.value, "role") : undefined;
      const checkinChannelId = Option.isSome(checkinChannel)
        ? yield* requireResolvedId(checkinChannel.value, "check-in channel")
        : undefined;
      const base = yield* makeDispatchBase;

      yield* runSheetWorkflowsDispatch(
        response,
        "the channel config update",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          sheetWorkflowsClient.get().dispatch.channelSet({
            payload: {
              ...base,
              guildId,
              channelId,
              ...(runningValue === undefined ? {} : { running: runningValue }),
              ...(nameValue === undefined ? {} : { name: nameValue }),
              ...(roleId === undefined ? {} : { roleId }),
              ...(checkinChannelId === undefined ? {} : { checkinChannelId }),
            },
          }),
        )(),
      );
    }),
  );
});

const makeUnsetSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("unset")
        .setDescription("Unset the config for the channel")
        .addChannelOption((builder) =>
          builder.setName("channel").setDescription("The channel to configure"),
        )
        .addBooleanOption((builder) =>
          builder.setName("running").setDescription("Unset the running flag for the channel"),
        )
        .addBooleanOption((builder) =>
          builder.setName("name").setDescription("Unset the name of the channel"),
        )
        .addBooleanOption((builder) =>
          builder.setName("role").setDescription("Unset the role of the channel"),
        )
        .addBooleanOption((builder) =>
          builder
            .setName("checkin_channel")
            .setDescription("Unset the checkin channel of the channel"),
        )
        .addStringOption((builder) =>
          builder.setName("server_id").setDescription("The server id to unset the config for"),
        ),
    Effect.fn("channel.unset")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const channelId = yield* resolveChannelId(command.optionChannelValueOptional("channel"));
      const base = yield* makeDispatchBase;

      yield* runSheetWorkflowsDispatch(
        response,
        "the channel config update",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          sheetWorkflowsClient.get().dispatch.channelUnset({
            payload: {
              ...base,
              guildId,
              channelId,
              ...(Option.getOrUndefined(command.optionValueOptional("running"))
                ? { running: true }
                : {}),
              ...(Option.getOrUndefined(command.optionValueOptional("name")) ? { name: true } : {}),
              ...(Option.getOrUndefined(command.optionValueOptional("role")) ? { role: true } : {}),
              ...(Option.getOrUndefined(command.optionValueOptional("checkin_channel"))
                ? { checkinChannel: true }
                : {}),
            },
          }),
        )(),
      );
    }),
  );
});

const makeChannelCommand = Effect.gen(function* () {
  const listConfigSubCommand = yield* makeListConfigSubCommand;
  const setSubCommand = yield* makeSetSubCommand;
  const unsetSubCommand = yield* makeUnsetSubCommand;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("channel")
        .setDescription("Channel commands")
        .setIntegrationTypes(
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        )
        .setContexts(
          InteractionContextType.BotDM,
          InteractionContextType.Guild,
          InteractionContextType.PrivateChannel,
        )
        .addSubcommand(() => listConfigSubCommand.data)
        .addSubcommand(() => setSubCommand.data)
        .addSubcommand(() => unsetSubCommand.data),
    (command) =>
      command.subCommands({
        list_config: listConfigSubCommand.handler,
        set: setSubCommand.handler,
        unset: unsetSubCommand.handler,
      }),
  );
});

const makeGlobalChannelCommand = Effect.gen(function* () {
  const channelCommand = yield* makeChannelCommand;

  return CommandHelper.makeGlobalCommand(channelCommand.data, channelCommand.handler as never);
});

export const channelCommandLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeGlobalChannelCommand;

    yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(discordGatewayLayer, discordApplicationLayer, SheetWorkflowsClient.layer),
  ),
);
