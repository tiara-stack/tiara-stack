import { InteractionsRegistry } from "dfx/gateway";
import { Ix } from "dfx/index";
import { ApplicationIntegrationType, InteractionContextType } from "discord-api-types/v10";
import { Effect, Layer } from "effect";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { discordGatewayLayer } from "../discord/gateway";
import { discordApplicationLayer } from "../discord/application";
import { SheetWorkflowsClient, SheetWorkflowsRequestContext } from "../services";
import {
  makeDispatchBase,
  requireBoolean,
  requireResolvedId,
  requireString,
  resolveGuildId,
} from "../utils/commandHelpers";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";

const dispatchServerCommand = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const response = yield* InteractionResponse;
    yield* response.deferReply();
    yield* runSheetWorkflowsDispatch(response, operation, effect);
  });

const makeListConfigSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("list_config")
        .setDescription("List the config for the server")
        .addStringOption((builder) =>
          builder.setName("server_id").setDescription("The server id to list the config for"),
        ),
    Effect.fn("server.list_config")(function* (command) {
      const base = yield* makeDispatchBase;
      yield* dispatchServerCommand(
        "the server config list",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          Effect.gen(function* () {
            const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
            return yield* sheetWorkflowsClient.get().dispatch.serverListConfig({
              payload: { ...base, guildId },
            });
          }),
        )(),
      );
    }),
  );
});

const makeAddMonitorRoleSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

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
      const roleId = yield* requireResolvedId(command.optionRoleValue("role"), "role");
      const base = yield* makeDispatchBase;
      yield* dispatchServerCommand(
        "the monitor role add",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          Effect.gen(function* () {
            const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
            return yield* sheetWorkflowsClient.get().dispatch.serverAddMonitorRole({
              payload: { ...base, guildId, roleId },
            });
          }),
        )(),
      );
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
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

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
      const roleId = yield* requireResolvedId(command.optionRoleValue("role"), "role");
      const base = yield* makeDispatchBase;
      yield* dispatchServerCommand(
        "the monitor role removal",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          Effect.gen(function* () {
            const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
            return yield* sheetWorkflowsClient.get().dispatch.serverRemoveMonitorRole({
              payload: { ...base, guildId, roleId },
            });
          }),
        )(),
      );
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
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

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
      const sheetId = yield* requireString(command.optionValue("sheet_id"), "sheet ID");
      const base = yield* makeDispatchBase;
      yield* dispatchServerCommand(
        "the server sheet update",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          Effect.gen(function* () {
            const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
            return yield* sheetWorkflowsClient.get().dispatch.serverSetSheet({
              payload: { ...base, guildId, sheetId },
            });
          }),
        )(),
      );
    }),
  );
});

const makeSetAutoCheckinSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

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
      const autoCheckin = yield* requireBoolean(
        command.optionValue("auto_checkin"),
        "auto check-in",
      );
      const base = yield* makeDispatchBase;
      yield* dispatchServerCommand(
        "the server auto check-in update",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          Effect.gen(function* () {
            const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
            return yield* sheetWorkflowsClient.get().dispatch.serverSetAutoCheckin({
              payload: { ...base, guildId, autoCheckin },
            });
          }),
        )(),
      );
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
    (command) =>
      command.subCommands({
        list_config: listConfigSubCommand.handler,
        add: addCommandGroup.handler,
        remove: removeCommandGroup.handler,
        set: setCommandGroup.handler,
      }),
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
    Layer.mergeAll(discordGatewayLayer, discordApplicationLayer, SheetWorkflowsClient.layer),
  ),
);
