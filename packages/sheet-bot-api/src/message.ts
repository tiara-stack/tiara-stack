import { Schema } from "effect";
import { ConversationRef, MessageRef, WorkspaceRef } from "./references";

export const BotTimestampStyle = Schema.Literals([
  "shortTime",
  "longTime",
  "shortDate",
  "longDate",
  "relative",
]);
export type BotTimestampStyle = Schema.Schema.Type<typeof BotTimestampStyle>;

export const BotClientTerm = Schema.Literals([
  "workspace",
  "conversation",
  "runDestination",
  "checkinDestination",
  "monitorRole",
  "lockdownRole",
  "message",
  "testRun",
]);
export type BotClientTerm = Schema.Schema.Type<typeof BotClientTerm>;

export const BotClientTermForm = Schema.Literals(["singular", "plural"]);
export type BotClientTermForm = Schema.Schema.Type<typeof BotClientTermForm>;

export const BotClientTermCasing = Schema.Literals(["lower", "sentence"]);
export type BotClientTermCasing = Schema.Schema.Type<typeof BotClientTermCasing>;

export type BotTextPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "userMention"; readonly userId: string }
  | { readonly type: "conversationMention"; readonly conversation: ConversationRef }
  | { readonly type: "roleMention"; readonly workspace: WorkspaceRef; readonly roleId: string }
  | { readonly type: "messageLink"; readonly message: MessageRef; readonly label?: string }
  | { readonly type: "timestamp"; readonly epochMs: number; readonly style?: BotTimestampStyle }
  | { readonly type: "strong"; readonly parts: ReadonlyArray<BotTextPart> }
  | { readonly type: "inlineCode"; readonly text: string }
  | { readonly type: "strikethrough"; readonly parts: ReadonlyArray<BotTextPart> }
  | { readonly type: "subtle"; readonly parts: ReadonlyArray<BotTextPart> }
  | { readonly type: "externalLink"; readonly url: string; readonly label?: string }
  | {
      readonly type: "clientTerm";
      readonly term: BotClientTerm;
      readonly form?: BotClientTermForm;
      readonly casing?: BotClientTermCasing;
    };

export const BotTextPart: Schema.Codec<BotTextPart> = Schema.suspend(
  (): Schema.Codec<BotTextPart> =>
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
      Schema.Struct({ type: Schema.Literal("userMention"), userId: Schema.String }),
      Schema.Struct({
        type: Schema.Literal("conversationMention"),
        conversation: ConversationRef,
      }),
      Schema.Struct({
        type: Schema.Literal("roleMention"),
        workspace: WorkspaceRef,
        roleId: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literal("messageLink"),
        message: MessageRef,
        label: Schema.optional(Schema.String),
      }),
      Schema.Struct({
        type: Schema.Literal("timestamp"),
        epochMs: Schema.Number,
        style: Schema.optional(BotTimestampStyle),
      }),
      Schema.Struct({ type: Schema.Literal("strong"), parts: Schema.Array(BotTextPart) }),
      Schema.Struct({ type: Schema.Literal("inlineCode"), text: Schema.String }),
      Schema.Struct({ type: Schema.Literal("strikethrough"), parts: Schema.Array(BotTextPart) }),
      Schema.Struct({ type: Schema.Literal("subtle"), parts: Schema.Array(BotTextPart) }),
      Schema.Struct({
        type: Schema.Literal("externalLink"),
        url: Schema.String,
        label: Schema.optional(Schema.String),
      }),
      Schema.Struct({
        type: Schema.Literal("clientTerm"),
        term: BotClientTerm,
        form: Schema.optional(BotClientTermForm),
        casing: Schema.optional(BotClientTermCasing),
      }),
    ]) as Schema.Codec<BotTextPart>,
);

export const BotText = Schema.Union([Schema.String, Schema.Array(BotTextPart)]);
export type BotText = Schema.Schema.Type<typeof BotText>;

export const BotActionButton = Schema.Struct({
  type: Schema.Literal("button"),
  actionId: Schema.String,
  label: Schema.String,
  style: Schema.optional(Schema.Literals(["primary", "secondary", "success", "danger"])),
  disabled: Schema.optional(Schema.Boolean),
  emoji: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      name: Schema.String,
    }),
  ),
});
export type BotActionButton = Schema.Schema.Type<typeof BotActionButton>;

export const BotMessageActionRow = Schema.Struct({
  type: Schema.Literal("actionRow"),
  components: Schema.Array(BotActionButton),
});
export type BotMessageActionRow = Schema.Schema.Type<typeof BotMessageActionRow>;

export const BotMessageEmbed = Schema.Struct({
  title: Schema.optional(BotText),
  description: Schema.optional(Schema.NullOr(BotText)),
  fields: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: BotText,
        value: BotText,
        inline: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
  footer: Schema.optional(Schema.Struct({ text: BotText })),
  color: Schema.optional(Schema.Number),
});
export type BotMessageEmbed = Schema.Schema.Type<typeof BotMessageEmbed>;

export const BotOutboundFile = Schema.Struct({
  name: Schema.String,
  contentType: Schema.String,
  content: Schema.Uint8ArrayFromBase64,
});
export type BotOutboundFile = Schema.Schema.Type<typeof BotOutboundFile>;

export const BotOutboundMessage = Schema.Struct({
  content: Schema.optional(Schema.NullOr(BotText)),
  embeds: Schema.optional(Schema.Array(BotMessageEmbed)),
  components: Schema.optional(Schema.Array(BotMessageActionRow)),
  files: Schema.optional(Schema.Array(BotOutboundFile)),
  messageReference: Schema.optional(
    Schema.Struct({
      message: MessageRef,
      failIfNotExists: Schema.optional(Schema.Boolean),
    }),
  ),
  visibility: Schema.optional(Schema.Literals(["public", "ephemeral"])),
  allowedMentions: Schema.optional(Schema.Literals(["none", "default"])),
});
export type BotOutboundMessage = Schema.Schema.Type<typeof BotOutboundMessage>;

/** @deprecated Use BotTimestampStyle instead. */
export const SheetTimestampStyle = BotTimestampStyle;
/** @deprecated Use BotTimestampStyle instead. */
export type SheetTimestampStyle = BotTimestampStyle;

/** @deprecated Use BotClientTerm instead. */
export const SheetClientTerm = BotClientTerm;
/** @deprecated Use BotClientTerm instead. */
export type SheetClientTerm = BotClientTerm;

/** @deprecated Use BotClientTermForm instead. */
export const SheetClientTermForm = BotClientTermForm;
/** @deprecated Use BotClientTermForm instead. */
export type SheetClientTermForm = BotClientTermForm;

/** @deprecated Use BotClientTermCasing instead. */
export const SheetClientTermCasing = BotClientTermCasing;
/** @deprecated Use BotClientTermCasing instead. */
export type SheetClientTermCasing = BotClientTermCasing;

/** @deprecated Use BotTextPart instead. */
export const SheetTextPart = BotTextPart;
/** @deprecated Use BotTextPart instead. */
export type SheetTextPart = BotTextPart;

/** @deprecated Use BotText instead. */
export const SheetText = BotText;
/** @deprecated Use BotText instead. */
export type SheetText = BotText;

/** @deprecated Use BotActionButton instead. */
export const SheetActionButton = BotActionButton;
/** @deprecated Use BotActionButton instead. */
export type SheetActionButton = BotActionButton;

/** @deprecated Use BotMessageActionRow instead. */
export const SheetMessageActionRow = BotMessageActionRow;
/** @deprecated Use BotMessageActionRow instead. */
export type SheetMessageActionRow = BotMessageActionRow;

/** @deprecated Represents BotMessageActionRow, not a component union. Use BotMessageActionRow instead. */
export const SheetMessageComponent = BotMessageActionRow;
/** @deprecated Represents BotMessageActionRow, not a component union. Use BotMessageActionRow instead. */
export type SheetMessageComponent = BotMessageActionRow;

/** @deprecated Use BotMessageEmbed instead. */
export const SheetMessageEmbed = BotMessageEmbed;
/** @deprecated Use BotMessageEmbed instead. */
export type SheetMessageEmbed = BotMessageEmbed;

/** @deprecated Use BotOutboundFile instead. */
export const SheetOutboundFile = BotOutboundFile;
/** @deprecated Use BotOutboundFile instead. */
export type SheetOutboundFile = BotOutboundFile;

/** @deprecated Use BotOutboundMessage instead. */
export const SheetOutboundMessage = Schema.Struct({
  ...BotOutboundMessage.fields,
  nonce: Schema.optional(Schema.NullOr(Schema.Union([Schema.Number, Schema.String]))),
  enforceNonce: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
/** @deprecated Use BotOutboundMessage instead. */
export type SheetOutboundMessage = Schema.Schema.Type<typeof SheetOutboundMessage>;
