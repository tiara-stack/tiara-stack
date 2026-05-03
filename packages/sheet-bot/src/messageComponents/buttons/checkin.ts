import { InteractionsRegistry } from "dfx/gateway";
import { ButtonStyle, MessageFlags } from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { Effect, Layer, Option, pipe } from "effect";
import { CHECKIN_BUTTON_CUSTOM_ID } from "sheet-ingress-api/discordComponents";
import { discordGatewayLayer } from "../../discord/gateway";
import {
  makeButton,
  makeButtonData,
  makeMessageActionRowData,
  makeMessageComponent,
} from "dfx-discord-utils/utils";
import { InteractionToken } from "dfx-discord-utils/utils";
import { Interaction } from "dfx-discord-utils/utils";
import { discordApplicationLayer } from "../../discord/application";
import { SheetApisClient, SheetApisRequestContext } from "@/services";

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
  const sheetApisClient = yield* SheetApisClient;

  return yield* makeButton(
    checkinButtonData.toJSON(),
    SheetApisRequestContext.asInteractionUser(
      Effect.fn("checkinButton")(function* (helper) {
        yield* helper.deferReply({ flags: MessageFlags.Ephemeral });

        const guildId = Option.getOrThrow(yield* getInteractionGuildId);
        const message = Option.getOrThrow(yield* getInteractionMessage);
        const interactionToken = yield* InteractionToken;

        yield* sheetApisClient.get().checkin.handleButton({
          payload: {
            guildId,
            messageId: message.id,
            messageChannelId: message.channel_id,
            interactionToken: interactionToken.token,
          },
        });
      }),
    ),
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
    Layer.mergeAll(discordGatewayLayer, discordApplicationLayer, SheetApisClient.layer),
  ),
);
