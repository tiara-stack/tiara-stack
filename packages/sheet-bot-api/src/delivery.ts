import { Schema } from "effect";
import {
  BotOutboundMessage,
  BotSemanticFileBinding,
  maximumBotFileEvidenceByteLength,
  maximumBotFileEvidenceTextLength,
  maximumBotOutboundFileCount,
} from "./message";
import {
  ConversationRef,
  ClientUserRef,
  DeliveryKey,
  MessageRef,
  ResponseReference,
  WorkspaceRef,
} from "./references";

export const BotDeliveryOperation = Schema.Literals([
  "respond",
  "sendMessage",
  "sendDirectMessage",
  "editMessage",
  "deleteMessage",
  "setMessagePinned",
  "setMessageReaction",
  "setMemberRole",
  "replaceConversationPermissionOverwrites",
]);
export type BotDeliveryOperation = Schema.Schema.Type<typeof BotDeliveryOperation>;

export const BotEmoji = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.String,
});
export type BotEmoji = Schema.Schema.Type<typeof BotEmoji>;

export const BotPermissionOverwrite = Schema.Struct({
  targetId: Schema.String,
  targetKind: Schema.Literals(["role", "member"]),
  allow: Schema.String.check(Schema.isPattern(/^\d+$/)),
  deny: Schema.String.check(Schema.isPattern(/^\d+$/)),
});
export type BotPermissionOverwrite = Schema.Schema.Type<typeof BotPermissionOverwrite>;

const ResponseTarget = Schema.TaggedStruct("Response", {
  responseReference: ResponseReference,
  message: Schema.optional(MessageRef),
});

const MessageTarget = Schema.TaggedStruct("Message", { message: MessageRef });

const DirectMessageTarget = Schema.TaggedStruct("DirectMessage", {
  recipient: ClientUserRef,
  message: MessageRef,
});

const ConversationTarget = Schema.TaggedStruct("Conversation", {
  conversation: ConversationRef,
});

const MemberRoleTarget = Schema.TaggedStruct("MemberRole", {
  workspace: WorkspaceRef,
  userId: Schema.String,
  roleId: Schema.String,
});

const BoundedFileEvidenceText = Schema.String.check(
  Schema.isMaxLength(maximumBotFileEvidenceTextLength),
);
const BoundedFileEvidenceByteLength = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: maximumBotFileEvidenceByteLength }),
);

export const BotDeliveredFileEvidence = Schema.Struct({
  name: BoundedFileEvidenceText,
  contentType: BoundedFileEvidenceText,
  byteLength: BoundedFileEvidenceByteLength,
  deliveryBinding: Schema.optional(BotSemanticFileBinding),
});
export type BotDeliveredFileEvidence = Schema.Schema.Type<typeof BotDeliveredFileEvidence>;

export const BotDeliveryTarget = Schema.Union([
  ResponseTarget,
  MessageTarget,
  DirectMessageTarget,
  ConversationTarget,
  MemberRoleTarget,
]);
export type BotDeliveryTarget = Schema.Schema.Type<typeof BotDeliveryTarget>;

export const RespondReceipt = Schema.Struct({
  deliveryKey: DeliveryKey,
  operation: Schema.Literal("respond"),
  target: ResponseTarget,
  files: Schema.optional(
    Schema.Array(BotDeliveredFileEvidence).check(Schema.isMaxLength(maximumBotOutboundFileCount)),
  ),
});
export type RespondReceipt = Schema.Schema.Type<typeof RespondReceipt>;

const makeMessageReceipt = <
  Operation extends Exclude<
    BotDeliveryOperation,
    "respond" | "setMemberRole" | "replaceConversationPermissionOverwrites"
  >,
>(
  operation: Operation,
) =>
  Schema.Struct({
    deliveryKey: DeliveryKey,
    operation: Schema.Literal(operation),
    target: MessageTarget,
  });

export const SendMessageReceipt = makeMessageReceipt("sendMessage");
export type SendMessageReceipt = Schema.Schema.Type<typeof SendMessageReceipt>;

export const SendDirectMessageReceipt = Schema.Struct({
  deliveryKey: DeliveryKey,
  operation: Schema.Literal("sendDirectMessage"),
  target: DirectMessageTarget,
});
export type SendDirectMessageReceipt = Schema.Schema.Type<typeof SendDirectMessageReceipt>;

export const EditMessageReceipt = makeMessageReceipt("editMessage");
export type EditMessageReceipt = Schema.Schema.Type<typeof EditMessageReceipt>;

export const DeleteMessageReceipt = makeMessageReceipt("deleteMessage");
export type DeleteMessageReceipt = Schema.Schema.Type<typeof DeleteMessageReceipt>;

export const SetMessagePinnedReceipt = makeMessageReceipt("setMessagePinned");
export type SetMessagePinnedReceipt = Schema.Schema.Type<typeof SetMessagePinnedReceipt>;

export const SetMessageReactionReceipt = makeMessageReceipt("setMessageReaction");
export type SetMessageReactionReceipt = Schema.Schema.Type<typeof SetMessageReactionReceipt>;

export const SetMemberRoleReceipt = Schema.Struct({
  deliveryKey: DeliveryKey,
  operation: Schema.Literal("setMemberRole"),
  target: MemberRoleTarget,
});
export type SetMemberRoleReceipt = Schema.Schema.Type<typeof SetMemberRoleReceipt>;

export const ReplaceConversationPermissionOverwritesReceipt = Schema.Struct({
  deliveryKey: DeliveryKey,
  operation: Schema.Literal("replaceConversationPermissionOverwrites"),
  target: ConversationTarget,
});
export type ReplaceConversationPermissionOverwritesReceipt = Schema.Schema.Type<
  typeof ReplaceConversationPermissionOverwritesReceipt
>;

export const DeliveryReceipt = Schema.Union([
  RespondReceipt,
  SendMessageReceipt,
  SendDirectMessageReceipt,
  EditMessageReceipt,
  DeleteMessageReceipt,
  SetMessagePinnedReceipt,
  SetMessageReactionReceipt,
  SetMemberRoleReceipt,
  ReplaceConversationPermissionOverwritesReceipt,
]);
export type DeliveryReceipt = Schema.Schema.Type<typeof DeliveryReceipt>;

export const RespondInput = Schema.Struct({
  responseReference: ResponseReference,
  deliveryKey: DeliveryKey,
  message: BotOutboundMessage,
  workspace: Schema.optional(WorkspaceRef),
});
export type RespondInput = Schema.Schema.Type<typeof RespondInput>;

export const SendMessageInput = Schema.Struct({
  conversation: ConversationRef,
  deliveryKey: DeliveryKey,
  message: BotOutboundMessage,
});
export type SendMessageInput = Schema.Schema.Type<typeof SendMessageInput>;

export const SendDirectMessageInput = Schema.Struct({
  recipient: ClientUserRef,
  deliveryKey: DeliveryKey,
  message: BotOutboundMessage,
});
export type SendDirectMessageInput = Schema.Schema.Type<typeof SendDirectMessageInput>;

export const EditMessageInput = Schema.Struct({
  message: MessageRef,
  deliveryKey: DeliveryKey,
  content: BotOutboundMessage,
});
export type EditMessageInput = Schema.Schema.Type<typeof EditMessageInput>;

export const DeleteMessageInput = Schema.Struct({
  message: MessageRef,
  deliveryKey: DeliveryKey,
});
export type DeleteMessageInput = Schema.Schema.Type<typeof DeleteMessageInput>;

export const SetMessagePinnedInput = Schema.Struct({
  message: MessageRef,
  deliveryKey: DeliveryKey,
  present: Schema.Boolean,
});
export type SetMessagePinnedInput = Schema.Schema.Type<typeof SetMessagePinnedInput>;

export const SetMessageReactionInput = Schema.Struct({
  message: MessageRef,
  deliveryKey: DeliveryKey,
  emoji: BotEmoji,
  present: Schema.Boolean,
});
export type SetMessageReactionInput = Schema.Schema.Type<typeof SetMessageReactionInput>;

export const SetMemberRoleInput = Schema.Struct({
  workspace: WorkspaceRef,
  deliveryKey: DeliveryKey,
  userId: Schema.String,
  roleId: Schema.String,
  present: Schema.Boolean,
});
export type SetMemberRoleInput = Schema.Schema.Type<typeof SetMemberRoleInput>;

export const ReplaceConversationPermissionOverwritesInput = Schema.Struct({
  conversation: ConversationRef,
  deliveryKey: DeliveryKey,
  permissionOverwrites: Schema.Array(BotPermissionOverwrite),
});
export type ReplaceConversationPermissionOverwritesInput = Schema.Schema.Type<
  typeof ReplaceConversationPermissionOverwritesInput
>;
