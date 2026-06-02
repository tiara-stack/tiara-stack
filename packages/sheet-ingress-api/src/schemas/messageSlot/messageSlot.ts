import { Schema } from "effect";
import { messageSlot } from "sheet-db-schema/models";
import type { DateTimeOptionField, NumberField, StringField, StringOptionField } from "../model";
import { modelTaggedFields, validateTaggedFields } from "../model";

const MessageSlotFields = validateTaggedFields<{
  readonly messageId: StringField;
  readonly day: NumberField;
  readonly guildId: StringOptionField;
  readonly messageChannelId: StringOptionField;
  readonly createdByUserId: StringOptionField;
  readonly createdAt: DateTimeOptionField;
  readonly updatedAt: DateTimeOptionField;
  readonly deletedAt: DateTimeOptionField;
}>(modelTaggedFields(messageSlot), [
  "messageId",
  "day",
  "guildId",
  "messageChannelId",
  "createdByUserId",
  "createdAt",
  "updatedAt",
  "deletedAt",
] as const);

export class MessageSlot extends Schema.TaggedClass<MessageSlot>()(
  "MessageSlot",
  MessageSlotFields,
) {}
