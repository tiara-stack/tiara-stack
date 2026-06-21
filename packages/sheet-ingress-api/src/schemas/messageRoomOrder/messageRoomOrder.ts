import { Schema } from "effect";
import { messageRoomOrder } from "sheet-db-schema/models";
import type {
  BooleanField,
  DateTimeOptionField,
  NumberField,
  StringArrayField,
  StringField,
  StringOptionField,
} from "../model";
import { modelTaggedFields, validateTaggedFields } from "../model";

const MessageRoomOrderFields = validateTaggedFields<{
  readonly clientPlatform: StringField;
  readonly clientId: StringField;
  readonly messageId: StringField;
  readonly previousFills: StringArrayField;
  readonly fills: StringArrayField;
  readonly hour: NumberField;
  readonly rank: NumberField;
  readonly tentative: BooleanField;
  readonly monitor: StringOptionField;
  readonly workspaceId: StringOptionField;
  readonly conversationId: StringOptionField;
  readonly createdByUserId: StringOptionField;
  readonly sendClaimId: StringOptionField;
  readonly sendClaimedAt: DateTimeOptionField;
  readonly sentMessageId: StringOptionField;
  readonly sentConversationId: StringOptionField;
  readonly sentAt: DateTimeOptionField;
  readonly tentativeUpdateClaimId: StringOptionField;
  readonly tentativeUpdateClaimedAt: DateTimeOptionField;
  readonly tentativePinClaimId: StringOptionField;
  readonly tentativePinClaimedAt: DateTimeOptionField;
  readonly tentativePinnedAt: DateTimeOptionField;
  readonly createdAt: DateTimeOptionField;
  readonly updatedAt: DateTimeOptionField;
  readonly deletedAt: DateTimeOptionField;
}>(modelTaggedFields(messageRoomOrder), [
  "clientPlatform",
  "clientId",
  "messageId",
  "previousFills",
  "fills",
  "hour",
  "rank",
  "tentative",
  "monitor",
  "workspaceId",
  "conversationId",
  "createdByUserId",
  "sendClaimId",
  "sendClaimedAt",
  "sentMessageId",
  "sentConversationId",
  "sentAt",
  "tentativeUpdateClaimId",
  "tentativeUpdateClaimedAt",
  "tentativePinClaimId",
  "tentativePinClaimedAt",
  "tentativePinnedAt",
  "createdAt",
  "updatedAt",
  "deletedAt",
] as const);

export class MessageRoomOrder extends Schema.TaggedClass<MessageRoomOrder>()(
  "MessageRoomOrder",
  MessageRoomOrderFields,
) {}
