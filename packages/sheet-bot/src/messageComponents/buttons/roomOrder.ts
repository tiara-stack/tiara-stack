import { InteractionsRegistry } from "dfx/gateway";
import { MessageFlags } from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { Effect, Layer, Option, pipe } from "effect";
import {
  Interaction,
  MessageComponentInteractionResponse,
  InteractionToken,
  makeButton,
  makeMessageComponent,
} from "dfx-discord-utils/utils";
import { hasTentativeRoomOrderPrefix } from "sheet-ingress-api/discordComponents";
import { discordGatewayLayer } from "../../discord/gateway";
import {
  nextButtonData,
  previousButtonData,
  sendButtonData,
  tentativePinButtonData,
} from "./roomOrderComponents";
import { SheetClusterClient, SheetClusterRequestContext } from "@/services";
import { discordApplicationLayer } from "../../discord/application";
import {
  DispatchRoomOrderButtonMethods,
  type RoomOrderButtonInteractionResponseType,
} from "sheet-ingress-api/sheet-apis-rpc";
import { interactionDeadlineEpochMs } from "@/utils/interactionDeadline";

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
  const message = Option.getOrThrowWith(
    yield* getInteractionMessage,
    () => new Error("Message not found in interaction"),
  );
  const interactionToken = yield* InteractionToken;
  const interaction = yield* Ix.Interaction;

  return {
    payload: {
      guildId,
      messageId: message.id,
      messageChannelId: message.channel_id,
      messageContent: message.content ?? null,
      interactionToken: interactionToken.token,
      interactionDeadlineEpochMs: interactionDeadlineEpochMs(interaction.id),
      interactionResponseType,
    },
  };
});

const makeRoomOrderRankButtonHandler = (action: "previous" | "next") =>
  Effect.gen(function* () {
    const sheetClusterClient = yield* SheetClusterClient;
    const buttonData = action === "previous" ? previousButtonData : nextButtonData;

    return yield* makeButton(
      buttonData.toJSON(),
      SheetClusterRequestContext.asInteractionUser(
        Effect.fn(`roomOrder${action}Button`)(function* () {
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

          const payload = yield* makeRoomOrderButtonPayload(isTentative ? "reply" : "update");
          if (action === "previous") {
            yield* sheetClusterClient
              .get()
              .dispatch[DispatchRoomOrderButtonMethods.previous.endpointName](payload);
          } else {
            yield* sheetClusterClient
              .get()
              .dispatch[DispatchRoomOrderButtonMethods.next.endpointName](payload);
          }
        }),
      )(),
    );
  });

const makeRoomOrderSendButtonHandler = Effect.gen(function* () {
  const sheetClusterClient = yield* SheetClusterClient;

  return yield* makeButton(
    sendButtonData.toJSON(),
    SheetClusterRequestContext.asInteractionUser(
      Effect.fn("roomOrderSendButton")(function* () {
        const response = yield* MessageComponentInteractionResponse;
        yield* response.deferUpdate({ flags: MessageFlags.Ephemeral });
        const payload = yield* makeRoomOrderButtonPayload();
        yield* sheetClusterClient
          .get()
          .dispatch[DispatchRoomOrderButtonMethods.send.endpointName](payload);
      }),
    )(),
  );
});

const makeTentativeRoomOrderPinButtonHandler = Effect.gen(function* () {
  const sheetClusterClient = yield* SheetClusterClient;

  return yield* makeButton(
    tentativePinButtonData.toJSON(),
    SheetClusterRequestContext.asInteractionUser(
      Effect.fn("roomOrderTentativePinButton")(function* () {
        const response = yield* MessageComponentInteractionResponse;
        yield* response.deferReply({ flags: MessageFlags.Ephemeral });
        const payload = yield* makeRoomOrderButtonPayload();
        yield* sheetClusterClient
          .get()
          .dispatch[DispatchRoomOrderButtonMethods.pinTentative.endpointName](payload);
      }),
    )(),
  );
});

const makeRoomOrderPreviousButton = Effect.gen(function* () {
  const button = yield* makeRoomOrderRankButtonHandler("previous");
  return makeMessageComponent(button.data, button.handler as never);
});

const makeRoomOrderNextButton = Effect.gen(function* () {
  const button = yield* makeRoomOrderRankButtonHandler("next");
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
    Layer.mergeAll(discordGatewayLayer, discordApplicationLayer, SheetClusterClient.layer),
  ),
);
