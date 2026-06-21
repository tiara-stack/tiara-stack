// fallow-ignore-file code-duplication
import {
  bold,
  channelMention,
  hyperlink,
  inlineCode,
  messageLink as discordMessageLink,
  roleMention,
  strikethrough,
  subtext,
  time,
  TimestampStyles,
  userMention,
} from "@discordjs/formatters";
import type * as Discord from "dfx/types";
import { Predicate } from "effect";
import type {
  SheetClientTerm,
  SheetClientTermCasing,
  SheetClientTermForm,
  GeneratedSheetText,
  GeneratedSheetTextPart,
  SheetMessageComponent,
  SheetOutboundMessage,
  SheetText,
  SheetTextPart,
} from "sheet-ingress-api/schemas/client";

const snowflake = (value: string) => value as Parameters<typeof userMention>[0];

const timestampStyles = {
  shortTime: TimestampStyles.ShortTime,
  longTime: TimestampStyles.LongTime,
  shortDate: TimestampStyles.ShortDate,
  longDate: TimestampStyles.LongDate,
  relative: TimestampStyles.RelativeTime,
} satisfies Record<
  NonNullable<Extract<SheetTextPart, { type: "timestamp" }>["style"]>,
  (typeof TimestampStyles)[keyof typeof TimestampStyles]
>;

const timestampStyle = (style: Extract<SheetTextPart, { type: "timestamp" }>["style"]) =>
  Predicate.isUndefined(style) ? TimestampStyles.LongDateShortTime : timestampStyles[style];

const discordTerms = {
  workspace: { singular: "server", plural: "servers" },
  conversation: { singular: "channel", plural: "channels" },
  runDestination: { singular: "running channel", plural: "running channels" },
  checkinDestination: { singular: "check-in channel", plural: "check-in channels" },
  monitorRole: { singular: "monitor role", plural: "monitor roles" },
  message: { singular: "message", plural: "messages" },
  testRun: { singular: "test run", plural: "test runs" },
} satisfies Record<SheetClientTerm, Record<SheetClientTermForm, string>>;

const sentenceCase = (value: string) =>
  value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;

const renderClientTerm = (
  term: SheetClientTerm,
  form: SheetClientTermForm = "singular",
  casing: SheetClientTermCasing = "lower",
) => {
  const rendered = discordTerms[term][form];
  return casing === "sentence" ? sentenceCase(rendered) : rendered;
};

const renderOptionalLink = (label: string | undefined, url: string) =>
  Predicate.isUndefined(label) ? url : hyperlink(label, url);

type SheetTextPartOf<Type extends SheetTextPart["type"]> = Extract<SheetTextPart, { type: Type }>;

const sheetTextPartRenderers = {
  text: (part) => part.text,
  userMention: (part) => userMention(snowflake(part.userId)),
  conversationMention: (part) => channelMention(snowflake(part.conversation.conversationId)),
  roleMention: (part) => roleMention(snowflake(part.roleId)),
  messageLink: (part) =>
    renderOptionalLink(
      part.label,
      discordMessageLink(
        snowflake(part.message.conversation.conversationId),
        snowflake(part.message.messageId),
        snowflake(part.message.conversation.workspace.workspaceId),
      ),
    ),
  timestamp: (part) => time(Math.floor(part.epochMs / 1000), timestampStyle(part.style)),
  strong: (part) => bold(renderSheetText(part.parts)),
  inlineCode: (part) => inlineCode(part.text),
  strikethrough: (part) => strikethrough(renderSheetText(part.parts)),
  subtle: (part) => subtext(renderSheetText(part.parts)),
  externalLink: (part) => renderOptionalLink(part.label, part.url),
  clientTerm: (part) => renderClientTerm(part.term, part.form, part.casing),
} satisfies {
  readonly [Type in SheetTextPart["type"]]: (part: SheetTextPartOf<Type>) => string;
};

const renderSheetTextPart = (part: SheetTextPart): string =>
  sheetTextPartRenderers[part.type](part as never);

const renderSheetText = (text: SheetText): string =>
  Predicate.isString(text) ? text : text.map(renderSheetTextPart).join("");

type GeneratedSheetTextPartOf<Type extends GeneratedSheetTextPart["type"]> = Extract<
  GeneratedSheetTextPart,
  { type: Type }
>;

const generatedSheetTextPartRenderers = {
  text: (part) => part.text,
  userMention: (part) => userMention(snowflake(part.userId)),
  conversationMention: (part) => channelMention(snowflake(part.conversationId)),
  timestamp: (part) => time(Math.floor(part.epochMs / 1000), timestampStyle(part.style)),
  strong: (part) => bold(renderGeneratedSheetText(part.parts)),
  inlineCode: (part) => inlineCode(part.text),
  strikethrough: (part) => strikethrough(renderGeneratedSheetText(part.parts)),
  subtle: (part) => subtext(renderGeneratedSheetText(part.parts)),
  externalLink: (part) => renderOptionalLink(part.label, part.url),
  clientTerm: (part) => renderClientTerm(part.term, part.form, part.casing),
} satisfies {
  readonly [Type in GeneratedSheetTextPart["type"]]: (
    part: GeneratedSheetTextPartOf<Type>,
  ) => string;
};

const renderGeneratedSheetTextPart = (part: GeneratedSheetTextPart): string =>
  generatedSheetTextPartRenderers[part.type](part as never);

export const renderGeneratedSheetText = (text: GeneratedSheetText): string =>
  text.map(renderGeneratedSheetTextPart).join("");

const buttonStyles = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4,
} as const;

const buttonStyle = (
  style: Extract<SheetMessageComponent, { type: "actionRow" }>["components"][number]["style"],
) => (Predicate.isUndefined(style) ? buttonStyles.secondary : buttonStyles[style]);

const renderComponent = (component: SheetMessageComponent) => ({
  type: 1,
  components: component.components.map((button) => ({
    type: 2,
    custom_id: button.actionId,
    label: button.label,
    style: buttonStyle(button.style),
    disabled: button.disabled,
    emoji: button.emoji,
  })),
});

const renderSheetEmbeds = (message: SheetOutboundMessage) =>
  message.embeds?.map((embed) => ({
    title: Predicate.isUndefined(embed.title) ? undefined : renderSheetText(embed.title),
    description: Predicate.isNullish(embed.description)
      ? embed.description
      : renderSheetText(embed.description),
    fields: embed.fields?.map((field) => ({
      name: renderSheetText(field.name),
      value: renderSheetText(field.value),
      inline: field.inline,
    })),
    footer: embed.footer && { text: renderSheetText(embed.footer.text) },
    color: embed.color,
  }));

export const toDiscordMessagePayload = (message: SheetOutboundMessage) =>
  ({
    content: Predicate.isNullish(message.content) ? undefined : renderSheetText(message.content),
    embeds: renderSheetEmbeds(message),
    components: message.components?.map(renderComponent),
    flags: message.visibility === "ephemeral" ? 64 : undefined,
    allowed_mentions: message.allowedMentions === "none" ? { parse: [] } : undefined,
  }) as Discord.MessageCreateRequest &
    Discord.MessageEditRequestPartial &
    Discord.IncomingWebhookUpdateRequestPartial;
