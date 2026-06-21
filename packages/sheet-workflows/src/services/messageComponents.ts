import {
  CHECKIN_ACTION_ID,
  ROOM_ORDER_NEXT_ACTION_ID,
  ROOM_ORDER_PREVIOUS_ACTION_ID,
  ROOM_ORDER_SEND_ACTION_ID,
  ROOM_ORDER_TENTATIVE_PIN_ACTION_ID,
  SLOT_OPEN_ACTION_ID,
} from "sheet-ingress-api/clientActions";
import type { SheetActionButton, SheetMessageActionRow } from "sheet-ingress-api/schemas/client";

const actionRow = (...components: ReadonlyArray<SheetActionButton>): SheetMessageActionRow => ({
  type: "actionRow",
  components: [...components],
});

const button = (options: Omit<SheetActionButton, "type">): SheetActionButton => ({
  type: "button",
  ...options,
});

export const checkinActionRow = (disabled = false) =>
  actionRow(
    button({
      actionId: CHECKIN_ACTION_ID,
      label: "Check in",
      style: "primary",
      emoji: { id: "907705464215711834", name: "Miku_Happy" },
      disabled,
    }),
  );

export const slotActionRow = (disabled = false) =>
  actionRow(
    button({
      actionId: SLOT_OPEN_ACTION_ID,
      label: "Open slots",
      style: "primary",
      disabled,
    }),
  );

const previousButton = (disabled = false) =>
  button({
    actionId: ROOM_ORDER_PREVIOUS_ACTION_ID,
    label: "Previous",
    style: "secondary",
    disabled,
  });

const nextButton = (disabled = false) =>
  button({
    actionId: ROOM_ORDER_NEXT_ACTION_ID,
    label: "Next",
    style: "secondary",
    disabled,
  });

const sendButton = (disabled = false) =>
  button({
    actionId: ROOM_ORDER_SEND_ACTION_ID,
    label: "Send",
    style: "primary",
    disabled,
  });

const tentativePinButton = (disabled = false) =>
  button({
    actionId: ROOM_ORDER_TENTATIVE_PIN_ACTION_ID,
    label: "Pin",
    emoji: { name: "📌" },
    style: "primary",
    disabled,
  });

export const roomOrderActionRow = (
  range: { readonly minRank: number; readonly maxRank: number },
  rank: number,
  disabled = false,
) =>
  actionRow(
    previousButton(disabled || range.minRank === rank),
    nextButton(disabled || range.maxRank === rank),
    sendButton(disabled),
  );

export const tentativeRoomOrderActionRow = (
  range: { readonly minRank: number; readonly maxRank: number },
  rank: number,
) =>
  actionRow(
    previousButton(range.minRank === rank),
    nextButton(range.maxRank === rank),
    tentativePinButton(),
  );

export const tentativeRoomOrderPinActionRow = (disabled = false) =>
  actionRow(tentativePinButton(disabled));
