import { InteractionsRegistry } from "dfx/gateway";
import { Ix } from "dfx/index";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord-api-types/v10";
import { Effect, Layer, Option } from "effect";
import { discordGatewayLayer } from "../discord/gateway";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { SheetWorkflowsClient, SheetWorkflowsRequestContext } from "../services";
import { discordApplicationLayer } from "../discord/application";
import {
  getInteractionUser,
  makeDispatchBase,
  requireNumber,
  resolveGuildId,
  toDiscordUserIdentity,
} from "../utils/commandHelpers";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";

const makeListSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

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
        .addStringOption((option) =>
          option.setName("server_id").setDescription("The server to get the schedule for"),
        ),
    Effect.fn("schedule.list")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply({ flags: MessageFlags.Ephemeral });

      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const day = yield* requireNumber(command.optionValue("day"), "day");
      const interactionUser = yield* getInteractionUser;
      const targetUser = command.optionUserValueOptional("user").pipe(
        Option.flatMap(({ user }) => toDiscordUserIdentity(user)),
        Option.getOrElse(() => interactionUser),
      );
      const base = yield* makeDispatchBase;

      yield* runSheetWorkflowsDispatch(
        response,
        "the schedule list",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          sheetWorkflowsClient.get().dispatch.scheduleList({
            payload: {
              ...base,
              guildId,
              day,
              targetUserId: targetUser.id,
              targetUsername: targetUser.username,
            },
          }),
        )(),
      );
    }),
  );
});

const makeScheduleCommand = Effect.gen(function* () {
  const listSubCommand = yield* makeListSubCommand;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("schedule")
        .setDescription("Schedule commands")
        .setIntegrationTypes(
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        )
        .setContexts(
          InteractionContextType.BotDM,
          InteractionContextType.Guild,
          InteractionContextType.PrivateChannel,
        )
        .addSubcommand(() => listSubCommand.data),
    (command) =>
      command.subCommands({
        list: listSubCommand.handler,
      }),
  );
});

const makeGlobalScheduleCommand = Effect.gen(function* () {
  const scheduleCommand = yield* makeScheduleCommand;

  return CommandHelper.makeGlobalCommand(scheduleCommand.data, scheduleCommand.handler as never);
});

export const scheduleCommandLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeGlobalScheduleCommand;

    yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(discordGatewayLayer, discordApplicationLayer, SheetWorkflowsClient.layer),
  ),
);
