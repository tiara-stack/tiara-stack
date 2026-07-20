import { Schema } from "effect";
import { ConversationRef, MessageRef, WorkspaceRef } from "./clientRefs";

export const SheetTimestampStyle = Schema.Literals([
  "shortTime",
  "longTime",
  "shortDate",
  "longDate",
  "relative",
]);

export type SheetTimestampStyle = Schema.Schema.Type<typeof SheetTimestampStyle>;

export const SheetClientTerm = Schema.Literals([
  "workspace",
  "conversation",
  "runDestination",
  "checkinDestination",
  "monitorRole",
  "lockdownRole",
  "message",
  "testRun",
]);

export type SheetClientTerm = Schema.Schema.Type<typeof SheetClientTerm>;

export const SheetClientTermForm = Schema.Literals(["singular", "plural"]);
export type SheetClientTermForm = Schema.Schema.Type<typeof SheetClientTermForm>;

export const SheetClientTermCasing = Schema.Literals(["lower", "sentence"]);
export type SheetClientTermCasing = Schema.Schema.Type<typeof SheetClientTermCasing>;

export type SheetTextPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "userMention"; readonly userId: string }
  | { readonly type: "conversationMention"; readonly conversation: ConversationRef }
  | { readonly type: "roleMention"; readonly workspace: WorkspaceRef; readonly roleId: string }
  | { readonly type: "messageLink"; readonly message: MessageRef; readonly label?: string }
  | { readonly type: "timestamp"; readonly epochMs: number; readonly style?: SheetTimestampStyle }
  | { readonly type: "strong"; readonly parts: ReadonlyArray<SheetTextPart> }
  | { readonly type: "inlineCode"; readonly text: string }
  | { readonly type: "strikethrough"; readonly parts: ReadonlyArray<SheetTextPart> }
  | { readonly type: "subtle"; readonly parts: ReadonlyArray<SheetTextPart> }
  | { readonly type: "externalLink"; readonly url: string; readonly label?: string }
  | {
      readonly type: "clientTerm";
      readonly term: SheetClientTerm;
      readonly form?: SheetClientTermForm;
      readonly casing?: SheetClientTermCasing;
    };

export const SheetTextPart: Schema.Codec<SheetTextPart> = Schema.suspend(
  (): Schema.Codec<SheetTextPart> =>
    Schema.Union([
      Schema.Struct({
        type: Schema.Literal("text"),
        text: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literal("userMention"),
        userId: Schema.String,
      }),
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
        style: Schema.optional(SheetTimestampStyle),
      }),
      Schema.Struct({
        type: Schema.Literal("strong"),
        parts: Schema.Array(SheetTextPart),
      }),
      Schema.Struct({
        type: Schema.Literal("inlineCode"),
        text: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literal("strikethrough"),
        parts: Schema.Array(SheetTextPart),
      }),
      Schema.Struct({
        type: Schema.Literal("subtle"),
        parts: Schema.Array(SheetTextPart),
      }),
      Schema.Struct({
        type: Schema.Literal("externalLink"),
        url: Schema.String,
        label: Schema.optional(Schema.String),
      }),
      Schema.Struct({
        type: Schema.Literal("clientTerm"),
        term: SheetClientTerm,
        form: Schema.optional(SheetClientTermForm),
        casing: Schema.optional(SheetClientTermCasing),
      }),
    ]) as Schema.Codec<SheetTextPart>,
);

export const SheetText = Schema.Union([Schema.String, Schema.Array(SheetTextPart)]);

export type SheetText = Schema.Schema.Type<typeof SheetText>;

export const SheetActionButton = Schema.Struct({
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

export type SheetActionButton = Schema.Schema.Type<typeof SheetActionButton>;

export const SheetMessageActionRow = Schema.Struct({
  type: Schema.Literal("actionRow"),
  components: Schema.Array(SheetActionButton),
});

export type SheetMessageActionRow = Schema.Schema.Type<typeof SheetMessageActionRow>;

export const SheetMessageComponent = SheetMessageActionRow;

export type SheetMessageComponent = Schema.Schema.Type<typeof SheetMessageComponent>;

export const SheetMessageEmbed = Schema.Struct({
  title: Schema.optional(SheetText),
  description: Schema.optional(Schema.NullOr(SheetText)),
  fields: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: SheetText,
        value: SheetText,
        inline: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
  footer: Schema.optional(Schema.Struct({ text: SheetText })),
  color: Schema.optional(Schema.Number),
});

export type SheetMessageEmbed = Schema.Schema.Type<typeof SheetMessageEmbed>;

export const SheetOutboundFile = Schema.Struct({
  name: Schema.String,
  contentType: Schema.String,
  content: Schema.Uint8ArrayFromBase64,
});

export type SheetOutboundFile = Schema.Schema.Type<typeof SheetOutboundFile>;

export const SheetOutboundMessage = Schema.Struct({
  content: Schema.optional(Schema.NullOr(SheetText)),
  embeds: Schema.optional(Schema.Array(SheetMessageEmbed)),
  components: Schema.optional(Schema.Array(SheetMessageComponent)),
  files: Schema.optional(Schema.Array(SheetOutboundFile)),
  messageReference: Schema.optional(
    Schema.Struct({
      message: MessageRef,
      failIfNotExists: Schema.optional(Schema.Boolean),
    }),
  ),
  visibility: Schema.optional(Schema.Literals(["public", "ephemeral"])),
  allowedMentions: Schema.optional(Schema.Literals(["none", "default"])),
  nonce: Schema.optional(Schema.NullOr(Schema.Union([Schema.Number, Schema.String]))),
  enforceNonce: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

export type SheetOutboundMessage = Schema.Schema.Type<typeof SheetOutboundMessage>;
