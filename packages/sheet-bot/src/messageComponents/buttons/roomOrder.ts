import { InteractionsRegistry } from "dfx/gateway";
import { MessageFlags } from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { Effect, Layer, Option, Schema, pipe } from "effect";
import {
  Interaction,
  MessageComponentInteractionResponse,
  type MessageComponentInteractionResponseContext,
  makeButton,
  makeMessageComponent,
} from "dfx-discord-utils/utils";
import type { ResponseReference } from "sheet-bot-api/references";
import { WorkspaceId } from "sheet-workflow-contracts/values";
import {
  enqueueRoomOrdersNavigateWorkflow,
  enqueueRoomOrdersPinTentativeWorkflow,
  enqueueRoomOrdersSendWorkflow,
  BotCapabilityStore,
  SheetWorkflowHttpClient,
} from "@/services";
import type { WorkflowInvocationId } from "sheet-workflow-http-client";
import { hasTentativeRoomOrderPrefix } from "sheet-bot-api/actions";
import { discordGatewayLayer } from "../../discord/gateway";
import {
  nextButtonData,
  previousButtonData,
  sendButtonData,
  tentativePinButtonData,
} from "./roomOrderComponents";
import { discordApplicationLayer } from "../../discord/application";
import { prefixedUnstorageLayer } from "@/discord/cache";
import { enqueueSheetWorkflow } from "@/utils/sheetWorkflowMigration";

const roomOrderButtonPendingMessage =
  "The room-order action is still processing. I'll update this message when it finishes.";
const roomOrderButtonRejectedMessage =
  "I couldn't complete the room-order action. Please try again.";
const roomOrderButtonUnauthorizedMessage = "You aren't allowed to manage this room order.";
type RoomOrderButtonResponse = Pick<
  MessageComponentInteractionResponseContext,
  "editReply" | "followUp" | "getAcknowledgementState"
>;
type RoomOrderButtonWorkflowPayload = {
  readonly workspaceId: Schema.Schema.Type<typeof WorkspaceId>;
  readonly messageId: string;
  readonly messageConversationId: string;
  readonly messageContent: string | null;
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

const makeRoomOrderButtonPayload = Effect.fn("roomOrderButton.makePayload")(function* () {
  const guildId = Option.getOrThrowWith(
    yield* getInteractionGuildId,
    () => new Error("Guild not found in interaction"),
  );
  const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(guildId);
  const message = Option.getOrThrowWith(
    yield* getInteractionMessage,
    () => new Error("Message not found in interaction"),
  );
  const messageContent = message.content ?? null;

  return {
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

const runRoomOrderButtonWorkflow = Effect.fn("roomOrderButton.enqueueWorkflow")(function* ({
  response,
  capabilityStore,
  workspaceId,
  enqueueReplacement,
}: {
  readonly response: RoomOrderButtonResponse;
  readonly capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">;
  readonly workspaceId: string;
  readonly enqueueReplacement: (
    responseReference: ResponseReference,
    invocationId: WorkflowInvocationId,
  ) => Effect.Effect<unknown, unknown, never>;
}) {
  yield* enqueueSheetWorkflow({
    response,
    operation: "room-order button",
    workspaceId,
    capabilityStore,
    makeInput: (responseReference) => responseReference,
    enqueue: (responseReference, options) =>
      enqueueReplacement(responseReference, options.invocationId),
    rejectedMessage: roomOrderButtonRejectedMessage,
    unauthorizedMessage: roomOrderButtonUnauthorizedMessage,
    pendingMessage: roomOrderButtonPendingMessage,
    report: (content) => reportButtonFailure(response, content),
  });
});

const makeRoomOrderNavigateButtonHandler = (
  buttonData: typeof previousButtonData | typeof nextButtonData,
  direction: "previous" | "next",
  spanName: string,
) =>
  Effect.gen(function* () {
    const workflowClient = yield* SheetWorkflowHttpClient;
    const capabilityStore = yield* BotCapabilityStore;

    return yield* makeButton(
      buttonData.toJSON(),
      Effect.fn(spanName)(function* () {
        yield* deferRoomOrderRankButtonInteraction();
        const payload = yield* makeRoomOrderButtonPayload();
        const response = yield* MessageComponentInteractionResponse;

        yield* runRoomOrderButtonWorkflow({
          response,
          capabilityStore,
          workspaceId: payload.workflow.workspaceId,
          enqueueReplacement: (responseReference, invocationId) =>
            enqueueRoomOrdersNavigateWorkflow(
              workflowClient,
              { ...payload.workflow, responseReference, direction },
              { invocationId },
            ),
        });
      })(),
    );
  });

const makeRoomOrderPreviousButtonHandler = makeRoomOrderNavigateButtonHandler(
  previousButtonData,
  "previous",
  "roomOrderPreviousButton",
);

const makeRoomOrderNextButtonHandler = makeRoomOrderNavigateButtonHandler(
  nextButtonData,
  "next",
  "roomOrderNextButton",
);

const makeRoomOrderSendButtonHandler = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* makeButton(
    sendButtonData.toJSON(),
    Effect.fn("roomOrderSendButton")(function* () {
      const response = yield* MessageComponentInteractionResponse;
      yield* response.deferReply({ flags: MessageFlags.Ephemeral });
      const payload = yield* makeRoomOrderButtonPayload();

      yield* runRoomOrderButtonWorkflow({
        response,
        capabilityStore,
        workspaceId: payload.workflow.workspaceId,
        enqueueReplacement: (responseReference, invocationId) =>
          enqueueRoomOrdersSendWorkflow(
            workflowClient,
            { ...payload.workflow, responseReference },
            { invocationId },
          ),
      });
    })(),
  );
});

const makeTentativeRoomOrderPinButtonHandler = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* makeButton(
    tentativePinButtonData.toJSON(),
    Effect.fn("roomOrderTentativePinButton")(function* () {
      const response = yield* MessageComponentInteractionResponse;
      yield* response.deferReply({ flags: MessageFlags.Ephemeral });
      const payload = yield* makeRoomOrderButtonPayload();

      yield* runRoomOrderButtonWorkflow({
        response,
        capabilityStore,
        workspaceId: payload.workflow.workspaceId,
        enqueueReplacement: (responseReference, invocationId) =>
          enqueueRoomOrdersPinTentativeWorkflow(
            workflowClient,
            { ...payload.workflow, responseReference },
            { invocationId },
          ),
      });
    })(),
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
      SheetWorkflowHttpClient.layer,
      BotCapabilityStore.layer.pipe(Layer.provide(prefixedUnstorageLayer)),
    ),
  ),
);
