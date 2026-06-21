import { Array as EffectArray, Match, Predicate } from "effect";
import type {
  GeneratedSheetText,
  GeneratedSheetTextPart,
  SheetClientTerm,
  SheetClientTermCasing,
  SheetClientTermForm,
  SheetTimestampStyle,
} from "sheet-ingress-api/schemas/client";

type MaybePart = GeneratedSheetTextPart | null | undefined | false;
type FlattenItem = GeneratedSheetText | MaybePart;

const isGeneratedSheetTextPart = (item: MaybePart): item is GeneratedSheetTextPart =>
  Predicate.isTruthy(item);

const isGeneratedSheetText = (item: FlattenItem): item is GeneratedSheetText =>
  EffectArray.isArray(item);

const isMissingPart = (item: FlattenItem): item is null | undefined | false =>
  !Predicate.isTruthy(item);

export const text = (value: string): GeneratedSheetTextPart => ({ type: "text", text: value });

export const parts = (...items: ReadonlyArray<MaybePart>): GeneratedSheetText =>
  items.filter(isGeneratedSheetTextPart);

export const flatten = (items: ReadonlyArray<FlattenItem>): GeneratedSheetText =>
  items.flatMap((item) =>
    Match.value(item).pipe(
      Match.when(isGeneratedSheetText, (partItems) => partItems),
      Match.when(isMissingPart, () => []),
      Match.orElse((partItem) => [partItem]),
    ),
  );

export const strong = (value: GeneratedSheetText): GeneratedSheetTextPart => ({
  type: "strong",
  parts: value,
});

export const inlineCode = (value: string): GeneratedSheetTextPart => ({
  type: "inlineCode",
  text: value,
});

export const strikethrough = (value: GeneratedSheetText): GeneratedSheetTextPart => ({
  type: "strikethrough",
  parts: value,
});

export const subtle = (value: GeneratedSheetText): GeneratedSheetTextPart => ({
  type: "subtle",
  parts: value,
});

export const externalLink = (url: string, label?: string): GeneratedSheetTextPart => ({
  type: "externalLink",
  url,
  ...(Predicate.isUndefined(label) ? {} : { label }),
});

export const clientTerm = (
  term: SheetClientTerm,
  options: {
    readonly form?: SheetClientTermForm;
    readonly casing?: SheetClientTermCasing;
  } = {},
): GeneratedSheetTextPart => ({
  type: "clientTerm",
  term,
  ...options,
});

export const userMention = (userId: string): GeneratedSheetTextPart => ({
  type: "userMention",
  userId,
});

export const conversationMention = (conversationId: string): GeneratedSheetTextPart => ({
  type: "conversationMention",
  conversationId,
});

export const timestamp = (
  epochMs: number,
  style?: SheetTimestampStyle,
): GeneratedSheetTextPart => ({
  type: "timestamp",
  epochMs,
  ...(Predicate.isUndefined(style) ? {} : { style }),
});

export const joinText = (
  values: ReadonlyArray<GeneratedSheetText>,
  separator: string,
): GeneratedSheetText =>
  values.flatMap((value, index) => (index === 0 ? value : [text(separator), ...value]));
