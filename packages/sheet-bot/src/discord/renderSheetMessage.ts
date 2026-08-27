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
  BotClientTerm,
  BotClientTermCasing,
  BotClientTermForm,
  BotMessageActionRow,
  BotOutboundMessage,
  BotText,
  BotTextPart,
} from "sheet-bot-api/message";

const snowflake = (value: string) => value as Parameters<typeof userMention>[0];

const timestampStyles = {
  shortTime: TimestampStyles.ShortTime,
  longTime: TimestampStyles.LongTime,
  shortDate: TimestampStyles.ShortDate,
  longDate: TimestampStyles.LongDate,
  relative: TimestampStyles.RelativeTime,
} satisfies Record<
  NonNullable<Extract<BotTextPart, { type: "timestamp" }>["style"]>,
  (typeof TimestampStyles)[keyof typeof TimestampStyles]
>;

const timestampStyle = (style: Extract<BotTextPart, { type: "timestamp" }>["style"]) =>
  Predicate.isUndefined(style) ? TimestampStyles.LongDateShortTime : timestampStyles[style];

const discordTerms = {
  workspace: { singular: "server", plural: "servers" },
  conversation: { singular: "channel", plural: "channels" },
  runDestination: { singular: "running channel", plural: "running channels" },
  checkinDestination: { singular: "check-in channel", plural: "check-in channels" },
  monitorRole: { singular: "monitor role", plural: "monitor roles" },
  lockdownRole: { singular: "lockdown role", plural: "lockdown roles" },
  message: { singular: "message", plural: "messages" },
  testRun: { singular: "test run", plural: "test runs" },
} satisfies Record<BotClientTerm, Record<BotClientTermForm, string>>;

const sentenceCase = (value: string) =>
  value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;

const renderClientTerm = (
  term: BotClientTerm,
  form: BotClientTermForm = "singular",
  casing: BotClientTermCasing = "lower",
) => {
  const rendered = discordTerms[term][form];
  return casing === "sentence" ? sentenceCase(rendered) : rendered;
};

const renderOptionalLink = (label: string | undefined, url: string) =>
  Predicate.isUndefined(label) ? url : hyperlink(label, url);

type BotTextPartOf<Type extends BotTextPart["type"]> = Extract<BotTextPart, { type: Type }>;

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
  readonly [Type in BotTextPart["type"]]: (part: BotTextPartOf<Type>) => string;
};

const renderSheetTextPart = (part: BotTextPart): string =>
  sheetTextPartRenderers[part.type](part as never);

const renderSheetText = (text: BotText): string =>
  Predicate.isString(text) ? text : text.map(renderSheetTextPart).join("");

const buttonStyles = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4,
} as const;

const buttonStyle = (style: BotMessageActionRow["components"][number]["style"]) =>
  Predicate.isUndefined(style) ? buttonStyles.secondary : buttonStyles[style];

const renderComponent = (component: BotMessageActionRow) => ({
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

const renderSheetEmbeds = (message: BotOutboundMessage) =>
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

export const toDiscordMessagePayload = (message: BotOutboundMessage) =>
  ({
    content: Predicate.isNullish(message.content) ? undefined : renderSheetText(message.content),
    embeds: renderSheetEmbeds(message),
    components: message.components?.map(renderComponent),
    flags: message.visibility === "ephemeral" ? 64 : undefined,
    allowed_mentions: message.allowedMentions === "none" ? { parse: [] } : undefined,
    message_reference: message.messageReference
      ? {
          message_id: message.messageReference.message.messageId,
          channel_id: message.messageReference.message.conversation.conversationId,
          guild_id: message.messageReference.message.conversation.workspace.workspaceId,
          fail_if_not_exists: message.messageReference.failIfNotExists,
        }
      : undefined,
  }) as Discord.MessageCreateRequest &
    Discord.MessageEditRequestPartial &
    Discord.IncomingWebhookUpdateRequestPartial;
