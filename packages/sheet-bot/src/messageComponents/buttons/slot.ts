import { InteractionsRegistry } from "dfx/gateway";
import { Ix } from "dfx/index";
import { Effect, Layer, Option, pipe } from "effect";
import { discordGatewayLayer } from "../../discord/gateway";
import {
  MessageComponentInteractionResponse,
  makeButton,
  makeButtonData,
  makeMessageComponent,
} from "dfx-discord-utils/utils";
import { Interaction, InteractionToken } from "dfx-discord-utils/utils";
import { ButtonStyle, MessageFlags } from "discord-api-types/v10";
import { discordApplicationLayer } from "../../discord/application";
import { SLOT_BUTTON_CUSTOM_ID } from "sheet-ingress-api/discordComponents";
import { SheetClusterClient, SheetClusterRequestContext } from "@/services";
import { interactionDeadlineEpochMs } from "@/utils/interactionDeadline";

const getInteractionMessageId = Effect.gen(function* () {
  const interactionMessage = yield* Interaction.message();
  return pipe(
    interactionMessage,
    Option.map((message) => (message as { id: string }).id),
  );
});

export const slotButtonData = makeButtonData((b) =>
  b.setCustomId(SLOT_BUTTON_CUSTOM_ID).setLabel("Open slots").setStyle(ButtonStyle.Primary),
);

const makeSlotButtonHandler = Effect.gen(function* () {
  const sheetClusterClient = yield* SheetClusterClient;

  return yield* makeButton(
    slotButtonData.toJSON(),
    SheetClusterRequestContext.asInteractionUser(
      Effect.fn("slotButton")(function* () {
        const response = yield* MessageComponentInteractionResponse;
        yield* response.deferReply({ flags: MessageFlags.Ephemeral });

        const messageId = Option.getOrThrow(yield* getInteractionMessageId);
        const interactionToken = yield* InteractionToken;
        const interaction = yield* Ix.Interaction;

        yield* sheetClusterClient.get().dispatch.slotOpenButton({
          payload: {
            messageId,
            interactionToken: interactionToken.token,
            interactionDeadlineEpochMs: interactionDeadlineEpochMs(interaction.id),
          },
        });
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
    Layer.mergeAll(discordGatewayLayer, discordApplicationLayer, SheetClusterClient.layer),
  ),
);
