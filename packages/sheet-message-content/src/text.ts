import { Predicate } from "effect";
import {
  conversationRefFrom,
  workspaceRefFrom,
  type ClientRef,
  type BotClientTerm,
  type BotClientTermCasing,
  type BotClientTermForm,
  type BotTextPart,
  type BotTimestampStyle,
  type ConversationRef,
  type MessageRef,
  type WorkspaceRef,
} from "sheet-bot-api";

type MaybePart = BotTextPart | null | undefined | false;

export const text = (value: string): BotTextPart => ({ type: "text", text: value });

export const parts = (...items: ReadonlyArray<MaybePart>): BotTextPart[] =>
  items.filter((item): item is BotTextPart => Boolean(item));

export const lines = (...rows: ReadonlyArray<ReadonlyArray<BotTextPart>>): BotTextPart[] =>
  rows.flatMap((row, index) => (index === 0 ? row : [text("\n"), ...row]));

export const strong = (value: ReadonlyArray<BotTextPart>): BotTextPart => ({
  type: "strong",
  parts: [...value],
});

export const inlineCode = (value: string): BotTextPart => ({
  type: "inlineCode",
  text: value,
});

export const subtle = (value: ReadonlyArray<BotTextPart>): BotTextPart => ({
  type: "subtle",
  parts: [...value],
});

export const externalLink = (url: string, label?: string): BotTextPart => ({
  type: "externalLink",
  url,
  ...(label === undefined ? {} : { label }),
});

export const clientTerm = (
  term: BotClientTerm,
  options: {
    readonly form?: BotClientTermForm;
    readonly casing?: BotClientTermCasing;
  } = {},
): BotTextPart => ({
  type: "clientTerm",
  term,
  ...options,
});

export const userMention = (userId: string): BotTextPart => ({
  type: "userMention",
  userId,
});

export const conversationMention = (conversation: ConversationRef): BotTextPart => ({
  type: "conversationMention",
  conversation,
});

export const messageLink = (message: MessageRef, label?: string): BotTextPart => ({
  type: "messageLink",
  message,
  ...(Predicate.isUndefined(label) ? {} : { label }),
});

export const roleMention = (workspace: WorkspaceRef, roleId: string): BotTextPart => ({
  type: "roleMention",
  workspace,
  roleId,
});

export const timestamp = (epochMs: number, style?: BotTimestampStyle): BotTextPart => ({
  type: "timestamp",
  epochMs,
  ...(style === undefined ? {} : { style }),
});

export const workspaceRef = (client: ClientRef, workspaceId: string): WorkspaceRef =>
  workspaceRefFrom(client, workspaceId);

export const conversationRef = (
  client: ClientRef,
  workspaceId: string,
  conversationId: string,
): ConversationRef => conversationRefFrom(client, workspaceId, conversationId);

export const joinText = (
  values: ReadonlyArray<ReadonlyArray<BotTextPart>>,
  separator: string,
): BotTextPart[] =>
  values.flatMap((value, index) => (index === 0 ? value : [text(separator), ...value]));

const terms = {
  workspace: { singular: "workspace", plural: "workspaces" },
  conversation: { singular: "conversation", plural: "conversations" },
  runDestination: { singular: "run destination", plural: "run destinations" },
  checkinDestination: { singular: "check-in destination", plural: "check-in destinations" },
  monitorRole: { singular: "monitor role", plural: "monitor roles" },
  lockdownRole: { singular: "lockdown role", plural: "lockdown roles" },
  message: { singular: "message", plural: "messages" },
  testRun: { singular: "test run", plural: "test runs" },
} satisfies Record<BotClientTerm, Record<BotClientTermForm, string>>;

const termText = (term: BotClientTerm, form: BotClientTermForm = "singular") => terms[term][form];

const sentenceCase = (value: string) =>
  value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;

type BotTextPartOf<Type extends BotTextPart["type"]> = Extract<BotTextPart, { type: Type }>;

const renderClientTermPlain = (part: BotTextPartOf<"clientTerm">) => {
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
  readonly [Type in BotTextPart["type"]]: (part: BotTextPartOf<Type>) => string;
};

const renderPlainPart = (part: BotTextPart): string => plainPartRenderers[part.type](part as never);

export const renderPlainText = (value: ReadonlyArray<BotTextPart>): string =>
  value.map(renderPlainPart).join("");
