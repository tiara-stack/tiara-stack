import { Schema } from "effect";
import { messageRoomOrderEntry } from "sheet-db-schema/models";
import type { DateTimeOptionField, NumberField, StringArrayField, StringField } from "../model";
import { modelTaggedFields, validateTaggedFields } from "../model";

const MessageRoomOrderEntryFields = validateTaggedFields<{
  readonly clientPlatform: StringField;
  readonly clientId: StringField;
  readonly messageId: StringField;
  readonly rank: NumberField;
  readonly position: NumberField;
  readonly team: StringField;
  readonly tags: StringArrayField;
  readonly effectValue: NumberField;
  readonly createdAt: DateTimeOptionField;
  readonly updatedAt: DateTimeOptionField;
  readonly deletedAt: DateTimeOptionField;
}>(
  modelTaggedFields(messageRoomOrderEntry, {
    omit: new Set(["hour"]),
  }),
  [
    "clientPlatform",
    "clientId",
    "messageId",
    "rank",
    "position",
    "team",
    "tags",
    "effectValue",
    "createdAt",
    "updatedAt",
    "deletedAt",
  ] as const,
);

export class MessageRoomOrderEntry extends Schema.TaggedClass<MessageRoomOrderEntry>()(
  "MessageRoomOrderEntry",
  MessageRoomOrderEntryFields,
) {}
