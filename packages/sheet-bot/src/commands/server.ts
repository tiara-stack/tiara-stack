import { InteractionsRegistry } from "dfx/gateway";
import { Ix } from "dfx/index";
import {
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
} from "discord-api-types/v10";
import { Effect, Layer, Schema } from "effect";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { discordGatewayLayer } from "../discord/gateway";
import { discordApplicationLayer } from "../discord/application";
import { prefixedUnstorageLayer } from "../discord/cache";
import {
  BotCapabilityStore,
  enqueueWorkspacesDeliverConfigWorkflow,
  enqueueWorkspacesSetMonitorRoleAndDeliverWorkflow,
  enqueueWorkspacesUpdateConfigAndDeliverWorkflow,
  SheetWorkflowHttpClient,
  type WorkspacesDeliverConfigInput,
  type WorkspacesSetMonitorRoleAndDeliverInput,
  type WorkspacesUpdateConfigAndDeliverInput,
} from "../services";
import {
  decodeWorkflowWorkspaceId,
  requireBoolean,
  requireResolvedId,
  requireString,
  resolveGuildId,
} from "../utils/commandHelpers";
import { enqueueSheetWorkflow } from "../utils/sheetWorkflowMigration";

const serverRejectedMessage = "I couldn't update the server configuration. Please try again.";
const serverUnauthorizedMessage = "You aren't allowed to manage that server.";
const serverPendingMessage =
  "The server configuration request is still processing. I'll update this message when it finishes.";

const workflowSpreadsheetId = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(
  Schema.brand("sheet-workflow-contracts/SpreadsheetId"),
);

const makeListConfigSubCommand = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

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
      const workspaceId = yield* decodeWorkflowWorkspaceId(guildId);

      yield* enqueueSheetWorkflow({
        response,
        operation: "the server config list",
        workspaceId,
        capabilityStore,
        makeInput: (responseReference): WorkspacesDeliverConfigInput => ({
          workspaceId,
          responseReference,
        }),
        enqueue: (input, options) =>
          enqueueWorkspacesDeliverConfigWorkflow(workflowClient, input, options),
        rejectedMessage: serverRejectedMessage,
        unauthorizedMessage: serverUnauthorizedMessage,
        pendingMessage: serverPendingMessage,
      });
    }),
  );
});

const makeAddMonitorRoleSubCommand = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

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
      const roleId = yield* requireResolvedId(command.optionRoleValue("role"), "role");
      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const workspaceId = yield* decodeWorkflowWorkspaceId(guildId);

      yield* enqueueSheetWorkflow({
        response,
        operation: "the monitor role add",
        workspaceId,
        capabilityStore,
        makeInput: (responseReference): WorkspacesSetMonitorRoleAndDeliverInput => ({
          workspaceId,
          roleId,
          enabled: true,
          responseReference,
        }),
        enqueue: (input, options) =>
          enqueueWorkspacesSetMonitorRoleAndDeliverWorkflow(workflowClient, input, options),
        rejectedMessage: serverRejectedMessage,
        unauthorizedMessage: serverUnauthorizedMessage,
        pendingMessage: serverPendingMessage,
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
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

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
      const roleId = yield* requireResolvedId(command.optionRoleValue("role"), "role");
      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const workspaceId = yield* decodeWorkflowWorkspaceId(guildId);

      yield* enqueueSheetWorkflow({
        response,
        operation: "the monitor role removal",
        workspaceId,
        capabilityStore,
        makeInput: (responseReference): WorkspacesSetMonitorRoleAndDeliverInput => ({
          workspaceId,
          roleId,
          enabled: false,
          responseReference,
        }),
        enqueue: (input, options) =>
          enqueueWorkspacesSetMonitorRoleAndDeliverWorkflow(workflowClient, input, options),
        rejectedMessage: serverRejectedMessage,
        unauthorizedMessage: serverUnauthorizedMessage,
        pendingMessage: serverPendingMessage,
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
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

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
      const sheetId = yield* requireString(command.optionValue("sheet_id"), "sheet ID");
      const spreadsheetId = yield* Schema.decodeUnknownEffect(workflowSpreadsheetId)(sheetId);
      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const workspaceId = yield* decodeWorkflowWorkspaceId(guildId);

      yield* enqueueSheetWorkflow({
        response,
        operation: "the server sheet update",
        workspaceId,
        capabilityStore,
        makeInput: (responseReference): WorkspacesUpdateConfigAndDeliverInput => ({
          workspaceId,
          responseReference,
          patch: { spreadsheetId },
        }),
        enqueue: (input, options) =>
          enqueueWorkspacesUpdateConfigAndDeliverWorkflow(workflowClient, input, options),
        rejectedMessage: serverRejectedMessage,
        unauthorizedMessage: serverUnauthorizedMessage,
        pendingMessage: serverPendingMessage,
      });
    }),
  );
});

const makeSetAutoCheckinSubCommand = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

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
      const autoCheckin = yield* requireBoolean(
        command.optionValue("auto_checkin"),
        "auto check-in",
      );
      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const workspaceId = yield* decodeWorkflowWorkspaceId(guildId);

      yield* enqueueSheetWorkflow({
        response,
        operation: "the server auto check-in update",
        workspaceId,
        capabilityStore,
        makeInput: (responseReference): WorkspacesUpdateConfigAndDeliverInput => ({
          workspaceId,
          responseReference,
          patch: { autoCheckin },
        }),
        enqueue: (input, options) =>
          enqueueWorkspacesUpdateConfigAndDeliverWorkflow(workflowClient, input, options),
        rejectedMessage: serverRejectedMessage,
        unauthorizedMessage: serverUnauthorizedMessage,
        pendingMessage: serverPendingMessage,
      });
    }),
  );
});

const makeSetMonitorChannelSubCommand = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("monitor_channel")
        .setDescription("Set the channel for monitor check-ins and automatic summaries")
        .addChannelOption((builder) =>
          builder
            .setName("channel")
            .setDescription("The monitor channel")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        )
        .addStringOption((builder) =>
          builder.setName("server_id").setDescription("The server id to configure"),
        ),
    Effect.fn("server.set.monitor_channel")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();
      const requestedServerId = command.optionValueOptional("server_id");
      const monitorConversationId = yield* requireResolvedId(
        command.optionChannelValue("channel"),
        "monitor channel",
      );
      const guildId = yield* resolveGuildId(requestedServerId);
      const workspaceId = yield* decodeWorkflowWorkspaceId(guildId);

      yield* enqueueSheetWorkflow({
        response,
        operation: "the server monitor channel update",
        workspaceId,
        capabilityStore,
        makeInput: (responseReference): WorkspacesUpdateConfigAndDeliverInput => ({
          workspaceId,
          responseReference,
          patch: { monitorConversationId },
        }),
        enqueue: (input, options) =>
          enqueueWorkspacesUpdateConfigAndDeliverWorkflow(workflowClient, input, options),
        rejectedMessage: serverRejectedMessage,
        unauthorizedMessage: serverUnauthorizedMessage,
        pendingMessage: serverPendingMessage,
      });
    }),
  );
});

const makeSetCommandGroup = Effect.gen(function* () {
  const setSheetSubCommand = yield* makeSetSheetSubCommand;
  const setAutoCheckinSubCommand = yield* makeSetAutoCheckinSubCommand;
  const setMonitorChannelSubCommand = yield* makeSetMonitorChannelSubCommand;

  return yield* CommandHelper.makeSubCommandGroup(
    (builder) =>
      builder
        .setName("set")
        .setDescription("Set the config of the server")
        .addSubcommand(() => setSheetSubCommand.data)
        .addSubcommand(() => setAutoCheckinSubCommand.data)
        .addSubcommand(() => setMonitorChannelSubCommand.data),
    (command) =>
      command.subCommands({
        sheet: setSheetSubCommand.handler,
        auto_checkin: setAutoCheckinSubCommand.handler,
        monitor_channel: setMonitorChannelSubCommand.handler,
      }),
  );
});

const makeUnsetMonitorChannelSubCommand = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("monitor_channel")
        .setDescription("Unset the channel for monitor check-ins and automatic summaries")
        .addStringOption((builder) =>
          builder.setName("server_id").setDescription("The server id to configure"),
        ),
    Effect.fn("server.unset.monitor_channel")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();
      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const workspaceId = yield* decodeWorkflowWorkspaceId(guildId);

      yield* enqueueSheetWorkflow({
        response,
        operation: "the server monitor channel update",
        workspaceId,
        capabilityStore,
        makeInput: (responseReference): WorkspacesUpdateConfigAndDeliverInput => ({
          workspaceId,
          responseReference,
          patch: { monitorConversationId: null },
        }),
        enqueue: (input, options) =>
          enqueueWorkspacesUpdateConfigAndDeliverWorkflow(workflowClient, input, options),
        rejectedMessage: serverRejectedMessage,
        unauthorizedMessage: serverUnauthorizedMessage,
        pendingMessage: serverPendingMessage,
      });
    }),
  );
});

const makeUnsetCommandGroup = Effect.gen(function* () {
  const unsetMonitorChannelSubCommand = yield* makeUnsetMonitorChannelSubCommand;

  return yield* CommandHelper.makeSubCommandGroup(
    (builder) =>
      builder
        .setName("unset")
        .setDescription("Unset server config")
        .addSubcommand(() => unsetMonitorChannelSubCommand.data),
    (command) =>
      command.subCommands({
        monitor_channel: unsetMonitorChannelSubCommand.handler,
      }),
  );
});

const makeServerCommand = Effect.gen(function* () {
  const listConfigSubCommand = yield* makeListConfigSubCommand;
  const addCommandGroup = yield* makeAddCommandGroup;
  const removeCommandGroup = yield* makeRemoveCommandGroup;
  const setCommandGroup = yield* makeSetCommandGroup;
  const unsetCommandGroup = yield* makeUnsetCommandGroup;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("server")
        .setDescription("Server commands")
        .addSubcommand(() => listConfigSubCommand.data)
        .addSubcommandGroup(() => addCommandGroup.data)
        .addSubcommandGroup(() => removeCommandGroup.data)
        .addSubcommandGroup(() => setCommandGroup.data)
        .addSubcommandGroup(() => unsetCommandGroup.data)
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
        unset: unsetCommandGroup.handler,
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
    Layer.mergeAll(
      discordGatewayLayer,
      discordApplicationLayer,
      SheetWorkflowHttpClient.layer,
      BotCapabilityStore.layer.pipe(Layer.provide(prefixedUnstorageLayer)),
    ),
  ),
);
