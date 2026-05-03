import { InteractionsRegistry } from "dfx/gateway";
import { MessageFlags } from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { Effect, Layer, Option, pipe } from "effect";
import {
  Interaction,
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
import { SheetApisClient, SheetApisRequestContext } from "@/services";
import { discordApplicationLayer } from "../../discord/application";
import type { RoomOrderButtonAction } from "sheet-ingress-api/sheet-apis-rpc";

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

const callRoomOrderButton = Effect.fn("roomOrderButton.callSheetApis")(function* (
  sheetApisClient: typeof SheetApisClient.Service,
  action: RoomOrderButtonAction,
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

  yield* sheetApisClient.get().roomOrder.handleButton({
    payload: {
      guildId,
      messageId: message.id,
      messageChannelId: message.channel_id,
      messageContent: message.content ?? null,
      interactionToken: interactionToken.token,
      action,
    },
  });
});

const makeRoomOrderRankButtonHandler = (
  action: Extract<RoomOrderButtonAction, "previous" | "next">,
) =>
  Effect.gen(function* () {
    const sheetApisClient = yield* SheetApisClient;
    const buttonData = action === "previous" ? previousButtonData : nextButtonData;

    return yield* makeButton(
      buttonData.toJSON(),
      SheetApisRequestContext.asInteractionUser(
        Effect.fn(`roomOrder${action}Button`)(function* (helper) {
          const message = Option.getOrThrowWith(
            yield* getInteractionMessage,
            () => new Error("Message not found in interaction"),
          );
          const isTentative = hasTentativeRoomOrderPrefix(message.content ?? "");

          if (isTentative) {
            yield* helper.deferReply({ flags: MessageFlags.Ephemeral });
          } else {
            yield* helper.deferUpdate({ flags: MessageFlags.Ephemeral });
          }

          yield* callRoomOrderButton(sheetApisClient, action);
        }),
      ),
    );
  });

const makeRoomOrderSendButtonHandler = Effect.gen(function* () {
  const sheetApisClient = yield* SheetApisClient;

  return yield* makeButton(
    sendButtonData.toJSON(),
    SheetApisRequestContext.asInteractionUser(
      Effect.fn("roomOrderSendButton")(function* (helper) {
        yield* helper.deferUpdate({ flags: MessageFlags.Ephemeral });
        yield* callRoomOrderButton(sheetApisClient, "send");
      }),
    ),
  );
});

const makeTentativeRoomOrderPinButtonHandler = Effect.gen(function* () {
  const sheetApisClient = yield* SheetApisClient;

  return yield* makeButton(
    tentativePinButtonData.toJSON(),
    SheetApisRequestContext.asInteractionUser(
      Effect.fn("roomOrderTentativePinButton")(function* (helper) {
        yield* helper.deferReply({ flags: MessageFlags.Ephemeral });
        yield* callRoomOrderButton(sheetApisClient, "pinTentative");
      }),
    ),
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
    Layer.mergeAll(discordGatewayLayer, discordApplicationLayer, SheetApisClient.layer),
  ),
);
