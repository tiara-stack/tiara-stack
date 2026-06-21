import { Schema } from "effect";
import { messageSlot } from "sheet-db-schema/models";
import type { DateTimeOptionField, NumberField, StringField, StringOptionField } from "../model";
import { modelTaggedFields, validateTaggedFields } from "../model";

const MessageSlotFields = validateTaggedFields<{
  readonly clientPlatform: StringField;
  readonly clientId: StringField;
  readonly messageId: StringField;
  readonly day: NumberField;
  readonly workspaceId: StringOptionField;
  readonly conversationId: StringOptionField;
  readonly createdByUserId: StringOptionField;
  readonly createdAt: DateTimeOptionField;
  readonly updatedAt: DateTimeOptionField;
  readonly deletedAt: DateTimeOptionField;
}>(modelTaggedFields(messageSlot), [
  "clientPlatform",
  "clientId",
  "messageId",
  "day",
  "workspaceId",
  "conversationId",
  "createdByUserId",
  "createdAt",
  "updatedAt",
  "deletedAt",
] as const);

export class MessageSlot extends Schema.TaggedClass<MessageSlot>()(
  "MessageSlot",
  MessageSlotFields,
) {}
