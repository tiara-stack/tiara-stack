export const CHECKIN_BUTTON_CUSTOM_ID = "interaction:checkin";
export const SLOT_BUTTON_CUSTOM_ID = "interaction:slot";

export const ROOM_ORDER_PREVIOUS_BUTTON_CUSTOM_ID = "interaction:roomOrder:previous";
export const ROOM_ORDER_NEXT_BUTTON_CUSTOM_ID = "interaction:roomOrder:next";
export const ROOM_ORDER_SEND_BUTTON_CUSTOM_ID = "interaction:roomOrder:send";
export const ROOM_ORDER_TENTATIVE_PIN_BUTTON_CUSTOM_ID = "interaction:roomOrder:pinTentative";

export const TENTATIVE_ROOM_ORDER_MIN_FILL_COUNT = 5;
export const TENTATIVE_ROOM_ORDER_PREFIX = "(tentative)";

export const shouldSendTentativeRoomOrder = (fillCount: number): boolean =>
  fillCount >= TENTATIVE_ROOM_ORDER_MIN_FILL_COUNT;

export const hasTentativeRoomOrderPrefix = (content: string): boolean =>
  content === TENTATIVE_ROOM_ORDER_PREFIX || content.startsWith(`${TENTATIVE_ROOM_ORDER_PREFIX}\n`);

export const stripTentativeRoomOrderPrefix = (content: string): string =>
  hasTentativeRoomOrderPrefix(content)
    ? content.slice(TENTATIVE_ROOM_ORDER_PREFIX.length).replace(/^\n/, "")
    : content;

export const formatTentativeRoomOrderContent = (content: string): string =>
  hasTentativeRoomOrderPrefix(content)
    ? content
    : [TENTATIVE_ROOM_ORDER_PREFIX, content].join("\n");
