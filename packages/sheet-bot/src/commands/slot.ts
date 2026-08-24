import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { Duration, Effect, Layer, Match, Option, Predicate, Schema } from "effect";
import { WorkspaceId } from "sheet-workflow-contracts/values";
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
  enqueueSlotsDeliverListWorkflow,
  enqueueSlotsPublishButtonWorkflow,
  SheetWorkflowHttpClient,
  SheetWorkflowHttpRequestContext,
  SheetWorkflowsClient,
  SheetWorkflowsRequestContext,
  type BotCapabilityStoreShape,
  type SheetWorkflowHttpClientShape,
  type SheetWorkflowsClientShape,
  type SlotsDeliverListInput,
  type SlotsPublishButtonInput,
} from "../services";
import {
  makeDispatchBase,
  requiredDayOption,
  resolveChannelId,
  resolveGuildId,
  serverIdOption,
} from "../utils/commandHelpers";
import { interactionDeadlineEpochMs } from "../utils/interactionDeadline";
import { registerGlobalCommandLayer } from "../utils/registerGlobalCommandLayer";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";
import { makeWorkflowInvocationId } from "sheet-workflow-http-client";

const slotRolloutGateEvaluationTimeout = Duration.seconds(5);
type SlotListWorkflowInput = Omit<SlotsDeliverListInput, "responseReference">;
type SlotPublishButtonWorkflowInput = Omit<SlotsPublishButtonInput, "responseReference">;
type SlotListRolloutGateDecision = Effect.Success<
  ReturnType<SheetWorkflowHttpClientShape["evaluateSlotsDeliverListRolloutGate"]>
>;
type SlotPublishButtonRolloutGateDecision = Effect.Success<
  ReturnType<SheetWorkflowHttpClientShape["evaluateSlotsPublishButtonRolloutGate"]>
>;

const slotListGateUnavailableDecision: SlotListRolloutGateDecision = {
  gateKey: "unavailable",
  revision: 0,
  matched: false,
  executionPath: "legacy",
  reason: "control-unavailable",
};

const slotPublishButtonGateUnavailableDecision: SlotPublishButtonRolloutGateDecision =
  slotListGateUnavailableDecision;

const slotListEnqueueRejectedMessage = "I couldn't start the slot list. Please try again.";
const slotListEnqueueUnauthorizedMessage = "You aren't allowed to view slots in that workspace.";
const slotPublishButtonEnqueueRejectedMessage =
  "I couldn't publish the slot button. Please try again.";
const slotPublishButtonEnqueueUnauthorizedMessage =
  "You aren't allowed to publish a slot button in that workspace.";
const slotEnqueuePendingMessage =
  "The slot request is still processing. I'll update this message when it finishes.";

// The check-in and slot command adapters intentionally keep parallel response-reference shapes.
// fallow-ignore-next-line code-duplication
export const makeSlotResponseReferenceInput = ({
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

const issueSlotResponseReference = (
  capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">,
  workspaceId?: string,
) =>
  Effect.gen(function* () {
    const interactionToken = yield* InteractionToken;
    const interaction = yield* Ix.Interaction;
    const clientId = yield* config.sheetBotClientId;

    return yield* capabilityStore.issueResponseReference(
      // The interaction-specific response-reference issuer mirrors the check-in adapter by design.
      // fallow-ignore-next-line code-duplication
      makeSlotResponseReferenceInput({
        applicationId: interactionToken.applicationId,
        clientId,
        interactionId: interaction.id,
        interactionToken: interactionToken.token,
        ...(workspaceId === undefined ? {} : { workspaceId }),
      }),
    );
  });

const reportDefinitiveEnqueueFailure = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  error: unknown,
  rejectedMessage: string,
  unauthorizedMessage: string,
  operation: string,
) =>
  response
    .editReply({
      payload: {
        content: Predicate.isTagged("WorkflowInvocationUnauthorized")(error)
          ? unauthorizedMessage
          : rejectedMessage,
      },
    })
    .pipe(
      Effect.tap(() =>
        Effect.logWarning(`Sheet-bot ${operation} workflow enqueue was rejected`, { error }),
      ),
    );

const isTransportUnavailable = (error: unknown) =>
  Predicate.isTagged("WorkflowTransportUnavailable")(error);

const dispatchLegacySlotList = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  input: SlotListWorkflowInput,
) =>
  runSheetWorkflowsDispatch(
    response,
    "the slot list",
    SheetWorkflowsRequestContext.asInteractionUser(
      Effect.fn("slot.dispatchLegacyPath")(function* () {
        const base = yield* makeDispatchBase;
        return yield* sheetWorkflowsClient.get().dispatch.slotList({
          payload: { ...base, ...input },
        });
      }),
    )(),
  ).pipe(
    Effect.catch((error) =>
      reportDefinitiveEnqueueFailure(
        response,
        error,
        slotListEnqueueRejectedMessage,
        slotListEnqueueUnauthorizedMessage,
        "slot list",
      ),
    ),
  );

const dispatchLegacySlotButton = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  input: SlotPublishButtonWorkflowInput,
) =>
  runSheetWorkflowsDispatch(
    response,
    "the slot button",
    SheetWorkflowsRequestContext.asInteractionUser(
      Effect.fn("slot.buttonDispatchLegacyPath")(function* () {
        const base = yield* makeDispatchBase;
        return yield* sheetWorkflowsClient.get().dispatch.slotButton({
          payload: { ...base, ...input },
        });
      }),
    )(),
  ).pipe(
    Effect.catch((error) =>
      reportDefinitiveEnqueueFailure(
        response,
        error,
        slotPublishButtonEnqueueRejectedMessage,
        slotPublishButtonEnqueueUnauthorizedMessage,
        "slot button",
      ),
    ),
  );

export const enqueueSlotList = Effect.fn("slot.enqueueListWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<
    SheetWorkflowHttpClientShape,
    "enqueueSlotsDeliverList" | "evaluateSlotsDeliverListRolloutGate"
  >,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">,
  input: SlotListWorkflowInput,
) {
  const invocationId = yield* makeWorkflowInvocationId();
  const clientId = yield* config.sheetBotClientId;
  const decision = yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
    workflowClient.evaluateSlotsDeliverListRolloutGate({
      contractIdentity: "slots.deliverList",
      contractWireVersion: "1",
      client: { platform: "discord", clientId },
      invocationId,
      workspaceId: input.workspaceId,
    }),
  )().pipe(
    Effect.timeout(slotRolloutGateEvaluationTimeout),
    Effect.catch((error) =>
      Effect.logWarning("Rollout Gate Control could not be evaluated; using legacy path", {
        error,
        invocationId,
      }).pipe(Effect.as(slotListGateUnavailableDecision)),
    ),
  );

  yield* Match.value(decision.executionPath).pipe(
    Match.when("legacy", () => dispatchLegacySlotList(response, sheetWorkflowsClient, input)),
    Match.when("replacement", () =>
      Effect.gen(function* () {
        const responseReference = yield* issueSlotResponseReference(
          capabilityStore,
          input.workspaceId,
        );

        yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
          enqueueSlotsDeliverListWorkflow(
            workflowClient,
            { ...input, responseReference },
            { invocationId },
          ),
        )();
      }).pipe(
        Effect.catch((error) =>
          isTransportUnavailable(error)
            ? Effect.gen(function* () {
                yield* Effect.logWarning(
                  "Sheet-bot slot-list workflow enqueue outcome is ambiguous",
                  { error },
                );
                yield* response.editReply({
                  payload: { content: slotEnqueuePendingMessage },
                });
              })
            : reportDefinitiveEnqueueFailure(
                response,
                error,
                slotListEnqueueRejectedMessage,
                slotListEnqueueUnauthorizedMessage,
                "slot list",
              ),
        ),
      ),
    ),
    Match.exhaustive,
  );
});

export const enqueueSlotButton = Effect.fn("slot.enqueueButtonWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<
    SheetWorkflowHttpClientShape,
    "enqueueSlotsPublishButton" | "evaluateSlotsPublishButtonRolloutGate"
  >,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">,
  input: SlotPublishButtonWorkflowInput,
) {
  const invocationId = yield* makeWorkflowInvocationId();
  const clientId = yield* config.sheetBotClientId;
  const decision = yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
    workflowClient.evaluateSlotsPublishButtonRolloutGate({
      contractIdentity: "slots.publishButton",
      contractWireVersion: "1",
      client: { platform: "discord", clientId },
      invocationId,
      workspaceId: input.workspaceId,
    }),
  )().pipe(
    Effect.timeout(slotRolloutGateEvaluationTimeout),
    Effect.catch((error) =>
      Effect.logWarning("Rollout Gate Control could not be evaluated; using legacy path", {
        error,
        invocationId,
      }).pipe(Effect.as(slotPublishButtonGateUnavailableDecision)),
    ),
  );

  yield* Match.value(decision.executionPath).pipe(
    Match.when("legacy", () => dispatchLegacySlotButton(response, sheetWorkflowsClient, input)),
    Match.when("replacement", () =>
      Effect.gen(function* () {
        const responseReference = yield* issueSlotResponseReference(
          capabilityStore,
          input.workspaceId,
        );

        yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
          enqueueSlotsPublishButtonWorkflow(
            workflowClient,
            { ...input, responseReference },
            { invocationId },
          ),
        )();
      }).pipe(
        Effect.catch((error) =>
          isTransportUnavailable(error)
            ? Effect.gen(function* () {
                yield* Effect.logWarning(
                  "Sheet-bot slot-button workflow enqueue outcome is ambiguous",
                  { error },
                );
                yield* response.editReply({
                  payload: { content: slotEnqueuePendingMessage },
                });
              })
            : reportDefinitiveEnqueueFailure(
                response,
                error,
                slotPublishButtonEnqueueRejectedMessage,
                slotPublishButtonEnqueueUnauthorizedMessage,
                // The slot publish and schedule enqueue branches intentionally share this fallback shell.
                // fallow-ignore-next-line code-duplication
                "slot button",
              ),
        ),
      ),
    ),
    Match.exhaustive,
  );
});

const makeListSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("list")
        .setDescription("Get the open slots for the day")
        .addNumberOption(requiredDayOption("The day to get the slots for"))
        .addStringOption(serverIdOption("The server to get the teams for"))
        .addStringOption((option) =>
          option
            .setName("message_type")
            .setDescription("The type of message to send")
            .addChoices(
              { name: "persistent", value: "persistent" },
              { name: "ephemeral", value: "ephemeral" },
            ),
        ),
    Effect.fn("slot.list")(function* (command) {
      const response = yield* InteractionResponse;
      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(guildId);

      const messageType = yield* Schema.decodeUnknownEffect(
        Schema.Literals(["persistent", "ephemeral"]),
      )(Option.getOrElse(command.optionValueOptional("message_type"), () => "ephemeral"));

      const isEphemeral = messageType === "ephemeral";
      const day = command.optionValue("day");

      yield* response.deferReply({ flags: isEphemeral ? MessageFlags.Ephemeral : undefined });

      yield* enqueueSlotList(response, workflowClient, sheetWorkflowsClient, capabilityStore, {
        workspaceId,
        day,
        messageType,
      });
    }),
  );
});

const makeButtonSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("button")
        .setDescription("Show the button to get the open slots")
        .addNumberOption(requiredDayOption("The day to get the slots for"))
        .addStringOption(serverIdOption("The server to get the teams for")),
    Effect.fn("slot.button")(function* (command) {
      const response = yield* InteractionResponse;
      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(guildId);

      yield* response.deferReply({ flags: MessageFlags.Ephemeral });

      const day = command.optionValue("day");
      const channelId = yield* resolveChannelId(Option.none());
      yield* enqueueSlotButton(response, workflowClient, sheetWorkflowsClient, capabilityStore, {
        workspaceId,
        conversationId: channelId,
        day,
      });
    }),
  );
});

const makeSlotCommand = Effect.gen(function* () {
  const listSubCommand = yield* makeListSubCommand;
  const buttonSubCommand = yield* makeButtonSubCommand;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("slot")
        .setDescription("Day slots commands")
        .setIntegrationTypes(
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        )
        .setContexts(
          InteractionContextType.BotDM,
          InteractionContextType.Guild,
          InteractionContextType.PrivateChannel,
        )
        .addSubcommand(() => listSubCommand.data)
        .addSubcommand(() => buttonSubCommand.data),
    (command) =>
      command.subCommands({
        list: listSubCommand.handler,
        button: buttonSubCommand.handler,
      }),
  );
});

export const slotCommandLayer = registerGlobalCommandLayer(makeSlotCommand).pipe(
  Layer.provide(
    Layer.mergeAll(
      SheetWorkflowHttpClient.layer,
      SheetWorkflowsClient.layer,
      BotCapabilityStore.layer.pipe(Layer.provide(prefixedUnstorageLayer)),
    ),
  ),
);
