import { InteractionsRegistry } from "dfx/gateway";
import { ButtonStyle, MessageFlags } from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { Duration, Effect, Layer, Match, Option, pipe, Predicate } from "effect";
import { CHECKIN_ACTION_ID } from "sheet-ingress-api/clientActions";
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
  enqueueCheckinsRespondWorkflow,
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

const checkinButtonRolloutGateEvaluationTimeout = Duration.seconds(5);
const checkinButtonEnqueueRejectedMessage = "I couldn't process your check-in. Please try again.";
const checkinButtonEnqueueUnauthorizedMessage = "You aren't allowed to check in from this message.";
const checkinButtonEnqueuePendingMessage =
  "Your check-in is still processing. I'll update this message when it finishes.";
type CheckinButtonRolloutGateDecision = Effect.Success<
  ReturnType<SheetWorkflowHttpClientShape["evaluateCheckinsRespondRolloutGate"]>
>;

const checkinButtonGateUnavailableDecision: CheckinButtonRolloutGateDecision = {
  gateKey: "unavailable",
  revision: 0,
  matched: false,
  executionPath: "legacy",
  reason: "control-unavailable",
};

const getInteractionMessage = Effect.gen(function* () {
  const interactionMessage = yield* Interaction.message();
  return pipe(
    interactionMessage,
    Option.map((message) => message as { id: string; channel_id: string }),
  );
});

const makeCheckinButtonData = (disabled = false) =>
  makeButtonData((b) =>
    b
      .setCustomId(CHECKIN_ACTION_ID)
      .setLabel("Check in")
      .setStyle(ButtonStyle.Primary)
      .setEmoji({ id: "907705464215711834", name: "Miku_Happy" })
      .setDisabled(disabled),
  );

const checkinButtonData = makeCheckinButtonData();

// Button response references intentionally mirror the command/status response-reference shape.
// fallow-ignore-next-line code-duplication
const makeCheckinButtonResponseReferenceInput = ({
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

const issueCheckinButtonResponseReference = (
  capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">,
) =>
  Effect.gen(function* () {
    const interactionToken = yield* InteractionToken;
    const interaction = yield* Ix.Interaction;
    const clientId = yield* config.sheetBotClientId;

    return yield* capabilityStore.issueResponseReference(
      // The interaction-specific response-reference issuer mirrors the slot-open adapter by design.
      // fallow-ignore-next-line code-duplication
      makeCheckinButtonResponseReferenceInput({
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
          ? checkinButtonEnqueueUnauthorizedMessage
          : checkinButtonEnqueueRejectedMessage,
      },
    })
    .pipe(
      Effect.tap(() =>
        Effect.logWarning("Sheet-bot check-in button workflow enqueue was rejected", { error }),
      ),
    );

const dispatchLegacyCheckinButton = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  messageId: string,
) =>
  runSheetWorkflowsDispatch(
    response,
    "the check-in button",
    SheetWorkflowsRequestContext.asInteractionUser(
      Effect.fn("checkinButton.dispatchLegacyPath")(function* () {
        const interactionToken = yield* InteractionToken;
        const interaction = yield* Ix.Interaction;
        const clientId = yield* config.sheetBotClientId;

        // The legacy button payload remains parallel while this caller is migrated.
        // fallow-ignore-next-line code-duplication
        return yield* sheetWorkflowsClient.get().dispatch.checkinButton({
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

export const enqueueCheckinButton = Effect.fn("checkinButton.enqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<
    SheetWorkflowHttpClientShape,
    "enqueueCheckinsRespond" | "evaluateCheckinsRespondRolloutGate"
  >,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">,
  messageId: string,
) {
  const invocationId = yield* makeWorkflowInvocationId();
  const clientId = yield* config.sheetBotClientId;
  const workspaceId = yield* resolveGuildId(Option.none());
  const decision = yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
    workflowClient.evaluateCheckinsRespondRolloutGate({
      contractIdentity: "checkins.respond",
      contractWireVersion: "1",
      client: { platform: "discord", clientId },
      invocationId,
      workspaceId,
    }),
  )().pipe(
    Effect.timeout(checkinButtonRolloutGateEvaluationTimeout),
    Effect.catch((error) =>
      Effect.logWarning("Rollout Gate Control could not be evaluated; using legacy path", {
        error,
        invocationId,
      }).pipe(Effect.as(checkinButtonGateUnavailableDecision)),
    ),
  );

  yield* Match.value(decision.executionPath).pipe(
    Match.when("legacy", () =>
      dispatchLegacyCheckinButton(response, sheetWorkflowsClient, messageId),
    ),
    Match.when("replacement", () =>
      Effect.gen(function* () {
        const responseReference = yield* issueCheckinButtonResponseReference(capabilityStore);

        yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
          enqueueCheckinsRespondWorkflow(
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
                  "Sheet-bot check-in button workflow enqueue outcome is ambiguous",
                  { error },
                );
                yield* response.editReply({
                  payload: { content: checkinButtonEnqueuePendingMessage },
                });
              })
            : reportDefinitiveEnqueueFailure(response, error),
        ),
      ),
    ),
    Match.exhaustive,
  );
});

const makeCheckinButtonHandler = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* makeButton(
    checkinButtonData.toJSON(),
    SheetWorkflowsRequestContext.asInteractionUser(
      Effect.fn("checkinButton")(function* () {
        const response = yield* MessageComponentInteractionResponse;
        yield* response.deferReply({ flags: MessageFlags.Ephemeral });

        const message = Option.getOrThrow(yield* getInteractionMessage);
        yield* enqueueCheckinButton(
          response,
          workflowClient,
          sheetWorkflowsClient,
          capabilityStore,
          message.id,
        );
      }),
    )(),
  );
});

const makeCheckinButton = Effect.gen(function* () {
  const button = yield* makeCheckinButtonHandler;

  return makeMessageComponent(button.data, button.handler as never);
});

export const checkinButtonLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const button = yield* makeCheckinButton;

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
