import { Duration, Effect, Layer, Match, Option, Schema, pipe } from "effect";
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
  InteractionToken,
  type CommandInteractionResponseContext,
} from "dfx-discord-utils/utils";
import { config } from "../config";
import { prefixedUnstorageLayer } from "../discord/cache";
import {
  BotCapabilityStore,
  enqueueCheckinsOpenWorkflow,
  enqueueCheckinsTestAutoWorkflow,
  SheetWorkflowHttpClient,
  SheetWorkflowHttpRequestContext,
  SheetWorkflowsClient,
  SheetWorkflowsRequestContext,
  type BotCapabilityStoreShape,
  type CheckinsOpenInput,
  type CheckinsTestAutoInput,
  type SheetWorkflowHttpClientShape,
  type SheetWorkflowsClientShape,
} from "../services";
import { discordApplicationLayer } from "../discord/application";
import { makeDispatchBase, resolveChannelId, resolveGuildId } from "../utils/commandHelpers";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";
import { interactionDeadlineEpochMs } from "../utils/interactionDeadline";
import { makeWorkflowInvocationId } from "sheet-workflow-http-client";
import {
  isWorkflowTransportUnavailable,
  reportAmbiguousWorkflowEnqueueOutcome,
  reportDefinitiveWorkflowEnqueueFailure,
} from "../utils/workflowEnqueueOutcome";

const checkinRolloutGateEvaluationTimeout = Duration.seconds(5);
type CheckinWorkflowInput = Omit<CheckinsOpenInput, "responseReference">;
type CheckinTestAutoWorkflowInput = Omit<CheckinsTestAutoInput, "responseReference">;
type CheckinRolloutGateDecision = Effect.Success<
  ReturnType<SheetWorkflowHttpClientShape["evaluateCheckinsOpenRolloutGate"]>
>;
type CheckinTestAutoRolloutGateDecision = Effect.Success<
  ReturnType<SheetWorkflowHttpClientShape["evaluateCheckinsTestAutoRolloutGate"]>
>;

const checkinGateUnavailableDecision: CheckinRolloutGateDecision = {
  gateKey: "unavailable",
  revision: 0,
  matched: false,
  executionPath: "legacy",
  reason: "control-unavailable",
};

const checkinTestAutoGateUnavailableDecision: CheckinTestAutoRolloutGateDecision =
  checkinGateUnavailableDecision;

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

// The check-in and slot command adapters intentionally keep parallel response-reference shapes.
// fallow-ignore-next-line code-duplication
export const makeCheckinResponseReferenceInput = ({
  applicationId,
  clientId,
  interactionId,
  interactionToken,
  workspaceId,
}: {
  readonly applicationId: string;
  readonly clientId: string;
  readonly interactionId: string;
  readonly interactionToken: string;
  readonly workspaceId?: string;
}) => ({
  applicationId,
  client: { platform: "discord" as const, clientId },
  interactionToken,
  permittedOperations: ["respond" as const],
  expiresAt: interactionDeadlineEpochMs(interactionId),
  ...(workspaceId === undefined ? {} : { workspaceId }),
});

const issueCheckinResponseReference = (
  capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">,
  workspaceId?: string,
) =>
  Effect.gen(function* () {
    const interactionToken = yield* InteractionToken;
    const interaction = yield* Ix.Interaction;
    const clientId = yield* config.sheetBotClientId;

    return yield* capabilityStore.issueResponseReference(
      // The interaction-specific response-reference issuer mirrors the slot adapter by design.
      // fallow-ignore-next-line code-duplication
      makeCheckinResponseReferenceInput({
        applicationId: interactionToken.applicationId,
        clientId,
        interactionId: interaction.id,
        interactionToken: interactionToken.token,
        ...(workspaceId === undefined ? {} : { workspaceId }),
      }),
    );
  });

const dispatchLegacyCheckin = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  input: CheckinWorkflowInput,
) =>
  runSheetWorkflowsDispatch(
    response,
    "the check-in",
    SheetWorkflowsRequestContext.asInteractionUser(
      Effect.fn("checkin.dispatchLegacyPath")(function* () {
        const base = yield* makeDispatchBase;
        return yield* sheetWorkflowsClient.get().dispatch.checkin({
          payload: { ...base, ...input },
        });
      }),
    )(),
  ).pipe(
    Effect.catch((error) =>
      reportDefinitiveWorkflowEnqueueFailure(response, error, {
        rejectedMessage: checkinEnqueueRejectedMessage,
        unauthorizedMessage: checkinEnqueueUnauthorizedMessage,
        operation: "check-in",
      }),
    ),
  );

const dispatchLegacyCheckinTestAuto = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  input: CheckinTestAutoWorkflowInput,
) =>
  runSheetWorkflowsDispatch(
    response,
    "the auto check-in test",
    SheetWorkflowsRequestContext.asInteractionUser(
      Effect.fn("checkin.testAutoDispatchLegacyPath")(function* () {
        const base = yield* makeDispatchBase;
        return yield* sheetWorkflowsClient.get().dispatch.autoCheckinTest({
          payload: { ...base, ...input },
        });
      }),
    )(),
  ).pipe(
    Effect.catch((error) =>
      reportDefinitiveWorkflowEnqueueFailure(response, error, {
        rejectedMessage: checkinTestAutoEnqueueRejectedMessage,
        unauthorizedMessage: checkinTestAutoEnqueueUnauthorizedMessage,
        operation: "auto check-in test",
      }),
    ),
  );

export const enqueueCheckin = Effect.fn("checkin.enqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<
    SheetWorkflowHttpClientShape,
    "enqueueCheckinsOpen" | "evaluateCheckinsOpenRolloutGate"
  >,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">,
  input: CheckinWorkflowInput,
) {
  const invocationId = yield* makeWorkflowInvocationId();
  const clientId = yield* config.sheetBotClientId;
  const decision = yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
    workflowClient.evaluateCheckinsOpenRolloutGate({
      contractIdentity: "checkins.open",
      contractWireVersion: "1",
      client: { platform: "discord", clientId },
      invocationId,
      workspaceId: input.workspaceId,
    }),
  )().pipe(
    Effect.timeout(checkinRolloutGateEvaluationTimeout),
    Effect.catch((error) =>
      Effect.logWarning("Rollout Gate Control could not be evaluated; using legacy path", {
        error,
        invocationId,
      }).pipe(Effect.as(checkinGateUnavailableDecision)),
    ),
  );

  yield* Match.value(decision.executionPath).pipe(
    Match.when("legacy", () => dispatchLegacyCheckin(response, sheetWorkflowsClient, input)),
    Match.when("replacement", () =>
      Effect.gen(function* () {
        const responseReference = yield* issueCheckinResponseReference(
          capabilityStore,
          input.workspaceId,
        );

        yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
          enqueueCheckinsOpenWorkflow(
            workflowClient,
            { ...input, responseReference },
            { invocationId },
          ),
        )();
      }).pipe(
        Effect.catch((error) =>
          isWorkflowTransportUnavailable(error)
            ? reportAmbiguousWorkflowEnqueueOutcome(response, error, {
                pendingMessage: checkinEnqueuePendingMessage,
                operation: "check-in",
              })
            : reportDefinitiveWorkflowEnqueueFailure(response, error, {
                rejectedMessage: checkinEnqueueRejectedMessage,
                unauthorizedMessage: checkinEnqueueUnauthorizedMessage,
                operation: "check-in",
              }),
        ),
      ),
    ),
    Match.exhaustive,
  );
});

export const enqueueCheckinTestAuto = Effect.fn("checkin.testAutoEnqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<
    SheetWorkflowHttpClientShape,
    "enqueueCheckinsTestAuto" | "evaluateCheckinsTestAutoRolloutGate"
  >,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">,
  input: CheckinTestAutoWorkflowInput,
) {
  const invocationId = yield* makeWorkflowInvocationId();
  const clientId = yield* config.sheetBotClientId;
  const decision = yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
    workflowClient.evaluateCheckinsTestAutoRolloutGate({
      contractIdentity: "checkins.testAuto",
      contractWireVersion: "1",
      client: { platform: "discord", clientId },
      invocationId,
      workspaceId: input.workspaceId,
    }),
  )().pipe(
    Effect.timeout(checkinRolloutGateEvaluationTimeout),
    Effect.catch((error) =>
      Effect.logWarning("Rollout Gate Control could not be evaluated; using legacy path", {
        error,
        invocationId,
      }).pipe(Effect.as(checkinTestAutoGateUnavailableDecision)),
    ),
  );

  yield* Match.value(decision.executionPath).pipe(
    Match.when("legacy", () =>
      dispatchLegacyCheckinTestAuto(response, sheetWorkflowsClient, input),
    ),
    Match.when("replacement", () =>
      Effect.gen(function* () {
        const responseReference = yield* issueCheckinResponseReference(
          capabilityStore,
          input.workspaceId,
        );

        yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
          enqueueCheckinsTestAutoWorkflow(
            workflowClient,
            { ...input, responseReference },
            { invocationId },
          ),
        )();
      }).pipe(
        Effect.catch((error) =>
          isWorkflowTransportUnavailable(error)
            ? reportAmbiguousWorkflowEnqueueOutcome(response, error, {
                pendingMessage: checkinTestAutoEnqueuePendingMessage,
                operation: "auto check-in test",
              })
            : reportDefinitiveWorkflowEnqueueFailure(response, error, {
                rejectedMessage: checkinTestAutoEnqueueRejectedMessage,
                unauthorizedMessage: checkinTestAutoEnqueueUnauthorizedMessage,
                operation: "auto check-in test",
              }),
        ),
      ),
    ),
    Match.exhaustive,
  );
});

const makeManualSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;
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
      yield* enqueueCheckin(response, workflowClient, sheetWorkflowsClient, capabilityStore, {
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
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

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
      const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(guildId);
      const anchorChannelId = yield* resolveChannelId(Option.none());

      yield* enqueueCheckinTestAuto(
        response,
        workflowClient,
        sheetWorkflowsClient,
        capabilityStore,
        { workspaceId, anchorConversationId: anchorChannelId },
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
    Layer.mergeAll(
      discordGatewayLayer,
      discordApplicationLayer,
      SheetWorkflowHttpClient.layer,
      SheetWorkflowsClient.layer,
      BotCapabilityStore.layer.pipe(Layer.provide(prefixedUnstorageLayer)),
    ),
  ),
);
