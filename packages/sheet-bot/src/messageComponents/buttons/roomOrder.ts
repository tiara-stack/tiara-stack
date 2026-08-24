import { InteractionsRegistry } from "dfx/gateway";
import { MessageFlags } from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { Duration, Effect, Layer, Match, Option, Predicate, Schema, pipe } from "effect";
import {
  Interaction,
  MessageComponentInteractionResponse,
  type MessageComponentInteractionResponseContext,
  InteractionToken,
  makeButton,
  makeMessageComponent,
} from "dfx-discord-utils/utils";
import type { ResponseReference as ResponseReferenceType } from "sheet-bot-api/references";
import { WorkspaceId } from "sheet-workflow-contracts/values";
import {
  enqueueRoomOrdersNavigateWorkflow,
  enqueueRoomOrdersPinTentativeWorkflow,
  enqueueRoomOrdersSendWorkflow,
  BotCapabilityStore,
  SheetWorkflowHttpClient,
  SheetWorkflowHttpRequestContext,
  SheetWorkflowsClient,
  SheetWorkflowsRequestContext,
  type WorkflowRolloutGateEvaluation,
} from "@/services";
import { makeWorkflowInvocationId, type WorkflowInvocationId } from "sheet-workflow-http-client";
import { hasTentativeRoomOrderPrefix } from "sheet-ingress-api/clientActions";
import { discordGatewayLayer } from "../../discord/gateway";
import {
  nextButtonData,
  previousButtonData,
  sendButtonData,
  tentativePinButtonData,
} from "./roomOrderComponents";
import { discordApplicationLayer } from "../../discord/application";
import {
  DispatchRoomOrderButtonMethods,
  type RoomOrderButtonInteractionResponseType,
} from "sheet-ingress-api/sheet-apis-rpc";
import { issueInteractionResponseReference } from "@/utils/commandHelpers";
import { interactionDeadlineEpochMs } from "@/utils/interactionDeadline";
import { runSheetWorkflowsDispatch } from "@/utils/sheetWorkflowsDispatch";
import { evaluateRolloutGateWithLegacyFallback } from "@/utils/workflowEnqueue";
import { config } from "@/config";
import { prefixedUnstorageLayer } from "@/discord/cache";

const roomOrderButtonRolloutGateEvaluationTimeout = Duration.seconds(5);
const roomOrderButtonPendingMessage =
  "The room-order action is still processing. I'll update this message when it finishes.";
const roomOrderButtonRejectedMessage =
  "I couldn't complete the room-order action. Please try again.";
const roomOrderButtonUnauthorizedMessage = "You aren't allowed to manage this room order.";
type RoomOrderButtonResponse = Pick<
  MessageComponentInteractionResponseContext,
  "editReply" | "followUp" | "getAcknowledgementState"
>;
type RoomOrderButtonRolloutGateDecision = Effect.Success<ReturnType<WorkflowRolloutGateEvaluation>>;
type RoomOrderButtonLegacyPayload = {
  readonly payload: {
    readonly client: { readonly platform: "discord"; readonly clientId: string };
    readonly workspaceId: string;
    readonly messageId: string;
    readonly messageConversationId: string;
    readonly messageContent: string | null;
    readonly interactionResponseToken: string;
    readonly interactionResponseDeadlineEpochMs: number;
    readonly interactionResponseType?: RoomOrderButtonInteractionResponseType;
  };
};
type RoomOrderButtonWorkflowPayload = {
  readonly workspaceId: Schema.Schema.Type<typeof WorkspaceId>;
  readonly messageId: string;
  readonly messageConversationId: string;
  readonly messageContent: string | null;
};

const roomOrderButtonGateUnavailableDecision: RoomOrderButtonRolloutGateDecision = {
  gateKey: "unavailable",
  revision: 0,
  matched: false,
  executionPath: "legacy",
  reason: "control-unavailable",
};

const getInteractionGuildId = Effect.gen(function* () {
  const interactionGuild = yield* Interaction.guild();
  return pipe(
    interactionGuild,
    Option.map((guild) => (guild as { id: string }).id),
  );
});

const getInteractionMessage = Effect.gen(function* () {
  const interactionMessage = yield* Interaction.message();
  return pipe(
    interactionMessage,
    Option.map((message) => message as { id: string; channel_id: string; content?: string }),
  );
});

const makeRoomOrderButtonPayload = Effect.fn("roomOrderButton.makePayload")(function* (
  interactionResponseType?: RoomOrderButtonInteractionResponseType,
) {
  const guildId = Option.getOrThrowWith(
    yield* getInteractionGuildId,
    () => new Error("Guild not found in interaction"),
  );
  const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(guildId);
  const message = Option.getOrThrowWith(
    yield* getInteractionMessage,
    () => new Error("Message not found in interaction"),
  );
  const interactionToken = yield* InteractionToken;
  const interaction = yield* Ix.Interaction;
  const clientId = yield* config.sheetBotClientId;
  const messageContent = message.content ?? null;

  return {
    legacy: {
      payload: {
        client: { platform: "discord" as const, clientId },
        workspaceId: guildId,
        messageId: message.id,
        messageConversationId: message.channel_id,
        messageContent,
        interactionResponseToken: interactionToken.token,
        interactionResponseDeadlineEpochMs: interactionDeadlineEpochMs(interaction.id),
        ...(interactionResponseType === undefined ? {} : { interactionResponseType }),
      },
    } satisfies RoomOrderButtonLegacyPayload,
    workflow: {
      workspaceId,
      messageId: message.id,
      messageConversationId: message.channel_id,
      messageContent,
    } satisfies RoomOrderButtonWorkflowPayload,
  };
});

const deferRoomOrderRankButtonInteraction = Effect.fn("roomOrderRankButton.deferInteraction")(
  function* () {
    const response = yield* MessageComponentInteractionResponse;
    const message = Option.getOrThrowWith(
      yield* getInteractionMessage,
      () => new Error("Message not found in interaction"),
    );
    const isTentative = hasTentativeRoomOrderPrefix(message.content ?? "");

    if (isTentative) {
      yield* response.deferReply({ flags: MessageFlags.Ephemeral });
    } else {
      yield* response.deferUpdate({ flags: MessageFlags.Ephemeral });
    }

    return isTentative;
  },
);

const reportButtonFailure = (response: RoomOrderButtonResponse, content: string) =>
  Effect.gen(function* () {
    const acknowledgementState = yield* response.getAcknowledgementState;
    if (acknowledgementState === "deferred-update") {
      yield* response.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      yield* response.editReply({ payload: { content } });
    }
  });

const reportDefinitiveEnqueueFailure = (response: RoomOrderButtonResponse, error: unknown) =>
  reportButtonFailure(
    response,
    Predicate.isTagged("WorkflowInvocationUnauthorized")(error)
      ? roomOrderButtonUnauthorizedMessage
      : roomOrderButtonRejectedMessage,
  ).pipe(
    Effect.tap(() =>
      Effect.logWarning("Sheet-bot room-order button workflow enqueue was rejected", {
        error,
      }),
    ),
  );

const runRoomOrderButtonWorkflow = Effect.fn("roomOrderButton.enqueueWorkflow")(function* ({
  response,
  capabilityStore,
  workspaceId,
  contractIdentity,
  evaluateRolloutGate,
  enqueueReplacement,
  dispatchLegacy,
}: {
  readonly response: RoomOrderButtonResponse;
  readonly capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">;
  readonly workspaceId: string;
  readonly contractIdentity: string;
  readonly evaluateRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueReplacement: (
    responseReference: ResponseReferenceType,
    invocationId: WorkflowInvocationId,
  ) => Effect.Effect<unknown, unknown, never>;
  readonly dispatchLegacy: () => Effect.Effect<unknown, unknown, never>;
}) {
  const invocationId = yield* makeWorkflowInvocationId();
  const clientId = yield* config.sheetBotClientId;
  const decision = yield* evaluateRolloutGateWithLegacyFallback(
    SheetWorkflowHttpRequestContext.asInteractionUser(() =>
      evaluateRolloutGate({
        contractIdentity,
        contractWireVersion: "1",
        client: { platform: "discord", clientId },
        invocationId,
        workspaceId,
      }),
    )(),
    roomOrderButtonRolloutGateEvaluationTimeout,
    roomOrderButtonGateUnavailableDecision,
    invocationId,
  );

  yield* Match.value(decision.executionPath).pipe(
    Match.when("legacy", () =>
      runSheetWorkflowsDispatch(response, "the room-order action", dispatchLegacy()).pipe(
        Effect.catch((error) => reportDefinitiveEnqueueFailure(response, error)),
      ),
    ),
    Match.when("replacement", () =>
      Effect.gen(function* () {
        const responseReference = yield* issueInteractionResponseReference(
          capabilityStore,
          workspaceId,
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Sheet-bot room-order response reference issuance failed", {
              error,
            }).pipe(
              Effect.andThen(
                reportButtonFailure(response, roomOrderButtonRejectedMessage).pipe(Effect.ignore),
              ),
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );

        yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
          enqueueReplacement(responseReference, invocationId),
        )().pipe(
          Effect.catch((error) =>
            Predicate.isTagged("WorkflowTransportUnavailable")(error)
              ? Effect.gen(function* () {
                  yield* Effect.logWarning(
                    "Sheet-bot room-order workflow enqueue outcome is ambiguous",
                    { error },
                  );
                  yield* reportButtonFailure(response, roomOrderButtonPendingMessage);
                })
              : reportButtonFailure(
                  response,
                  Predicate.isTagged("WorkflowInvocationUnauthorized")(error)
                    ? roomOrderButtonUnauthorizedMessage
                    : roomOrderButtonRejectedMessage,
                ),
          ),
        );
      }),
    ),
    Match.exhaustive,
  );
});

const makeRoomOrderPreviousButtonHandler = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* makeButton(
    previousButtonData.toJSON(),
    SheetWorkflowsRequestContext.asInteractionUser(
      Effect.fn("roomOrderPreviousButton")(function* () {
        const isTentative = yield* deferRoomOrderRankButtonInteraction();
        const payload = yield* makeRoomOrderButtonPayload(isTentative ? "reply" : "update");
        const response = yield* MessageComponentInteractionResponse;

        yield* runRoomOrderButtonWorkflow({
          response,
          capabilityStore,
          workspaceId: payload.workflow.workspaceId,
          contractIdentity: "roomOrders.navigate",
          evaluateRolloutGate: workflowClient.evaluateRoomOrdersNavigateRolloutGate,
          enqueueReplacement: (responseReference, invocationId) =>
            enqueueRoomOrdersNavigateWorkflow(
              workflowClient,
              { ...payload.workflow, responseReference, direction: "previous" },
              { invocationId },
            ),
          dispatchLegacy: () =>
            sheetWorkflowsClient
              .get()
              .dispatch[DispatchRoomOrderButtonMethods.previous.endpointName](payload.legacy),
        });
      }),
    )(),
  );
});

const makeRoomOrderNextButtonHandler = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* makeButton(
    nextButtonData.toJSON(),
    SheetWorkflowsRequestContext.asInteractionUser(
      Effect.fn("roomOrderNextButton")(function* () {
        const isTentative = yield* deferRoomOrderRankButtonInteraction();
        const payload = yield* makeRoomOrderButtonPayload(isTentative ? "reply" : "update");
        const response = yield* MessageComponentInteractionResponse;

        yield* runRoomOrderButtonWorkflow({
          response,
          capabilityStore,
          workspaceId: payload.workflow.workspaceId,
          contractIdentity: "roomOrders.navigate",
          evaluateRolloutGate: workflowClient.evaluateRoomOrdersNavigateRolloutGate,
          enqueueReplacement: (responseReference, invocationId) =>
            enqueueRoomOrdersNavigateWorkflow(
              workflowClient,
              { ...payload.workflow, responseReference, direction: "next" },
              { invocationId },
            ),
          dispatchLegacy: () =>
            sheetWorkflowsClient
              .get()
              .dispatch[DispatchRoomOrderButtonMethods.next.endpointName](payload.legacy),
        });
      }),
    )(),
  );
});

const makeRoomOrderSendButtonHandler = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* makeButton(
    sendButtonData.toJSON(),
    SheetWorkflowsRequestContext.asInteractionUser(
      Effect.fn("roomOrderSendButton")(function* () {
        const response = yield* MessageComponentInteractionResponse;
        yield* response.deferReply({ flags: MessageFlags.Ephemeral });
        const payload = yield* makeRoomOrderButtonPayload();

        yield* runRoomOrderButtonWorkflow({
          response,
          capabilityStore,
          workspaceId: payload.workflow.workspaceId,
          contractIdentity: "roomOrders.send",
          evaluateRolloutGate: workflowClient.evaluateRoomOrdersSendRolloutGate,
          enqueueReplacement: (responseReference, invocationId) =>
            enqueueRoomOrdersSendWorkflow(
              workflowClient,
              { ...payload.workflow, responseReference },
              { invocationId },
            ),
          dispatchLegacy: () =>
            sheetWorkflowsClient
              .get()
              .dispatch[DispatchRoomOrderButtonMethods.send.endpointName](payload.legacy),
        });
      }),
    )(),
  );
});

const makeTentativeRoomOrderPinButtonHandler = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* makeButton(
    tentativePinButtonData.toJSON(),
    SheetWorkflowsRequestContext.asInteractionUser(
      Effect.fn("roomOrderTentativePinButton")(function* () {
        const response = yield* MessageComponentInteractionResponse;
        yield* response.deferReply({ flags: MessageFlags.Ephemeral });
        const payload = yield* makeRoomOrderButtonPayload();

        yield* runRoomOrderButtonWorkflow({
          response,
          capabilityStore,
          workspaceId: payload.workflow.workspaceId,
          contractIdentity: "roomOrders.pinTentative",
          evaluateRolloutGate: workflowClient.evaluateRoomOrdersPinTentativeRolloutGate,
          enqueueReplacement: (responseReference, invocationId) =>
            enqueueRoomOrdersPinTentativeWorkflow(
              workflowClient,
              { ...payload.workflow, responseReference },
              { invocationId },
            ),
          dispatchLegacy: () =>
            sheetWorkflowsClient
              .get()
              .dispatch[DispatchRoomOrderButtonMethods.pinTentative.endpointName](payload.legacy),
        });
      }),
    )(),
  );
});

const makeRoomOrderPreviousButton = Effect.gen(function* () {
  const button = yield* makeRoomOrderPreviousButtonHandler;
  return makeMessageComponent(button.data, button.handler as never);
});

const makeRoomOrderNextButton = Effect.gen(function* () {
  const button = yield* makeRoomOrderNextButtonHandler;
  return makeMessageComponent(button.data, button.handler as never);
});

const makeRoomOrderSendButton = Effect.gen(function* () {
  const button = yield* makeRoomOrderSendButtonHandler;
  return makeMessageComponent(button.data, button.handler as never);
});

const makeTentativeRoomOrderPinButton = Effect.gen(function* () {
  const button = yield* makeTentativeRoomOrderPinButtonHandler;
  return makeMessageComponent(button.data, button.handler as never);
});

export const roomOrderButtonLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const previousButton = yield* makeRoomOrderPreviousButton;
    const nextButton = yield* makeRoomOrderNextButton;
    const sendButton = yield* makeRoomOrderSendButton;
    const tentativePinButton = yield* makeTentativeRoomOrderPinButton;

    yield* registry.register(Ix.builder.add(previousButton).catchAllCause(Effect.log));
    yield* registry.register(Ix.builder.add(nextButton).catchAllCause(Effect.log));
    yield* registry.register(Ix.builder.add(sendButton).catchAllCause(Effect.log));
    yield* registry.register(Ix.builder.add(tentativePinButton).catchAllCause(Effect.log));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      discordGatewayLayer,
      discordApplicationLayer,
      SheetWorkflowsClient.layer,
      SheetWorkflowHttpClient.layer,
      BotCapabilityStore.layer.pipe(Layer.provide(prefixedUnstorageLayer)),
    ),
  ),
);
