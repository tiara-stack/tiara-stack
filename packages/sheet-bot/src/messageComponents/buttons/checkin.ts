import { InteractionsRegistry } from "dfx/gateway";
import { ButtonStyle, MessageFlags } from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { Effect, Layer, Option, pipe } from "effect";
import { CHECKIN_BUTTON_CUSTOM_ID } from "sheet-ingress-api/discordComponents";
import { discordGatewayLayer } from "../../discord/gateway";
import {
  MessageComponentInteractionResponse,
  makeButton,
  makeButtonData,
  makeMessageActionRowData,
  makeMessageComponent,
} from "dfx-discord-utils/utils";
import { InteractionToken } from "dfx-discord-utils/utils";
import { Interaction } from "dfx-discord-utils/utils";
import { discordApplicationLayer } from "../../discord/application";
import { SheetClusterClient, SheetClusterRequestContext } from "@/services";
import { interactionDeadlineEpochMs } from "@/utils/interactionDeadline";

const getInteractionMessage = Effect.gen(function* () {
  const interactionMessage = yield* Interaction.message();
  return pipe(
    interactionMessage,
    Option.map((message) => message as { id: string; channel_id: string }),
  );
});

export const makeCheckinButtonData = (disabled = false) =>
  makeButtonData((b) =>
    b
      .setCustomId(CHECKIN_BUTTON_CUSTOM_ID)
      .setLabel("Check in")
      .setStyle(ButtonStyle.Primary)
      .setEmoji({ id: "907705464215711834", name: "Miku_Happy" })
      .setDisabled(disabled),
  );

export const checkinButtonData = makeCheckinButtonData();

export const checkinActionRow = (disabled = false) =>
  makeMessageActionRowData((b) => b.setComponents(makeCheckinButtonData(disabled)));

const makeCheckinButtonHandler = Effect.gen(function* () {
  const sheetClusterClient = yield* SheetClusterClient;

  return yield* makeButton(
    checkinButtonData.toJSON(),
    SheetClusterRequestContext.asInteractionUser(
      Effect.fn("checkinButton")(function* () {
        const response = yield* MessageComponentInteractionResponse;
        yield* response.deferReply({ flags: MessageFlags.Ephemeral });

        const message = Option.getOrThrow(yield* getInteractionMessage);
        const interactionToken = yield* InteractionToken;
        const interaction = yield* Ix.Interaction;

        yield* sheetClusterClient.get().dispatch.checkinButton({
          payload: {
            messageId: message.id,
            interactionToken: interactionToken.token,
            interactionDeadlineEpochMs: interactionDeadlineEpochMs(interaction.id),
          },
        });
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
    Layer.mergeAll(discordGatewayLayer, discordApplicationLayer, SheetClusterClient.layer),
  ),
);
