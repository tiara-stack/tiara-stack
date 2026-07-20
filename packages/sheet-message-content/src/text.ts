import { Predicate } from "effect";
import {
  conversationRefFrom,
  workspaceRefFrom,
  type ClientRef,
  type ConversationRef,
  type GeneratedSheetText,
  type GeneratedSheetTextPart,
  type MessageRef,
  type SheetClientTerm,
  type SheetClientTermCasing,
  type SheetClientTermForm,
  type SheetTextPart,
  type SheetTimestampStyle,
  type WorkspaceRef,
} from "sheet-ingress-api/schemas/client";

export type { SheetTextPart } from "sheet-ingress-api/schemas/client";

type MaybePart = SheetTextPart | null | undefined | false;

export const text = (value: string): SheetTextPart => ({ type: "text", text: value });

export const parts = (...items: ReadonlyArray<MaybePart>): SheetTextPart[] =>
  items.filter((item): item is SheetTextPart => Boolean(item));

export const lines = (...rows: ReadonlyArray<ReadonlyArray<SheetTextPart>>): SheetTextPart[] =>
  rows.flatMap((row, index) => (index === 0 ? row : [text("\n"), ...row]));

export const strong = (value: ReadonlyArray<SheetTextPart>): SheetTextPart => ({
  type: "strong",
  parts: [...value],
});

export const inlineCode = (value: string): SheetTextPart => ({
  type: "inlineCode",
  text: value,
});

const strikethrough = (value: ReadonlyArray<SheetTextPart>): SheetTextPart => ({
  type: "strikethrough",
  parts: [...value],
});

export const subtle = (value: ReadonlyArray<SheetTextPart>): SheetTextPart => ({
  type: "subtle",
  parts: [...value],
});

export const externalLink = (url: string, label?: string): SheetTextPart => ({
  type: "externalLink",
  url,
  ...(label === undefined ? {} : { label }),
});

export const clientTerm = (
  term: SheetClientTerm,
  options: {
    readonly form?: SheetClientTermForm;
    readonly casing?: SheetClientTermCasing;
  } = {},
): SheetTextPart => ({
  type: "clientTerm",
  term,
  ...options,
});

export const userMention = (userId: string): SheetTextPart => ({
  type: "userMention",
  userId,
});

export const conversationMention = (conversation: ConversationRef): SheetTextPart => ({
  type: "conversationMention",
  conversation,
});

export const messageLink = (message: MessageRef, label?: string): SheetTextPart => ({
  type: "messageLink",
  message,
  ...(Predicate.isUndefined(label) ? {} : { label }),
});

export const roleMention = (workspace: WorkspaceRef, roleId: string): SheetTextPart => ({
  type: "roleMention",
  workspace,
  roleId,
});

export const timestamp = (epochMs: number, style?: SheetTimestampStyle): SheetTextPart => ({
  type: "timestamp",
  epochMs,
  ...(style === undefined ? {} : { style }),
});

export const workspaceRef = workspaceRefFrom;
export const conversationRef = conversationRefFrom;

export const joinText = (
  values: ReadonlyArray<ReadonlyArray<SheetTextPart>>,
  separator: string,
): SheetTextPart[] =>
  values.flatMap((value, index) => (index === 0 ? value : [text(separator), ...value]));

const materializeGeneratedTextPart = (
  client: ClientRef,
  workspaceId: string,
  part: GeneratedSheetTextPart,
): SheetTextPart => materializeGeneratedTextPartWith(client, workspaceId, part);

type GeneratedSheetTextPartOf<Type extends GeneratedSheetTextPart["type"]> = Extract<
  GeneratedSheetTextPart,
  { type: Type }
>;

const materializeGeneratedTextPartWith = (
  client: ClientRef,
  workspaceId: string,
  part: GeneratedSheetTextPart,
): SheetTextPart => {
  const materializers = {
    text: (part) => text(part.text),
    userMention: (part) => userMention(part.userId),
    conversationMention: (part) =>
      conversationMention(conversationRefFrom(client, workspaceId, part.conversationId)),
    timestamp: (part) => timestamp(part.epochMs, part.style),
    strong: (part) => strong(materializeGeneratedText(client, workspaceId, part.parts)),
    inlineCode: (part) => inlineCode(part.text),
    strikethrough: (part) =>
      strikethrough(materializeGeneratedText(client, workspaceId, part.parts)),
    subtle: (part) => subtle(materializeGeneratedText(client, workspaceId, part.parts)),
    externalLink: (part) => externalLink(part.url, part.label),
    clientTerm: (part) =>
      clientTerm(part.term, {
        ...(part.form === undefined ? {} : { form: part.form }),
        ...(part.casing === undefined ? {} : { casing: part.casing }),
      }),
  } satisfies {
    readonly [Type in GeneratedSheetTextPart["type"]]: (
      part: GeneratedSheetTextPartOf<Type>,
    ) => SheetTextPart;
  };

  return materializers[part.type](part as never);
};

export const materializeGeneratedText = (
  client: ClientRef,
  workspaceId: string,
  generated: GeneratedSheetText,
): SheetTextPart[] =>
  generated.map((part) => materializeGeneratedTextPart(client, workspaceId, part));

const terms = {
  workspace: { singular: "workspace", plural: "workspaces" },
  conversation: { singular: "conversation", plural: "conversations" },
  runDestination: { singular: "run destination", plural: "run destinations" },
  checkinDestination: { singular: "check-in destination", plural: "check-in destinations" },
  monitorRole: { singular: "monitor role", plural: "monitor roles" },
  lockdownRole: { singular: "lockdown role", plural: "lockdown roles" },
  message: { singular: "message", plural: "messages" },
  testRun: { singular: "test run", plural: "test runs" },
} satisfies Record<SheetClientTerm, Record<SheetClientTermForm, string>>;

const termText = (term: SheetClientTerm, form: SheetClientTermForm = "singular") =>
  terms[term][form];

const sentenceCase = (value: string) =>
  value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;

type SheetTextPartOf<Type extends SheetTextPart["type"]> = Extract<SheetTextPart, { type: Type }>;

const renderClientTermPlain = (part: SheetTextPartOf<"clientTerm">) => {
  const rendered = termText(part.term, part.form);
  return part.casing === "sentence" ? sentenceCase(rendered) : rendered;
};

const plainPartRenderers = {
  text: (part) => part.text,
  userMention: (part) => `@${part.userId}`,
  conversationMention: (part) => `#${part.conversation.conversationId}`,
  roleMention: (part) => `@role:${part.roleId}`,
  messageLink: (part) => part.label ?? `${termText("message")} ${part.message.messageId}`,
  timestamp: (part) => new Date(part.epochMs).toISOString(),
  strong: (part) => renderPlainText(part.parts),
  strikethrough: (part) => renderPlainText(part.parts),
  subtle: (part) => renderPlainText(part.parts),
  inlineCode: (part) => part.text,
  externalLink: (part) => part.label ?? part.url,
  clientTerm: renderClientTermPlain,
} satisfies {
  readonly [Type in SheetTextPart["type"]]: (part: SheetTextPartOf<Type>) => string;
};

const renderPlainPart = (part: SheetTextPart): string =>
  plainPartRenderers[part.type](part as never);

export const renderPlainText = (value: ReadonlyArray<SheetTextPart>): string =>
  value.map(renderPlainPart).join("");
