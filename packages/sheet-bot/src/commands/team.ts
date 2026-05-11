import { escapeMarkdown } from "@discordjs/formatters";
import { InteractionsRegistry } from "dfx/gateway";
import { ApplicationIntegrationType, InteractionContextType } from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { Array, Effect, Function, Layer, Number, Option, Order, pipe } from "effect";
import { discordGatewayLayer } from "../discord/gateway";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { Interaction } from "dfx-discord-utils/utils";
import {
  EmbedService,
  PermissionService,
  PlayerService,
  SheetApisRequestContext,
} from "../services";
import * as Sheet from "sheet-ingress-api/schemas/sheet";
import { discordApplicationLayer } from "../discord/application";

const getInteractionGuildId = Effect.gen(function* () {
  const interactionGuild = yield* Interaction.guild();
  return pipe(
    interactionGuild,
    Option.map((guild) => (guild as { id: string }).id),
  );
});

const getInteractionUser = Effect.gen(function* () {
  return (yield* Interaction.user()) as { id: string; username: string };
});

const makeListSubCommand = Effect.gen(function* () {
  const embedService = yield* EmbedService;
  const permissionService = yield* PermissionService;
  const playerService = yield* PlayerService;

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
      const interactionGuildId = yield* getInteractionGuildId;
      const serverId = command.optionValueOptional("server_id");
      const guildId = pipe(
        serverId,
        Option.orElse(() => interactionGuildId),
        Option.getOrThrow,
      );

      yield* permissionService
        .checkInteractionUserApplicationOwner()
        .pipe(
          Effect.catch(() =>
            permissionService.checkInteractionInGuild(Option.getOrUndefined(serverId)),
          ),
        );

      const interactionUser = yield* getInteractionUser;
      const targetUser = command.optionUserValueOptional("user").pipe(
        Option.map(({ user }) => user as { id: string; username: string }),
        Option.getOrElse(() => interactionUser),
      );

      const teams = yield* playerService.getTeamsById(guildId, [targetUser.id]);

      const formattedTeams = pipe(
        teams,
        Array.flatten,
        Array.filter((team) => !team.tags.includes("tierer_hint")),
        Array.sortWith(
          Function.identity,
          Order.combine(Sheet.Team.byPlayerName, Order.flip(Sheet.Team.byEffectValue)),
        ),
        Array.map((team) => ({
          teamName: team.teamName,
          tags: team.tags,
          lead: team.lead,
          backline: team.backline,
          talent: team.talent,
          effectValue: Sheet.Team.getEffectValue(team),
        })),
        Array.map((team) =>
          pipe(
            team.teamName,
            Option.map((teamName) => ({
              ...team,
              teamNameFormatted: teamName,
              leadFormatted: Option.some(`${team.lead}`),
              backlineFormatted: Option.some(`${team.backline}`),
              talentFormatted: pipe(
                team.talent,
                Option.map((talent) => `${talent}k`),
              ),
              effectValueFormatted: `(+${team.effectValue}%)`,
            })),
          ),
        ),
        Array.getSomes,
      );

      yield* response.editReply({
        payload: {
          embeds: [
            (yield* embedService.makeBaseEmbedBuilder())
              .setTitle(`${escapeMarkdown(targetUser.username)}'s Teams`)
              .setDescription(
                Number.Equivalence(formattedTeams.length, 0) ? "No teams found" : null,
              )
              .addFields(
                formattedTeams.map((team) => ({
                  name: escapeMarkdown(team.teamNameFormatted),
                  value: [
                    `Tags: ${
                      Number.Equivalence(team.tags.length, 0)
                        ? "None"
                        : escapeMarkdown(team.tags.join(", "))
                    }`,
                    `ISV: ${pipe(
                      [team.leadFormatted, team.backlineFormatted, team.talentFormatted],
                      Array.getSomes,
                      Array.join("/"),
                    )} ${team.effectValueFormatted}`,
                  ].join("\n"),
                })),
              )
              .toJSON(),
          ],
        },
      });
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
    SheetApisRequestContext.asInteractionUser((command) =>
      command.subCommands({
        list: listSubCommand.handler,
      }),
    ),
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
    Layer.mergeAll(
      discordGatewayLayer,
      discordApplicationLayer,
      PermissionService.layer,
      PlayerService.layer,
      EmbedService.layer,
    ),
  ),
);
