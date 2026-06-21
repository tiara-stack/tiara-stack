import { Schema } from "effect";
import { messageCheckin } from "sheet-db-schema/models";
import type { DateTimeOptionField, NumberField, StringField, StringOptionField } from "../model";
import { modelTaggedFields, validateTaggedFields } from "../model";
import { SheetTextPart } from "../client";

const MessageCheckinFields = validateTaggedFields<{
  readonly clientPlatform: StringField;
  readonly clientId: StringField;
  readonly messageId: StringField;
  readonly initialMessage: Schema.Codec<ReadonlyArray<SheetTextPart>>;
  readonly hour: NumberField;
  readonly runningConversationId: StringField;
  readonly roleId: StringOptionField;
  readonly workspaceId: StringOptionField;
  readonly conversationId: StringOptionField;
  readonly createdByUserId: StringOptionField;
  readonly createdAt: DateTimeOptionField;
  readonly updatedAt: DateTimeOptionField;
  readonly deletedAt: DateTimeOptionField;
}>(
  modelTaggedFields(messageCheckin, {
    overrides: { initialMessage: Schema.Array(SheetTextPart) },
  }),
  [
    "clientPlatform",
    "clientId",
    "messageId",
    "initialMessage",
    "hour",
    "runningConversationId",
    "roleId",
    "workspaceId",
    "conversationId",
    "createdByUserId",
    "createdAt",
    "updatedAt",
    "deletedAt",
  ] as const,
);

export class MessageCheckin extends Schema.TaggedClass<MessageCheckin>()(
  "MessageCheckin",
  MessageCheckinFields,
) {}
