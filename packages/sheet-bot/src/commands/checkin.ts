import { Effect, Layer, Option, Schema, pipe } from "effect";
import { Ix } from "dfx/index";
import { InteractionsRegistry } from "dfx/gateway";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord-api-types/v10";
import { WorkspaceId } from "sheet-workflow-contracts/values";
import { discordGatewayLayer } from "../discord/gateway";
import {
  CommandHelper,
  InteractionResponse,
  type CommandInteractionResponseContext,
} from "dfx-discord-utils/utils";
import { prefixedUnstorageLayer } from "../discord/cache";
import {
  BotCapabilityStore,
  enqueueCheckinsOpenWorkflow,
  enqueueCheckinsTestAutoWorkflow,
  SheetWorkflowHttpClient,
  type BotCapabilityStoreShape,
  type CheckinsOpenInput,
  type CheckinsTestAutoInput,
  type SheetWorkflowHttpClientShape,
} from "../services";
import { discordApplicationLayer } from "../discord/application";
import {
  makeResponseReferenceInput,
  resolveChannelId,
  resolveGuildId,
} from "../utils/commandHelpers";
import { enqueueSheetWorkflow } from "../utils/sheetWorkflowMigration";

type CheckinWorkflowInput = Omit<CheckinsOpenInput, "responseReference">;
type CheckinTestAutoWorkflowInput = Omit<CheckinsTestAutoInput, "responseReference">;

const checkinEnqueueRejectedMessage = "I couldn't start the check-in. Please try again.";
const checkinEnqueueUnauthorizedMessage =
  "You aren't allowed to start a check-in for that workspace.";
const checkinTestAutoEnqueueRejectedMessage =
  "I couldn't start the auto check-in test. Please try again.";
const checkinTestAutoEnqueueUnauthorizedMessage =
  "You aren't allowed to test auto check-in for that workspace.";
const checkinEnqueuePendingMessage =
  "The check-in is still processing. I'll update this message when it finishes.";
const checkinTestAutoEnqueuePendingMessage =
  "The auto check-in test is still processing. I'll update this message when it finishes.";

export const makeCheckinResponseReferenceInput = makeResponseReferenceInput;

export const enqueueCheckin = Effect.fn("checkin.enqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<SheetWorkflowHttpClientShape, "enqueueCheckinsOpen">,
  capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">,
  input: CheckinWorkflowInput,
) {
  yield* enqueueSheetWorkflow({
    response,
    operation: "check-in",
    workspaceId: input.workspaceId,
    capabilityStore,
    makeInput: (responseReference) => ({ ...input, responseReference }),
    enqueue: (workflowInput, options) =>
      enqueueCheckinsOpenWorkflow(workflowClient, workflowInput, options),
    rejectedMessage: checkinEnqueueRejectedMessage,
    unauthorizedMessage: checkinEnqueueUnauthorizedMessage,
    pendingMessage: checkinEnqueuePendingMessage,
  });
});

export const enqueueCheckinTestAuto = Effect.fn("checkin.testAutoEnqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<SheetWorkflowHttpClientShape, "enqueueCheckinsTestAuto">,
  capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">,
  input: CheckinTestAutoWorkflowInput,
) {
  yield* enqueueSheetWorkflow({
    response,
    operation: "auto check-in test",
    workspaceId: input.workspaceId,
    capabilityStore,
    makeInput: (responseReference) => ({ ...input, responseReference }),
    enqueue: (workflowInput, options) =>
      enqueueCheckinsTestAutoWorkflow(workflowClient, workflowInput, options),
    rejectedMessage: checkinTestAutoEnqueueRejectedMessage,
    unauthorizedMessage: checkinTestAutoEnqueueUnauthorizedMessage,
    pendingMessage: checkinTestAutoEnqueuePendingMessage,
  });
});

const makeManualSubCommand = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

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
    // The manual check-in command retains the shared interaction setup shape used by schedule.list.
    // fallow-ignore-next-line code-duplication
    Effect.fn("checkin.manual")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply({ flags: MessageFlags.Ephemeral });

      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(guildId);
      const templateOption = command.optionValueOptional("template");

      const channelNameOption = command.optionValueOptional("channel_name");
      const interactionChannelId = Option.isSome(channelNameOption)
        ? undefined
        : yield* resolveChannelId(Option.none());
      yield* enqueueCheckin(response, workflowClient, capabilityStore, {
        workspaceId,
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
      });
    }),
  );
});

const makeTestAutoSubCommand = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("test_auto")
        .setDescription("Test automatic check-in configuration")
        .addStringOption((option) =>
          option.setName("server_id").setDescription("The server to test auto check-in for"),
        )
        .addNumberOption((option) =>
          option.setName("hour").setDescription("The hour to test automatic check-in for"),
        ),
    Effect.fn("checkin.test_auto")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply({});

      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(guildId);
      const anchorChannelId = yield* resolveChannelId(Option.none());

      yield* enqueueCheckinTestAuto(response, workflowClient, capabilityStore, {
        workspaceId,
        anchorConversationId: anchorChannelId,
        ...pipe(
          command.optionValueOptional("hour"),
          Option.match({
            onSome: (hour) => ({ hour }),
            onNone: () => ({}),
          }),
        ),
      });
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
    Layer.mergeAll(
      discordGatewayLayer,
      discordApplicationLayer,
      SheetWorkflowHttpClient.layer,
      BotCapabilityStore.layer.pipe(Layer.provide(prefixedUnstorageLayer)),
    ),
  ),
);
