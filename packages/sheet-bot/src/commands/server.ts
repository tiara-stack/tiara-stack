import { escapeMarkdown, roleMention } from "@discordjs/formatters";
import { InteractionsRegistry } from "dfx/gateway";
import { Ix } from "dfx/index";
import { ApplicationIntegrationType, InteractionContextType } from "discord-api-types/v10";
import { Effect, Layer, Option, Predicate, Result, pipe } from "effect";
import { GuildsCache } from "dfx-discord-utils/discord/cache";
import { CommandHelper, Interaction, InteractionResponse } from "dfx-discord-utils/utils";
import { cachesLayer } from "../discord/cache";
import { discordGatewayLayer } from "../discord/gateway";
import { EmbedService, GuildConfigService, SheetApisRequestContext } from "../services";
import { discordApplicationLayer } from "../discord/application";

const getInteractionGuildId = Effect.gen(function* () {
  const interactionGuild = yield* Interaction.guild();
  return pipe(
    interactionGuild,
    Option.map((guild) => (guild as { id: string }).id),
  );
});

const resolveGuildId = Effect.fn("resolveGuildId")(function* (serverId: Option.Option<string>) {
  const interactionGuildId = yield* getInteractionGuildId;

  return pipe(
    serverId.pipe(Option.orElse(() => interactionGuildId)),
    Option.getOrThrowWith(() => new Error("Guild not found in interaction or command options")),
  );
});

const isUnauthorized = Predicate.isTagged("Unauthorized");

const makeListConfigSubCommand = Effect.gen(function* () {
  const embedService = yield* EmbedService;
  const guildConfigService = yield* GuildConfigService;
  const guildsCache = yield* GuildsCache;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("list_config")
        .setDescription("List the config for the server")
        .addStringOption((builder) =>
          builder.setName("server_id").setDescription("The server id to list the config for"),
        ),
    Effect.fn("server.list_config")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const guild = yield* guildsCache.get(guildId);
      const guildConfigResult = yield* Effect.result(
        Effect.all({
          guildConfig: guildConfigService.getGuildConfig(guildId),
          monitorRoles: guildConfigService.getGuildMonitorRoles(guildId),
        }),
      );

      if (Result.isSuccess(guildConfigResult)) {
        const { guildConfig, monitorRoles } = guildConfigResult.success;
        const sheetId = pipe(
          guildConfig.sheetId,
          Option.map(escapeMarkdown),
          Option.getOrElse(() => "None"),
        );

        yield* response.editReply({
          payload: {
            embeds: [
              (yield* embedService.makeBaseEmbedBuilder())
                .setTitle(`Config for ${escapeMarkdown(guild.name)}`)
                .setDescription(
                  [
                    `Sheet id: ${sheetId}`,
                    `Auto check-in: ${guildConfig.autoCheckin ? "Enabled" : "Disabled"}`,
                    `Monitor roles: ${
                      monitorRoles.length > 0
                        ? monitorRoles
                            .map((role: { roleId: string }) => roleMention(role.roleId))
                            .join(", ")
                        : "None"
                    }`,
                  ].join("\n"),
                )
                .toJSON(),
            ],
          },
        });
        return;
      }

      if (isUnauthorized(guildConfigResult.failure)) {
        yield* response.editReply({
          payload: { content: "You need Manage Guild to use this command." },
        });
        return;
      }

      yield* Effect.fail(guildConfigResult.failure);
    }),
  );
});

const makeAddMonitorRoleSubCommand = Effect.gen(function* () {
  const embedService = yield* EmbedService;
  const guildConfigService = yield* GuildConfigService;
  const guildsCache = yield* GuildsCache;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("monitor_role")
        .setDescription("Add a monitor role for the server")
        .addRoleOption((builder) =>
          builder.setName("role").setDescription("The role to add").setRequired(true),
        )
        .addStringOption((builder) =>
          builder.setName("server_id").setDescription("The server id to add the monitor role to"),
        ),
    Effect.fn("server.add.monitor_role")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const guild = yield* guildsCache.get(guildId);
      const role = command.optionRoleValue("role") as { id: string };
      const addMonitorRoleResult = yield* Effect.result(
        guildConfigService.addGuildMonitorRole(guildId, role.id),
      );

      if (Result.isFailure(addMonitorRoleResult)) {
        if (isUnauthorized(addMonitorRoleResult.failure)) {
          yield* response.editReply({
            payload: { content: "You need Manage Guild to use this command." },
          });
          return;
        }
        yield* Effect.fail(addMonitorRoleResult.failure);
      }

      yield* response.editReply({
        payload: {
          embeds: [
            (yield* embedService.makeBaseEmbedBuilder())
              .setTitle("Success!")
              .setDescription(
                `${roleMention(role.id)} is now a monitor role for ${escapeMarkdown(guild.name)}`,
              )
              .toJSON(),
          ],
        },
      });
    }),
  );
});

const makeAddCommandGroup = Effect.gen(function* () {
  const addMonitorRoleSubCommand = yield* makeAddMonitorRoleSubCommand;

  return yield* CommandHelper.makeSubCommandGroup(
    (builder) =>
      builder
        .setName("add")
        .setDescription("Add a config to the server")
        .addSubcommand(() => addMonitorRoleSubCommand.data),
    (command) =>
      command.subCommands({
        monitor_role: addMonitorRoleSubCommand.handler,
      }),
  );
});

const makeRemoveMonitorRoleSubCommand = Effect.gen(function* () {
  const embedService = yield* EmbedService;
  const guildConfigService = yield* GuildConfigService;
  const guildsCache = yield* GuildsCache;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("monitor_role")
        .setDescription("Remove a monitor role from the server")
        .addRoleOption((builder) =>
          builder.setName("role").setDescription("The role to remove").setRequired(true),
        )
        .addStringOption((builder) =>
          builder
            .setName("server_id")
            .setDescription("The server id to remove the monitor role from"),
        ),
    Effect.fn("server.remove.monitor_role")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const guild = yield* guildsCache.get(guildId);
      const role = command.optionRoleValue("role") as { id: string };
      const removeMonitorRoleResult = yield* Effect.result(
        guildConfigService.removeGuildMonitorRole(guildId, role.id),
      );

      if (Result.isFailure(removeMonitorRoleResult)) {
        if (isUnauthorized(removeMonitorRoleResult.failure)) {
          yield* response.editReply({
            payload: { content: "You need Manage Guild to use this command." },
          });
          return;
        }
        yield* Effect.fail(removeMonitorRoleResult.failure);
      }

      yield* response.editReply({
        payload: {
          embeds: [
            (yield* embedService.makeBaseEmbedBuilder())
              .setTitle("Success!")
              .setDescription(
                `${roleMention(role.id)} is no longer a monitor role for ${escapeMarkdown(guild.name)}`,
              )
              .toJSON(),
          ],
        },
      });
    }),
  );
});

const makeRemoveCommandGroup = Effect.gen(function* () {
  const removeMonitorRoleSubCommand = yield* makeRemoveMonitorRoleSubCommand;

  return yield* CommandHelper.makeSubCommandGroup(
    (builder) =>
      builder
        .setName("remove")
        .setDescription("Remove a config from the server")
        .addSubcommand(() => removeMonitorRoleSubCommand.data),
    (command) =>
      command.subCommands({
        monitor_role: removeMonitorRoleSubCommand.handler,
      }),
  );
});

const makeSetSheetSubCommand = Effect.gen(function* () {
  const embedService = yield* EmbedService;
  const guildConfigService = yield* GuildConfigService;
  const guildsCache = yield* GuildsCache;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("sheet")
        .setDescription("Set the sheet id for the server")
        .addStringOption((builder) =>
          builder.setName("sheet_id").setDescription("The sheet id to set").setRequired(true),
        )
        .addStringOption((builder) =>
          builder.setName("server_id").setDescription("The server id to set the sheet id for"),
        ),
    Effect.fn("server.set.sheet")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const sheetId = command.optionValue("sheet_id");
      const guild = yield* guildsCache.get(guildId);
      const updateSheetResult = yield* Effect.result(
        guildConfigService.upsertGuildConfig(guildId, { sheetId }),
      );

      if (Result.isFailure(updateSheetResult)) {
        if (isUnauthorized(updateSheetResult.failure)) {
          yield* response.editReply({
            payload: { content: "You need Manage Guild to use this command." },
          });
          return;
        }
        yield* Effect.fail(updateSheetResult.failure);
      }

      yield* response.editReply({
        payload: {
          embeds: [
            (yield* embedService.makeBaseEmbedBuilder())
              .setTitle("Success!")
              .setDescription(
                `Sheet id for ${escapeMarkdown(guild.name)} is now set to ${escapeMarkdown(sheetId)}`,
              )
              .toJSON(),
          ],
        },
      });
    }),
  );
});

const makeSetAutoCheckinSubCommand = Effect.gen(function* () {
  const embedService = yield* EmbedService;
  const guildConfigService = yield* GuildConfigService;
  const guildsCache = yield* GuildsCache;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("auto_checkin")
        .setDescription("Set whether automatic check-in is enabled")
        .addBooleanOption((builder) =>
          builder
            .setName("auto_checkin")
            .setDescription("Enable automatic check-in")
            .setRequired(true),
        )
        .addStringOption((builder) =>
          builder.setName("server_id").setDescription("The server id to set auto check-in for"),
        ),
    Effect.fn("server.set.auto_checkin")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const autoCheckin = command.optionValue("auto_checkin");
      const updateAutoCheckinResult = yield* Effect.result(
        guildConfigService.upsertGuildConfig(guildId, { autoCheckin }),
      );

      if (Result.isSuccess(updateAutoCheckinResult)) {
        const guild = yield* guildsCache.get(guildId);
        const guildConfig = updateAutoCheckinResult.success;

        yield* response.editReply({
          payload: {
            embeds: [
              (yield* embedService.makeBaseEmbedBuilder())
                .setTitle("Success!")
                .setDescription(
                  `Auto check-in for ${escapeMarkdown(guild.name)} is now ${guildConfig.autoCheckin ? "enabled" : "disabled"}.`,
                )
                .toJSON(),
            ],
          },
        });
        return;
      }

      if (isUnauthorized(updateAutoCheckinResult.failure)) {
        yield* response.editReply({
          payload: { content: "You need Manage Guild to use this command." },
        });
        return;
      }

      yield* Effect.fail(updateAutoCheckinResult.failure);
    }),
  );
});

const makeSetCommandGroup = Effect.gen(function* () {
  const setSheetSubCommand = yield* makeSetSheetSubCommand;
  const setAutoCheckinSubCommand = yield* makeSetAutoCheckinSubCommand;

  return yield* CommandHelper.makeSubCommandGroup(
    (builder) =>
      builder
        .setName("set")
        .setDescription("Set the config of the server")
        .addSubcommand(() => setSheetSubCommand.data)
        .addSubcommand(() => setAutoCheckinSubCommand.data),
    (command) =>
      command.subCommands({
        sheet: setSheetSubCommand.handler,
        auto_checkin: setAutoCheckinSubCommand.handler,
      }),
  );
});

const makeServerCommand = Effect.gen(function* () {
  const listConfigSubCommand = yield* makeListConfigSubCommand;
  const addCommandGroup = yield* makeAddCommandGroup;
  const removeCommandGroup = yield* makeRemoveCommandGroup;
  const setCommandGroup = yield* makeSetCommandGroup;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("server")
        .setDescription("Server commands")
        .addSubcommand(() => listConfigSubCommand.data)
        .addSubcommandGroup(() => addCommandGroup.data)
        .addSubcommandGroup(() => removeCommandGroup.data)
        .addSubcommandGroup(() => setCommandGroup.data)
        .setIntegrationTypes(
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        )
        .setContexts(
          InteractionContextType.BotDM,
          InteractionContextType.Guild,
          InteractionContextType.PrivateChannel,
        ),
    SheetApisRequestContext.asInteractionUser((command) =>
      command.subCommands({
        list_config: listConfigSubCommand.handler,
        add: addCommandGroup.handler,
        remove: removeCommandGroup.handler,
        set: setCommandGroup.handler,
      }),
    ),
  );
});

const makeGlobalServerCommand = Effect.gen(function* () {
  const serverCommand = yield* makeServerCommand;

  return CommandHelper.makeGlobalCommand(serverCommand.data, serverCommand.handler as never);
});

export const serverCommandLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeGlobalServerCommand;

    yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      discordGatewayLayer,
      discordApplicationLayer,
      cachesLayer,
      GuildConfigService.layer,
      EmbedService.layer,
    ),
  ),
);
