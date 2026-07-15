import {
  getAuthorizedMessageCheckinMembers,
  requireMessageCheckinMonitor,
  requireMessageCheckinParticipantMutation,
  requireMessageCheckinRead,
  requireMessageCheckinUpsert,
  requireMessageSlotRead,
  requireMessageSlotUpsert,
  requireRoomOrderMonitor,
  requireRoomOrderUpsert,
} from "../authorization";
import { Predicate } from "effect";
import { authorizedSheetApis } from "../sheetApisProxy";
import type { IngressHandlerTable } from "../types";

const optionalWorkspaceId = (workspaceId: unknown) =>
  Predicate.isString(workspaceId) ? workspaceId : undefined;

export const messageHandlers = {
  messageCheckin: (handlers) =>
    handlers
      .handle(
        "getMessageCheckinData",
        authorizedSheetApis("messageCheckin", "getMessageCheckinData", ({ query }) =>
          requireMessageCheckinRead(query.messageId),
        ),
      )
      .handle(
        "upsertMessageCheckinData",
        authorizedSheetApis("messageCheckin", "upsertMessageCheckinData", ({ payload }) =>
          requireMessageCheckinUpsert(
            payload.messageId,
            optionalWorkspaceId(payload.data.workspaceId),
          ),
        ),
      )
      .handle("getMessageCheckinMembers", ({ query }) =>
        getAuthorizedMessageCheckinMembers(query.messageId),
      )
      .handle(
        "addMessageCheckinMembers",
        authorizedSheetApis("messageCheckin", "addMessageCheckinMembers", ({ payload }) =>
          requireMessageCheckinMonitor(payload.messageId),
        ),
      )
      .handle(
        "persistMessageCheckin",
        authorizedSheetApis("messageCheckin", "persistMessageCheckin", ({ payload }) =>
          requireMessageCheckinUpsert(
            payload.messageId,
            optionalWorkspaceId(payload.data.workspaceId),
          ),
        ),
      )
      .handle(
        "setMessageCheckinMemberCheckinAt",
        authorizedSheetApis("messageCheckin", "setMessageCheckinMemberCheckinAt", ({ payload }) =>
          requireMessageCheckinParticipantMutation(payload.messageId, payload.memberId),
        ),
      )
      .handle(
        "setMessageCheckinMemberCheckinAtIfUnset",
        authorizedSheetApis(
          "messageCheckin",
          "setMessageCheckinMemberCheckinAtIfUnset",
          ({ payload }) =>
            requireMessageCheckinParticipantMutation(payload.messageId, payload.memberId),
        ),
      )
      .handle(
        "removeMessageCheckinMember",
        authorizedSheetApis("messageCheckin", "removeMessageCheckinMember", ({ payload }) =>
          requireMessageCheckinParticipantMutation(payload.messageId, payload.memberId),
        ),
      )
      .handle(
        "removeMessageCheckin",
        authorizedSheetApis("messageCheckin", "removeMessageCheckin", ({ payload }) =>
          requireMessageCheckinMonitor(payload.messageId),
        ),
      ),
  messageRoomOrder: (handlers) =>
    handlers
      .handle(
        "getMessageRoomOrder",
        authorizedSheetApis("messageRoomOrder", "getMessageRoomOrder", ({ query }) =>
          requireRoomOrderMonitor(query.messageId),
        ),
      )
      .handle(
        "upsertMessageRoomOrder",
        authorizedSheetApis("messageRoomOrder", "upsertMessageRoomOrder", ({ payload }) =>
          requireRoomOrderUpsert(payload.messageId, optionalWorkspaceId(payload.data.workspaceId)),
        ),
      )
      .handle(
        "persistMessageRoomOrder",
        authorizedSheetApis("messageRoomOrder", "persistMessageRoomOrder", ({ payload }) =>
          requireRoomOrderUpsert(payload.messageId, optionalWorkspaceId(payload.data.workspaceId)),
        ),
      )
      .handle(
        "decrementMessageRoomOrderRank",
        authorizedSheetApis("messageRoomOrder", "decrementMessageRoomOrderRank", ({ payload }) =>
          requireRoomOrderMonitor(payload.messageId),
        ),
      )
      .handle(
        "incrementMessageRoomOrderRank",
        authorizedSheetApis("messageRoomOrder", "incrementMessageRoomOrderRank", ({ payload }) =>
          requireRoomOrderMonitor(payload.messageId),
        ),
      )
      .handle(
        "getMessageRoomOrderEntry",
        authorizedSheetApis("messageRoomOrder", "getMessageRoomOrderEntry", ({ query }) =>
          requireRoomOrderMonitor(query.messageId),
        ),
      )
      .handle(
        "getMessageRoomOrderRange",
        authorizedSheetApis("messageRoomOrder", "getMessageRoomOrderRange", ({ query }) =>
          requireRoomOrderMonitor(query.messageId),
        ),
      )
      .handle(
        "upsertMessageRoomOrderEntry",
        authorizedSheetApis("messageRoomOrder", "upsertMessageRoomOrderEntry", ({ payload }) =>
          requireRoomOrderMonitor(payload.messageId),
        ),
      )
      .handle(
        "removeMessageRoomOrderEntry",
        authorizedSheetApis("messageRoomOrder", "removeMessageRoomOrderEntry", ({ payload }) =>
          requireRoomOrderMonitor(payload.messageId),
        ),
      )
      .handle(
        "claimMessageRoomOrderSend",
        authorizedSheetApis("messageRoomOrder", "claimMessageRoomOrderSend", ({ payload }) =>
          requireRoomOrderMonitor(payload.messageId),
        ),
      )
      .handle(
        "completeMessageRoomOrderSend",
        authorizedSheetApis("messageRoomOrder", "completeMessageRoomOrderSend", ({ payload }) =>
          requireRoomOrderMonitor(payload.messageId),
        ),
      )
      .handle(
        "releaseMessageRoomOrderSendClaim",
        authorizedSheetApis("messageRoomOrder", "releaseMessageRoomOrderSendClaim", ({ payload }) =>
          requireRoomOrderMonitor(payload.messageId),
        ),
      )
      .handle(
        "claimMessageRoomOrderTentativeUpdate",
        authorizedSheetApis(
          "messageRoomOrder",
          "claimMessageRoomOrderTentativeUpdate",
          ({ payload }) => requireRoomOrderMonitor(payload.messageId),
        ),
      )
      .handle(
        "releaseMessageRoomOrderTentativeUpdateClaim",
        authorizedSheetApis(
          "messageRoomOrder",
          "releaseMessageRoomOrderTentativeUpdateClaim",
          ({ payload }) => requireRoomOrderMonitor(payload.messageId),
        ),
      )
      .handle(
        "claimMessageRoomOrderTentativePin",
        authorizedSheetApis(
          "messageRoomOrder",
          "claimMessageRoomOrderTentativePin",
          ({ payload }) => requireRoomOrderMonitor(payload.messageId),
        ),
      )
      .handle(
        "completeMessageRoomOrderTentativePin",
        authorizedSheetApis(
          "messageRoomOrder",
          "completeMessageRoomOrderTentativePin",
          ({ payload }) => requireRoomOrderMonitor(payload.messageId),
        ),
      )
      .handle(
        "releaseMessageRoomOrderTentativePinClaim",
        authorizedSheetApis(
          "messageRoomOrder",
          "releaseMessageRoomOrderTentativePinClaim",
          ({ payload }) => requireRoomOrderMonitor(payload.messageId),
        ),
      )
      .handle(
        "markMessageRoomOrderTentative",
        authorizedSheetApis("messageRoomOrder", "markMessageRoomOrderTentative", ({ payload }) =>
          requireRoomOrderMonitor(payload.messageId),
        ),
      ),
  messageSlot: (handlers) =>
    handlers
      .handle(
        "getMessageSlotData",
        authorizedSheetApis("messageSlot", "getMessageSlotData", ({ query }) =>
          requireMessageSlotRead(query.messageId),
        ),
      )
      .handle(
        "upsertMessageSlotData",
        authorizedSheetApis("messageSlot", "upsertMessageSlotData", ({ payload }) =>
          requireMessageSlotUpsert(
            payload.messageId,
            optionalWorkspaceId(payload.data.workspaceId),
          ),
        ),
      ),
} satisfies Pick<IngressHandlerTable, "messageCheckin" | "messageRoomOrder" | "messageSlot">;
