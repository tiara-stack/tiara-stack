import { InteractionsRegistry } from "dfx/gateway";
import { Ix } from "dfx/index";
import { ButtonStyle, MessageFlags } from "discord-api-types/v10";
import { Duration, Effect, Layer, Match, Option, pipe, Predicate } from "effect";
import { SLOT_OPEN_ACTION_ID } from "sheet-ingress-api/clientActions";
import { discordGatewayLayer } from "../../discord/gateway";
import { resolveGuildId } from "@/utils/commandHelpers";
import {
  Interaction,
  InteractionToken,
  MessageComponentInteractionResponse,
  makeButton,
  makeButtonData,
  makeMessageComponent,
  type CommandInteractionResponseContext,
} from "dfx-discord-utils/utils";
import { config } from "../../config";
import { prefixedUnstorageLayer } from "../../discord/cache";
import {
  BotCapabilityStore,
  enqueueSlotsOpenWorkflow,
  SheetWorkflowHttpClient,
  SheetWorkflowHttpRequestContext,
  SheetWorkflowsClient,
  SheetWorkflowsRequestContext,
  type BotCapabilityStoreShape,
  type SheetWorkflowHttpClientShape,
  type SheetWorkflowsClientShape,
} from "@/services";
import { discordApplicationLayer } from "../../discord/application";
import { interactionDeadlineEpochMs } from "@/utils/interactionDeadline";
import { runSheetWorkflowsDispatch } from "@/utils/sheetWorkflowsDispatch";
import { makeWorkflowInvocationId } from "sheet-workflow-http-client";

const slotButtonRolloutGateEvaluationTimeout = Duration.seconds(5);
const slotButtonEnqueueRejectedMessage = "I couldn't open those slots. Please try again.";
const slotButtonEnqueueUnauthorizedMessage = "You aren't allowed to open slots from this message.";
const slotButtonEnqueuePendingMessage =
  "The slot list is still processing. I'll update this message when it finishes.";
type SlotButtonRolloutGateDecision = Effect.Success<
  ReturnType<SheetWorkflowHttpClientShape["evaluateSlotsOpenRolloutGate"]>
>;

const slotButtonGateUnavailableDecision: SlotButtonRolloutGateDecision = {
  gateKey: "unavailable",
  revision: 0,
  matched: false,
  executionPath: "legacy",
  reason: "control-unavailable",
};

const getInteractionMessageId = Effect.gen(function* () {
  const interactionMessage = yield* Interaction.message();
  return pipe(
    interactionMessage,
    Option.map((message) => (message as { id: string }).id),
  );
});

const slotButtonData = makeButtonData((b) =>
  b.setCustomId(SLOT_OPEN_ACTION_ID).setLabel("Open slots").setStyle(ButtonStyle.Primary),
);

// Button response references intentionally mirror the command/status response-reference shape.
// fallow-ignore-next-line code-duplication
const makeSlotButtonResponseReferenceInput = ({
  applicationId,
  clientId,
  interactionId,
  interactionToken,
}: {
  readonly applicationId: string;
  readonly clientId: string;
  readonly interactionId: string;
  readonly interactionToken: string;
}) => ({
  applicationId,
  client: { platform: "discord" as const, clientId },
  interactionToken,
  permittedOperations: ["respond" as const],
  expiresAt: interactionDeadlineEpochMs(interactionId),
});

const issueSlotButtonResponseReference = (
  capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">,
) =>
  Effect.gen(function* () {
    const interactionToken = yield* InteractionToken;
    const interaction = yield* Ix.Interaction;
    const clientId = yield* config.sheetBotClientId;

    return yield* capabilityStore.issueResponseReference(
      // The interaction-specific response-reference issuer mirrors the check-in adapter by design.
      // fallow-ignore-next-line code-duplication
      makeSlotButtonResponseReferenceInput({
        applicationId: interactionToken.applicationId,
        clientId,
        interactionId: interaction.id,
        interactionToken: interactionToken.token,
      }),
    );
  });

const reportDefinitiveEnqueueFailure = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  error: unknown,
) =>
  response
    .editReply({
      payload: {
        content: Predicate.isTagged("WorkflowInvocationUnauthorized")(error)
          ? slotButtonEnqueueUnauthorizedMessage
          : slotButtonEnqueueRejectedMessage,
      },
    })
    .pipe(
      Effect.tap(() =>
        Effect.logWarning("Sheet-bot slot-open button workflow enqueue was rejected", { error }),
      ),
    );

const dispatchLegacySlotButton = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  messageId: string,
) =>
  runSheetWorkflowsDispatch(
    response,
    "the slot button",
    SheetWorkflowsRequestContext.asInteractionUser(
      Effect.fn("slotButton.dispatchLegacyPath")(function* () {
        const interactionToken = yield* InteractionToken;
        const interaction = yield* Ix.Interaction;
        const clientId = yield* config.sheetBotClientId;

        // The legacy button payload remains parallel while this caller is migrated.
        // fallow-ignore-next-line code-duplication
        return yield* sheetWorkflowsClient.get().dispatch.slotOpenButton({
          payload: {
            client: { platform: "discord", clientId },
            messageId,
            interactionResponseToken: interactionToken.token,
            interactionResponseDeadlineEpochMs: interactionDeadlineEpochMs(interaction.id),
          },
        });
      }),
    )(),
  ).pipe(Effect.catch((error) => reportDefinitiveEnqueueFailure(response, error)));

export const enqueueSlotOpenButton = Effect.fn("slotButton.enqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<
    SheetWorkflowHttpClientShape,
    "enqueueSlotsOpen" | "evaluateSlotsOpenRolloutGate"
  >,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">,
  messageId: string,
) {
  const invocationId = yield* makeWorkflowInvocationId();
  const clientId = yield* config.sheetBotClientId;
  const workspaceId = yield* resolveGuildId(Option.none());
  const decision = yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
    workflowClient.evaluateSlotsOpenRolloutGate({
      contractIdentity: "slots.open",
      contractWireVersion: "1",
      client: { platform: "discord", clientId },
      invocationId,
      workspaceId,
    }),
  )().pipe(
    Effect.timeout(slotButtonRolloutGateEvaluationTimeout),
    Effect.catch((error) =>
      Effect.logWarning("Rollout Gate Control could not be evaluated; using legacy path", {
        error,
        invocationId,
      }).pipe(Effect.as(slotButtonGateUnavailableDecision)),
    ),
  );

  yield* Match.value(decision.executionPath).pipe(
    Match.when("legacy", () => dispatchLegacySlotButton(response, sheetWorkflowsClient, messageId)),
    Match.when("replacement", () =>
      Effect.gen(function* () {
        const responseReference = yield* issueSlotButtonResponseReference(capabilityStore);

        yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
          enqueueSlotsOpenWorkflow(
            workflowClient,
            { messageId, responseReference },
            { invocationId },
          ),
        )();
      }).pipe(
        Effect.catch((error) =>
          Predicate.isTagged("WorkflowTransportUnavailable")(error)
            ? Effect.gen(function* () {
                yield* Effect.logWarning(
                  "Sheet-bot slot-open button workflow enqueue outcome is ambiguous",
                  { error },
                );
                yield* response.editReply({
                  payload: { content: slotButtonEnqueuePendingMessage },
                });
              })
            : reportDefinitiveEnqueueFailure(response, error),
        ),
      ),
    ),
    Match.exhaustive,
  );
});

const makeSlotButtonHandler = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* makeButton(
    slotButtonData.toJSON(),
    SheetWorkflowsRequestContext.asInteractionUser(
      Effect.fn("slotButton")(function* () {
        const response = yield* MessageComponentInteractionResponse;
        yield* response.deferReply({ flags: MessageFlags.Ephemeral });

        const messageId = Option.getOrThrow(yield* getInteractionMessageId);
        yield* enqueueSlotOpenButton(
          response,
          workflowClient,
          sheetWorkflowsClient,
          capabilityStore,
          messageId,
        );
      }),
    )(),
  );
});

const makeSlotButton = Effect.gen(function* () {
  const button = yield* makeSlotButtonHandler;

  return makeMessageComponent(button.data, button.handler as never);
});

export const slotButtonLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const button = yield* makeSlotButton;

    yield* registry.register(Ix.builder.add(button).catchAllCause(Effect.log));
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
