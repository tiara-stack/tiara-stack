export const CHECKIN_ACTION_ID = "interaction:checkin";
export const SLOT_OPEN_ACTION_ID = "interaction:slot";

export const ROOM_ORDER_PREVIOUS_ACTION_ID = "interaction:roomOrder:previous";
export const ROOM_ORDER_NEXT_ACTION_ID = "interaction:roomOrder:next";
export const ROOM_ORDER_SEND_ACTION_ID = "interaction:roomOrder:send";
export const ROOM_ORDER_TENTATIVE_PIN_ACTION_ID = "interaction:roomOrder:pinTentative";
export const TEAM_SUBMISSION_CONFIRM_ACTION_ID = "interaction:teamSubmission:confirm";
export const TEAM_SUBMISSION_REJECT_ACTION_ID = "interaction:teamSubmission:reject";

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
