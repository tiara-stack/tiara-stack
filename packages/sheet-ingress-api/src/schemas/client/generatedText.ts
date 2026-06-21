import { Schema } from "effect";
import {
  SheetClientTerm,
  SheetClientTermCasing,
  SheetClientTermForm,
  SheetTimestampStyle,
  type SheetClientTerm as SheetClientTermType,
  type SheetClientTermCasing as SheetClientTermCasingType,
  type SheetClientTermForm as SheetClientTermFormType,
  type SheetTimestampStyle as SheetTimestampStyleType,
} from "./outboundMessage";

export type GeneratedSheetTextPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "userMention"; readonly userId: string }
  | { readonly type: "conversationMention"; readonly conversationId: string }
  | {
      readonly type: "timestamp";
      readonly epochMs: number;
      readonly style?: SheetTimestampStyleType;
    }
  | { readonly type: "strong"; readonly parts: ReadonlyArray<GeneratedSheetTextPart> }
  | { readonly type: "inlineCode"; readonly text: string }
  | { readonly type: "strikethrough"; readonly parts: ReadonlyArray<GeneratedSheetTextPart> }
  | { readonly type: "subtle"; readonly parts: ReadonlyArray<GeneratedSheetTextPart> }
  | { readonly type: "externalLink"; readonly url: string; readonly label?: string }
  | {
      readonly type: "clientTerm";
      readonly term: SheetClientTermType;
      readonly form?: SheetClientTermFormType;
      readonly casing?: SheetClientTermCasingType;
    };

export const GeneratedSheetTextPart: Schema.Codec<GeneratedSheetTextPart> = Schema.suspend(
  (): Schema.Codec<GeneratedSheetTextPart> =>
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
        conversationId: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literal("timestamp"),
        epochMs: Schema.Number,
        style: Schema.optional(SheetTimestampStyle),
      }),
      Schema.Struct({
        type: Schema.Literal("strong"),
        parts: Schema.Array(GeneratedSheetTextPart),
      }),
      Schema.Struct({
        type: Schema.Literal("inlineCode"),
        text: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literal("strikethrough"),
        parts: Schema.Array(GeneratedSheetTextPart),
      }),
      Schema.Struct({
        type: Schema.Literal("subtle"),
        parts: Schema.Array(GeneratedSheetTextPart),
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
    ]) as Schema.Codec<GeneratedSheetTextPart>,
);

export const GeneratedSheetText = Schema.Array(GeneratedSheetTextPart);

export type GeneratedSheetText = Schema.Schema.Type<typeof GeneratedSheetText>;
