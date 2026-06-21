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
import { SLOT_OPEN_ACTION_ID } from "sheet-ingress-api/clientActions";
import { SheetWorkflowsClient, SheetWorkflowsRequestContext } from "@/services";
import { interactionDeadlineEpochMs } from "@/utils/interactionDeadline";
import { config } from "@/config";

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

const makeSlotButtonHandler = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

  return yield* makeButton(
    slotButtonData.toJSON(),
    SheetWorkflowsRequestContext.asInteractionUser(
      Effect.fn("slotButton")(function* () {
        const response = yield* MessageComponentInteractionResponse;
        yield* response.deferReply({ flags: MessageFlags.Ephemeral });

        const messageId = Option.getOrThrow(yield* getInteractionMessageId);
        const interactionToken = yield* InteractionToken;
        const interaction = yield* Ix.Interaction;
        const clientId = yield* config.sheetBotClientId;

        yield* sheetWorkflowsClient.get().dispatch.slotOpenButton({
          payload: {
            client: { platform: "discord", clientId },
            messageId,
            interactionResponseToken: interactionToken.token,
            interactionResponseDeadlineEpochMs: interactionDeadlineEpochMs(interaction.id),
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
    Layer.mergeAll(discordGatewayLayer, discordApplicationLayer, SheetWorkflowsClient.layer),
  ),
);
