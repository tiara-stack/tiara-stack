import { ApplicationIntegrationType, InteractionContextType } from "discord-api-types/v10";
import { Effect, Layer, Option } from "effect";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { prefixedUnstorageLayer } from "../discord/cache";
import {
  BotCapabilityStore,
  enqueueConversationsDeliverConfigWorkflow,
  enqueueConversationsSetLockdownWorkflow,
  enqueueConversationsUpdateConfigAndDeliverWorkflow,
  SheetWorkflowHttpClient,
  type ConversationsDeliverConfigInput,
  type ConversationsSetLockdownInput,
  type ConversationsUpdateConfigAndDeliverInput,
} from "../services";
import {
  decodeWorkflowWorkspaceId,
  optionalPayloadField,
  requireBoolean,
  requireResolvedId,
  requireString,
  resolveChannelId,
  resolveGuildId,
  serverIdOption,
} from "../utils/commandHelpers";
import { registerGlobalCommandLayer } from "../utils/registerGlobalCommandLayer";
import { enqueueSheetWorkflow } from "../utils/sheetWorkflowMigration";

const optionalDecodedField = <const Key extends string, Value>(
  key: Key,
  value: Option.Option<unknown>,
  decode: (value: unknown) => Effect.Effect<Value, Error>,
) =>
  Option.match(value, {
    onSome: (optionValue) => Effect.map(decode(optionValue), (decoded) => ({ [key]: decoded })),
    onNone: () => Effect.succeed({}),
  }) as Effect.Effect<Partial<Record<Key, Value>>, Error>;

const optionalNullUnsetField = <const Key extends string>(
  key: Key,
  value: Option.Option<unknown>,
) =>
  optionalPayloadField(
    key,
    Option.map(value, () => null),
  );

const channelRejectedMessage =
  "I couldn't complete the channel configuration request. Please try again.";
const channelUnauthorizedMessage = "You aren't allowed to manage that channel.";
const channelPendingMessage =
  "The channel configuration request is still processing. I'll update this message when it finishes.";

const resolveChannelCommandPayloadBase = (
  serverId: Option.Option<string>,
  channel: Option.Option<unknown>,
) =>
  Effect.gen(function* () {
    const workspaceId = yield* resolveGuildId(serverId);
    const workflowWorkspace = yield* decodeWorkflowWorkspaceId(workspaceId);
    const conversationId = yield* resolveChannelId(channel);

    return { workspaceId: workflowWorkspace, conversationId };
  });

const makeListConfigSubCommand = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("list_config")
        .setDescription("List the config for the channel")
        .addChannelOption((builder) =>
          builder.setName("channel").setDescription("The channel to list the config for"),
        )
        .addStringOption(serverIdOption("The server id to list the config for")),
    Effect.fn("channel.list_config")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      const payloadBase = yield* resolveChannelCommandPayloadBase(
        command.optionValueOptional("server_id"),
        command.optionChannelValueOptional("channel"),
      );

      yield* enqueueSheetWorkflow({
        response,
        operation: "the channel config list",
        workspaceId: payloadBase.workspaceId,
        capabilityStore,
        makeInput: (responseReference): ConversationsDeliverConfigInput => ({
          workspaceId: payloadBase.workspaceId,
          conversationId: payloadBase.conversationId,
          responseReference,
        }),
        enqueue: (input, options) =>
          enqueueConversationsDeliverConfigWorkflow(workflowClient, input, options),
        rejectedMessage: channelRejectedMessage,
        unauthorizedMessage: channelUnauthorizedMessage,
        pendingMessage: channelPendingMessage,
      });
    }),
  );
});

const makeSetSubCommand = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

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
        .addStringOption(serverIdOption("The server id to set the config for")),
    Effect.fn("channel.set")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      const payloadBase = yield* resolveChannelCommandPayloadBase(
        command.optionValueOptional("server_id"),
        command.optionChannelValueOptional("channel"),
      );
      const runningPayload = yield* optionalDecodedField(
        "running",
        command.optionValueOptional("running"),
        (value) => requireBoolean(value, "running"),
      );
      const namePayload = yield* optionalDecodedField(
        "name",
        command.optionValueOptional("name"),
        (value) => requireString(value, "name"),
      );
      const rolePayload = yield* optionalDecodedField(
        "roleId",
        command.optionRoleValueOptional("role"),
        (value) => requireResolvedId(value, "role"),
      );
      const checkinChannelPayload = yield* optionalDecodedField(
        "checkinConversationId",
        command.optionChannelValueOptional("checkin_channel"),
        (value) => requireResolvedId(value, "check-in channel"),
      );
      yield* enqueueSheetWorkflow({
        response,
        operation: "the channel config update",
        workspaceId: payloadBase.workspaceId,
        capabilityStore,
        makeInput: (responseReference): ConversationsUpdateConfigAndDeliverInput => ({
          workspaceId: payloadBase.workspaceId,
          conversationId: payloadBase.conversationId,
          responseReference,
          patch: {
            ...runningPayload,
            ...namePayload,
            ...rolePayload,
            ...checkinChannelPayload,
          },
        }),
        enqueue: (input, options) =>
          enqueueConversationsUpdateConfigAndDeliverWorkflow(workflowClient, input, options),
        rejectedMessage: channelRejectedMessage,
        unauthorizedMessage: channelUnauthorizedMessage,
        pendingMessage: channelPendingMessage,
      });
    }),
  );
});

const makeUnsetSubCommand = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

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
        .addStringOption(serverIdOption("The server id to unset the config for")),
    Effect.fn("channel.unset")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      const payloadBase = yield* resolveChannelCommandPayloadBase(
        command.optionValueOptional("server_id"),
        command.optionChannelValueOptional("channel"),
      );

      yield* enqueueSheetWorkflow({
        response,
        operation: "the channel config update",
        workspaceId: payloadBase.workspaceId,
        capabilityStore,
        makeInput: (responseReference): ConversationsUpdateConfigAndDeliverInput => ({
          workspaceId: payloadBase.workspaceId,
          conversationId: payloadBase.conversationId,
          responseReference,
          patch: {
            ...optionalNullUnsetField("running", command.optionValueOptional("running")),
            ...optionalNullUnsetField("name", command.optionValueOptional("name")),
            ...optionalNullUnsetField("roleId", command.optionValueOptional("role")),
            ...optionalNullUnsetField(
              "checkinConversationId",
              command.optionValueOptional("checkin_channel"),
            ),
          },
        }),
        enqueue: (input, options) =>
          enqueueConversationsUpdateConfigAndDeliverWorkflow(workflowClient, input, options),
        rejectedMessage: channelRejectedMessage,
        unauthorizedMessage: channelUnauthorizedMessage,
        pendingMessage: channelPendingMessage,
      });
    }),
  );
});

const makeLockdownSubCommand = (operation: "setup" | "undo") =>
  Effect.gen(function* () {
    const workflowClient = yield* SheetWorkflowHttpClient;
    const capabilityStore = yield* BotCapabilityStore;
    const commandName = operation === "setup" ? "lockdown_setup" : "lockdown_undo";

    return yield* CommandHelper.makeSubCommand(
      (builder) =>
        builder
          .setName(commandName)
          .setDescription(
            operation === "setup"
              ? "Set up lockdown permissions for a channel"
              : "Remove all permission overwrites from a channel",
          )
          .addChannelOption((builder) =>
            builder.setName("channel").setDescription("The channel to update").setRequired(true),
          ),
      Effect.fn(`channel.${commandName}`)(function* (command) {
        const response = yield* InteractionResponse;
        yield* response.deferReply();
        const payload = yield* resolveChannelCommandPayloadBase(
          Option.none(),
          command.optionChannelValueOptional("channel"),
        );
        yield* enqueueSheetWorkflow({
          response,
          operation: `the channel lockdown ${operation}`,
          workspaceId: payload.workspaceId,
          capabilityStore,
          makeInput: (responseReference): ConversationsSetLockdownInput => ({
            workspaceId: payload.workspaceId,
            conversationId: payload.conversationId,
            enabled: operation === "setup",
            responseReference,
          }),
          enqueue: (input, options) =>
            enqueueConversationsSetLockdownWorkflow(workflowClient, input, options),
          rejectedMessage: channelRejectedMessage,
          unauthorizedMessage: channelUnauthorizedMessage,
          pendingMessage: channelPendingMessage,
        });
      }),
    );
  });

const makeLockdownSetupSubCommand = makeLockdownSubCommand("setup");

const makeLockdownUndoSubCommand = makeLockdownSubCommand("undo");

const makeChannelCommand = Effect.gen(function* () {
  const listConfigSubCommand = yield* makeListConfigSubCommand;
  const setSubCommand = yield* makeSetSubCommand;
  const unsetSubCommand = yield* makeUnsetSubCommand;
  const lockdownSetupSubCommand = yield* makeLockdownSetupSubCommand;
  const lockdownUndoSubCommand = yield* makeLockdownUndoSubCommand;

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
        .addSubcommand(() => unsetSubCommand.data)
        .addSubcommand(() => lockdownSetupSubCommand.data)
        .addSubcommand(() => lockdownUndoSubCommand.data),
    (command) =>
      command.subCommands({
        list_config: listConfigSubCommand.handler,
        set: setSubCommand.handler,
        unset: unsetSubCommand.handler,
        lockdown_setup: lockdownSetupSubCommand.handler,
        lockdown_undo: lockdownUndoSubCommand.handler,
      }),
  );
});

export const channelCommandLayer = registerGlobalCommandLayer(makeChannelCommand).pipe(
  Layer.provide(
    Layer.mergeAll(
      SheetWorkflowHttpClient.layer,
      BotCapabilityStore.layer.pipe(Layer.provide(prefixedUnstorageLayer)),
    ),
  ),
);
