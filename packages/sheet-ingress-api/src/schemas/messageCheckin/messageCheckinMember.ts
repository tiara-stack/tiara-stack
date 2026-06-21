import { Schema } from "effect";
import { messageCheckinMember } from "sheet-db-schema/models";
import type { DateTimeOptionField, StringField, StringOptionField } from "../model";
import { modelTaggedFields, validateTaggedFields } from "../model";

const MessageCheckinMemberFields = validateTaggedFields<{
  readonly clientPlatform: StringField;
  readonly clientId: StringField;
  readonly messageId: StringField;
  readonly memberId: StringField;
  readonly checkinAt: DateTimeOptionField;
  readonly checkinClaimId: StringOptionField;
  readonly createdAt: DateTimeOptionField;
  readonly updatedAt: DateTimeOptionField;
  readonly deletedAt: DateTimeOptionField;
}>(modelTaggedFields(messageCheckinMember), [
  "clientPlatform",
  "clientId",
  "messageId",
  "memberId",
  "checkinAt",
  "checkinClaimId",
  "createdAt",
  "updatedAt",
  "deletedAt",
] as const);

export class MessageCheckinMember extends Schema.TaggedClass<MessageCheckinMember>()(
  "MessageCheckinMember",
  MessageCheckinMemberFields,
) {}
