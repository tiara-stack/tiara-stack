import { Schema } from "effect";
import { InvocationId } from "effect-zero-workflow/contract";
import { DeliveryKey } from "sheet-bot-api";
import {
  RoomOrdersCreate,
  RoomOrdersNavigate,
  RoomOrdersPinTentative,
  RoomOrdersSend,
} from "sheet-workflow-contracts";
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

export type RoomOrderCreateDeliveryKind =
  | "publish-room-order-draft"
  | "delete-provisional-room-order"
  | "finalize-room-order-message";

export const makeRoomOrderCreateDeliveryKey = (
  invocationId: typeof InvocationId.Type,
  kind: RoomOrderCreateDeliveryKind,
): typeof DeliveryKey.Type =>
  Schema.decodeUnknownSync(DeliveryKey)(
    `${RoomOrdersCreate.identity}:${roomOrderSheetWorkflowDefinitionVersion}:${invocationId}:${kind}`,
  );

export type RoomOrderTentativePinDeliveryKind =
  | "pin-tentative-room-order"
  | "finalize-tentative-room-order"
  | "respond";

export const makeRoomOrderTentativePinClaimId = (invocationId: typeof InvocationId.Type): string =>
  `${RoomOrdersPinTentative.identity}:${roomOrderSheetWorkflowDefinitionVersion}:${invocationId}:claim-tentative-pin`;

export const makeRoomOrderTentativePinDeliveryKey = (
  invocationId: typeof InvocationId.Type,
  kind: RoomOrderTentativePinDeliveryKind,
): typeof DeliveryKey.Type =>
  Schema.decodeUnknownSync(DeliveryKey)(
    `${RoomOrdersPinTentative.identity}:${roomOrderSheetWorkflowDefinitionVersion}:${invocationId}:${kind}`,
  );
