import { ButtonStyle } from "discord-api-types/v10";
import { makeButtonData, makeMessageActionRowData } from "dfx-discord-utils/utils";
import {
  ROOM_ORDER_NEXT_BUTTON_CUSTOM_ID,
  ROOM_ORDER_PREVIOUS_BUTTON_CUSTOM_ID,
  ROOM_ORDER_SEND_BUTTON_CUSTOM_ID,
  ROOM_ORDER_TENTATIVE_PIN_BUTTON_CUSTOM_ID,
} from "sheet-ingress-api/discordComponents";

export const previousButtonData = makeButtonData((b) =>
  b
    .setCustomId(ROOM_ORDER_PREVIOUS_BUTTON_CUSTOM_ID)
    .setLabel("Previous")
    .setStyle(ButtonStyle.Secondary),
);

export const nextButtonData = makeButtonData((b) =>
  b.setCustomId(ROOM_ORDER_NEXT_BUTTON_CUSTOM_ID).setLabel("Next").setStyle(ButtonStyle.Secondary),
);

export const sendButtonData = makeButtonData((b) =>
  b.setCustomId(ROOM_ORDER_SEND_BUTTON_CUSTOM_ID).setLabel("Send").setStyle(ButtonStyle.Primary),
);

export const tentativePinButtonData = makeButtonData((b) =>
  b
    .setCustomId(ROOM_ORDER_TENTATIVE_PIN_BUTTON_CUSTOM_ID)
    .setLabel("Pin")
    .setEmoji({ name: "📌" })
    .setStyle(ButtonStyle.Primary),
);

export const tentativeRoomOrderActionRow = (
  range: { minRank: number; maxRank: number },
  rank: number,
) =>
  makeMessageActionRowData((b) =>
    b.setComponents(
      previousButtonData.setDisabled(range.minRank === rank),
      nextButtonData.setDisabled(range.maxRank === rank),
      tentativePinButtonData,
    ),
  );

export const tentativeRoomOrderPinActionRow = (disabled = false) =>
  makeMessageActionRowData((b) => b.setComponents(tentativePinButtonData.setDisabled(disabled)));
