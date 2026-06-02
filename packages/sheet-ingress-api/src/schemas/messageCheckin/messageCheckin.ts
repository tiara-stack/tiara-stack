import { Schema } from "effect";
import { messageCheckin } from "sheet-db-schema/models";
import type { DateTimeOptionField, NumberField, StringField, StringOptionField } from "../model";
import { modelTaggedFields, validateTaggedFields } from "../model";

const MessageCheckinFields = validateTaggedFields<{
  readonly messageId: StringField;
  readonly initialMessage: StringField;
  readonly hour: NumberField;
  readonly channelId: StringField;
  readonly roleId: StringOptionField;
  readonly guildId: StringOptionField;
  readonly messageChannelId: StringOptionField;
  readonly createdByUserId: StringOptionField;
  readonly createdAt: DateTimeOptionField;
  readonly updatedAt: DateTimeOptionField;
  readonly deletedAt: DateTimeOptionField;
}>(modelTaggedFields(messageCheckin), [
  "messageId",
  "initialMessage",
  "hour",
  "channelId",
  "roleId",
  "guildId",
  "messageChannelId",
  "createdByUserId",
  "createdAt",
  "updatedAt",
  "deletedAt",
] as const);

export class MessageCheckin extends Schema.TaggedClass<MessageCheckin>()(
  "MessageCheckin",
  MessageCheckinFields,
) {}
