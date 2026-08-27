import { ButtonStyle } from "discord-api-types/v10";
import { makeButtonData } from "dfx-discord-utils/utils";
import {
  ROOM_ORDER_NEXT_ACTION_ID,
  ROOM_ORDER_PREVIOUS_ACTION_ID,
  ROOM_ORDER_SEND_ACTION_ID,
  ROOM_ORDER_TENTATIVE_PIN_ACTION_ID,
} from "sheet-bot-api/actions";

export const previousButtonData = makeButtonData((b) =>
  b.setCustomId(ROOM_ORDER_PREVIOUS_ACTION_ID).setLabel("Previous").setStyle(ButtonStyle.Secondary),
);

export const nextButtonData = makeButtonData((b) =>
  b.setCustomId(ROOM_ORDER_NEXT_ACTION_ID).setLabel("Next").setStyle(ButtonStyle.Secondary),
);

export const sendButtonData = makeButtonData((b) =>
  b.setCustomId(ROOM_ORDER_SEND_ACTION_ID).setLabel("Send").setStyle(ButtonStyle.Primary),
);

export const tentativePinButtonData = makeButtonData((b) =>
  b
    .setCustomId(ROOM_ORDER_TENTATIVE_PIN_ACTION_ID)
    .setLabel("Pin")
    .setEmoji({ name: "📌" })
    .setStyle(ButtonStyle.Primary),
);
