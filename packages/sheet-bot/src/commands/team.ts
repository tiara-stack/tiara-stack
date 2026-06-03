import { InteractionsRegistry } from "dfx/gateway";
import { Ix } from "dfx/index";
import { ApplicationIntegrationType, InteractionContextType } from "discord-api-types/v10";
import { Effect, Layer, Option } from "effect";
import { discordGatewayLayer } from "../discord/gateway";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { SheetWorkflowsClient, SheetWorkflowsRequestContext } from "../services";
import { discordApplicationLayer } from "../discord/application";
import {
  getInteractionUser,
  makeDispatchBase,
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
        .setDescription("Get the teams for a user")
        .addUserOption((option) =>
          option.setName("user").setDescription("The user to get the teams for"),
        )
        .addStringOption((option) =>
          option.setName("server_id").setDescription("The server to get the teams for"),
        ),
    Effect.fn("team.list")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const interactionUser = yield* getInteractionUser;
      const targetUser = command.optionUserValueOptional("user").pipe(
        Option.flatMap(({ user }) => toDiscordUserIdentity(user)),
        Option.getOrElse(() => interactionUser),
      );
      const base = yield* makeDispatchBase;

      yield* runSheetWorkflowsDispatch(
        response,
        "the team list",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          sheetWorkflowsClient.get().dispatch.teamList({
            payload: {
              ...base,
              guildId,
              targetUserId: targetUser.id,
              targetUsername: targetUser.username,
            },
          }),
        )(),
      );
    }),
  );
});

const makeTeamCommand = Effect.gen(function* () {
  const listSubCommand = yield* makeListSubCommand;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("team")
        .setDescription("Team commands")
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

const makeGlobalTeamCommand = Effect.gen(function* () {
  const teamCommand = yield* makeTeamCommand;

  return CommandHelper.makeGlobalCommand(teamCommand.data, teamCommand.handler as never);
});

export const teamCommandLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeGlobalTeamCommand;

    yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(discordGatewayLayer, discordApplicationLayer, SheetWorkflowsClient.layer),
  ),
);
