import {
  CHECKIN_BUTTON_CUSTOM_ID,
  ROOM_ORDER_NEXT_BUTTON_CUSTOM_ID,
  ROOM_ORDER_PREVIOUS_BUTTON_CUSTOM_ID,
  ROOM_ORDER_SEND_BUTTON_CUSTOM_ID,
  ROOM_ORDER_TENTATIVE_PIN_BUTTON_CUSTOM_ID,
  SLOT_BUTTON_CUSTOM_ID,
} from "sheet-ingress-api/discordComponents";

const ButtonStyle = {
  Primary: 1,
  Secondary: 2,
} as const;

type ButtonComponent = {
  readonly type: 2;
  readonly custom_id: string;
  readonly label: string;
  readonly style: number;
  readonly disabled?: boolean;
  readonly emoji?: {
    readonly id?: string;
    readonly name: string;
  };
};

type ActionRow = {
  readonly type: 1;
  readonly components: ReadonlyArray<ButtonComponent>;
};

const actionRow = (...components: ReadonlyArray<ButtonComponent>): ActionRow => ({
  type: 1,
  components,
});

const button = (options: Omit<ButtonComponent, "type">): ButtonComponent => ({
  type: 2,
  ...options,
});

export const checkinActionRow = (disabled = false) =>
  actionRow(
    button({
      custom_id: CHECKIN_BUTTON_CUSTOM_ID,
      label: "Check in",
      style: ButtonStyle.Primary,
      emoji: { id: "907705464215711834", name: "Miku_Happy" },
      disabled,
    }),
  );

export const slotActionRow = (disabled = false) =>
  actionRow(
    button({
      custom_id: SLOT_BUTTON_CUSTOM_ID,
      label: "Open slots",
      style: ButtonStyle.Primary,
      disabled,
    }),
  );

const previousButton = (disabled = false) =>
  button({
    custom_id: ROOM_ORDER_PREVIOUS_BUTTON_CUSTOM_ID,
    label: "Previous",
    style: ButtonStyle.Secondary,
    disabled,
  });

const nextButton = (disabled = false) =>
  button({
    custom_id: ROOM_ORDER_NEXT_BUTTON_CUSTOM_ID,
    label: "Next",
    style: ButtonStyle.Secondary,
    disabled,
  });

const sendButton = (disabled = false) =>
  button({
    custom_id: ROOM_ORDER_SEND_BUTTON_CUSTOM_ID,
    label: "Send",
    style: ButtonStyle.Primary,
    disabled,
  });

const tentativePinButton = (disabled = false) =>
  button({
    custom_id: ROOM_ORDER_TENTATIVE_PIN_BUTTON_CUSTOM_ID,
    label: "Pin",
    emoji: { name: "📌" },
    style: ButtonStyle.Primary,
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
