import { Schema } from "effect";
import { InvocationId } from "effect-zero-workflow/contract";
import { DeliveryKey } from "sheet-bot-api";
import { RoomOrdersNavigate, RoomOrdersSend } from "sheet-workflow-contracts";
import { roomOrderSheetWorkflowDefinitionVersion } from "./catalog";

export type RoomOrderNavigationDeliveryKind = "respond" | "edit-room-order-message";

export const makeRoomOrderNavigationClaimId = (invocationId: typeof InvocationId.Type): string =>
  `${RoomOrdersNavigate.identity}:${roomOrderSheetWorkflowDefinitionVersion}:${invocationId}:claim-navigation`;

export const makeRoomOrderNavigationDeliveryKey = (
  invocationId: typeof InvocationId.Type,
  kind: RoomOrderNavigationDeliveryKind,
): typeof DeliveryKey.Type =>
  Schema.decodeUnknownSync(DeliveryKey)(
    `${RoomOrdersNavigate.identity}:${roomOrderSheetWorkflowDefinitionVersion}:${invocationId}:${kind}`,
  );

export type RoomOrderSendDeliveryKind =
  | "send-room-order-message"
  | "pin-sent-room-order"
  | "respond";

export const makeRoomOrderSendClaimId = (invocationId: typeof InvocationId.Type): string =>
  `${RoomOrdersSend.identity}:${roomOrderSheetWorkflowDefinitionVersion}:${invocationId}:claim-send`;

export const makeRoomOrderSendDeliveryKey = (
  invocationId: typeof InvocationId.Type,
  kind: RoomOrderSendDeliveryKind,
): typeof DeliveryKey.Type =>
  Schema.decodeUnknownSync(DeliveryKey)(
    `${RoomOrdersSend.identity}:${roomOrderSheetWorkflowDefinitionVersion}:${invocationId}:${kind}`,
  );
