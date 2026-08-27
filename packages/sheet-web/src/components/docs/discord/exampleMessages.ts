import { DateTime, Option, Predicate } from "effect";
import {
  CHECKIN_ACTION_ID,
  ROOM_ORDER_NEXT_ACTION_ID,
  ROOM_ORDER_PREVIOUS_ACTION_ID,
  ROOM_ORDER_SEND_ACTION_ID,
  ROOM_ORDER_TENTATIVE_PIN_ACTION_ID,
  TENTATIVE_ROOM_ORDER_PREFIX,
  conversationRefFrom,
  type BotActionButton,
  type BotMessageActionRow,
  type BotMessageEmbed,
  type BotOutboundMessage,
  type BotTextPart,
  type BotTimestampStyle,
  type ClientRef,
  type ConversationRef,
} from "sheet-bot-api";

type MessageTextInput = string | ReadonlyArray<BotTextPart>;

export const text = (value: string): BotTextPart => ({ type: "text", text: value });

export const parts = (
  ...items: ReadonlyArray<BotTextPart | null | undefined | false>
): BotTextPart[] => items.filter((item): item is BotTextPart => Boolean(item));

const lines = (...rows: ReadonlyArray<ReadonlyArray<BotTextPart>>): BotTextPart[] =>
  rows.flatMap((row, index) => (index === 0 ? row : [text("\n"), ...row]));

export const strong = (value: ReadonlyArray<BotTextPart>): BotTextPart => ({
  type: "strong",
  parts: [...value],
});

const inlineCode = (value: string): BotTextPart => ({ type: "inlineCode", text: value });

const subtle = (value: ReadonlyArray<BotTextPart>): BotTextPart => ({
  type: "subtle",
  parts: [...value],
});

export const userMention = (userId: string): BotTextPart => ({ type: "userMention", userId });

export const conversationMention = (conversation: ConversationRef): BotTextPart => ({
  type: "conversationMention",
  conversation,
});

export const timestamp = (epochMs: number, style?: BotTimestampStyle): BotTextPart => ({
  type: "timestamp",
  epochMs,
  ...(style === undefined ? {} : { style }),
});

export const conversationRef = (
  client: ClientRef,
  workspaceId: string,
  conversationId: string,
): ConversationRef => conversationRefFrom(client, workspaceId, conversationId);

const joinText = (
  values: ReadonlyArray<ReadonlyArray<BotTextPart>>,
  separator: string,
): BotTextPart[] =>
  values.flatMap((value, index) => (index === 0 ? value : [text(separator), ...value]));

const textValue = (value: MessageTextInput): ReadonlyArray<BotTextPart> =>
  Predicate.isString(value) ? [text(value)] : value;

// This documentation helper preserves the optional fields supported by Discord embeds.
// fallow-ignore-next-line complexity
const makeEmbed = (embed: {
  readonly title?: MessageTextInput;
  readonly description?: MessageTextInput | null;
  readonly fields?: ReadonlyArray<{
    readonly name: MessageTextInput;
    readonly value: MessageTextInput;
    readonly inline?: boolean;
  }>;
  readonly footer?: { readonly text: MessageTextInput };
  readonly color?: number;
}): BotMessageEmbed => ({
  ...(embed.title === undefined ? {} : { title: textValue(embed.title) }),
  ...(embed.description === undefined
    ? {}
    : { description: embed.description === null ? null : textValue(embed.description) }),
  ...(embed.fields === undefined
    ? {}
    : {
        fields: embed.fields.map((field) => ({
          ...field,
          name: textValue(field.name),
          value: textValue(field.value),
        })),
      }),
  ...(embed.footer === undefined ? {} : { footer: { text: textValue(embed.footer.text) } }),
  ...(embed.color === undefined ? {} : { color: embed.color }),
});

const actionRow = (...components: ReadonlyArray<BotActionButton>): BotMessageActionRow => ({
  type: "actionRow",
  components: [...components],
});

const button = (options: Omit<BotActionButton, "type">): BotActionButton => ({
  type: "button",
  ...options,
});

const checkinActionRow = (disabled = false): BotMessageActionRow =>
  actionRow(
    button({
      actionId: CHECKIN_ACTION_ID,
      label: "Check in",
      style: "primary",
      emoji: { id: "907705464215711834", name: "Miku_Happy" },
      disabled,
    }),
  );

const escapeMarkdown = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("`", "\\`")
    .replaceAll("<", "\\<")
    .replaceAll("#", "\\#");

type CheckinDmMessageContext = {
  readonly client: ClientRef;
  readonly workspaceId: string;
  readonly workspaceName?: string | undefined;
  readonly runningConversationId: string;
  readonly checkinConversationId: string;
  readonly monitorConversationId?: string | undefined;
  readonly hour: number;
};

const channelMention = (params: CheckinDmMessageContext, conversationId: string) =>
  conversationMention(conversationRef(params.client, params.workspaceId, conversationId));

const workspaceNameLine = (workspaceName: string | undefined) =>
  Predicate.isString(workspaceName) ? [[text(`Server: ${escapeMarkdown(workspaceName)}`)]] : [];

// Copied from packages/sheet-message-content/src/checkinMessages.ts:reminderMessage; keep this documentation example synchronized with the production builder.
export const reminderMessage = (params: CheckinDmMessageContext): BotOutboundMessage => ({
  content: null,
  embeds: [
    makeEmbed({
      title: `Check-in is open for hour ${params.hour}`,
      description: lines(
        ...workspaceNameLine(params.workspaceName),
        [text("Check-in channel: "), channelMention(params, params.checkinConversationId)],
        [text("Open the check-in message and tap Check in.")],
      ),
    }),
  ],
  allowedMentions: "none",
});

// Copied from packages/sheet-message-content/src/checkinMessages.ts:monitorPingMessage; keep this documentation example synchronized with the production builder.
export const monitorPingMessage = (params: CheckinDmMessageContext): BotOutboundMessage => {
  const hasMonitorConversation = Predicate.isString(params.monitorConversationId);
  const destinationConversationId = hasMonitorConversation
    ? params.monitorConversationId
    : params.runningConversationId;

  return {
    content: null,
    embeds: [
      makeEmbed({
        title: `Check-in is open for hour ${params.hour}`,
        description: lines(
          ...workspaceNameLine(params.workspaceName),
          [
            text(`${hasMonitorConversation ? "Monitor" : "Running"} channel: `),
            channelMention(params, destinationConversationId),
          ],
          [text("You are assigned as monitor for this hour.")],
          [
            text(
              hasMonitorConversation
                ? "Open the monitor channel to review the summary and check in."
                : "Open the running channel for the monitor summary and next steps.",
            ),
          ],
        ),
      }),
    ],
    allowedMentions: "none",
  };
};

export const checkinAnnouncementMessage = (accountId: string): BotOutboundMessage => ({
  content: parts(userMention(accountId), text(" has checked in!")),
});

export const checkinButtonAcknowledgementMessage = (
  isFirstCheckin: boolean,
): { readonly content: string } => ({
  content: isFirstCheckin ? "You have been checked in!" : "You have already been checked in!",
});

export const checkinPromptMessage = (
  content: ReadonlyArray<BotTextPart>,
  disabled = false,
): BotOutboundMessage => ({ content, components: [checkinActionRow(disabled)] });

type Participant = {
  readonly name: string;
  readonly userId?: string;
};

const participantGroup = (
  label: "Out" | "Stay" | "In",
  participants: ReadonlyArray<Participant>,
): BotTextPart[] =>
  participants.length === 0
    ? [text(`${label}: None`)]
    : [
        text(`${label}: `),
        ...participants.flatMap((participant, index) => [
          ...(index === 0 ? [] : [text(" ")]),
          Predicate.isString(participant.userId)
            ? userMention(participant.userId)
            : text(participant.name),
        ]),
      ];

// This example keeps the production monitor message's display branches visible in the docs.
// fallow-ignore-next-line complexity
export const makeMonitorCheckinMessage = ({
  initialMessage,
  empty,
  out,
  stay,
  in: incoming,
  lookupFailedMessage,
}: {
  readonly initialMessage: ReadonlyArray<BotTextPart> | null;
  readonly empty: number;
  readonly out: ReadonlyArray<Participant>;
  readonly stay: ReadonlyArray<Participant>;
  readonly in: ReadonlyArray<Participant>;
  readonly lookupFailedMessage: Option.Option<string>;
}): BotTextPart[] => {
  const emptySlotMessage = text(
    `${empty > 0 ? `+${empty}` : "No"} empty slot${empty === 1 ? "" : "s"}`,
  );
  const rows: ReadonlyArray<ReadonlyArray<BotTextPart>> =
    initialMessage === null
      ? [
          [text("No check-in message sent, no new players to check in")],
          ...(empty > 0 && empty < 5 ? [[emptySlotMessage]] : []),
        ]
      : [
          [text("Check-in message sent!")],
          [emptySlotMessage],
          participantGroup("Out", out),
          participantGroup("Stay", stay),
          participantGroup("In", incoming),
          ...Option.toArray(Option.map(lookupFailedMessage, (message) => [text(message)])),
        ];
  return rows.flatMap((row, index) => (index === 0 ? row : [text("\n"), ...row]));
};

const autoCheckinNotice = "Sent automatically via auto check-in.";

const automaticSummaryDescription = (
  monitorCheckinMessage: ReadonlyArray<BotTextPart>,
  monitorFailureMessage: ReadonlyArray<BotTextPart> | null,
): BotTextPart[] =>
  lines(
    monitorCheckinMessage,
    ...(monitorFailureMessage === null ? [] : [[subtle(monitorFailureMessage)]]),
    [subtle([text(autoCheckinNotice)])],
  );

export const manualCheckinSummaryMessage = ({
  monitorCheckinMessage,
}: {
  readonly monitorCheckinMessage: ReadonlyArray<BotTextPart>;
}): BotOutboundMessage => ({
  content: null,
  embeds: [
    makeEmbed({
      title: [text("Check-in summary for monitors")],
      description: monitorCheckinMessage,
    }),
  ],
  allowedMentions: "none",
});

export const autoCheckinSummaryMessage = ({
  monitorUserId,
  monitorCheckinMessage,
  monitorFailureMessage,
}: {
  readonly monitorUserId: string | null;
  readonly monitorCheckinMessage: ReadonlyArray<BotTextPart>;
  readonly monitorFailureMessage: ReadonlyArray<BotTextPart> | null;
}): BotOutboundMessage => ({
  content: Predicate.isString(monitorUserId) ? [userMention(monitorUserId)] : undefined,
  embeds: [
    makeEmbed({
      title: [text("Auto check-in summary for monitors")],
      description: automaticSummaryDescription(monitorCheckinMessage, monitorFailureMessage),
    }),
  ],
  allowedMentions: Predicate.isString(monitorUserId) ? "default" : "none",
});

// This example keeps the production automatic monitor message's display branches visible in the docs.
// fallow-ignore-next-line complexity
export const autoMonitorCheckinMessage = ({
  client,
  workspaceId,
  runningConversationId,
  hour,
  monitorUserId,
  monitorCheckinRequired,
  monitorCheckinMessage,
  monitorFailureMessage,
}: {
  readonly client: ClientRef;
  readonly workspaceId: string;
  readonly runningConversationId: string;
  readonly hour: number;
  readonly monitorUserId: string | null;
  readonly monitorCheckinRequired: boolean;
  readonly monitorCheckinMessage: ReadonlyArray<BotTextPart>;
  readonly monitorFailureMessage: ReadonlyArray<BotTextPart> | null;
}): BotOutboundMessage & { readonly content: BotTextPart[] | null } => {
  const checkinIsRequired = monitorCheckinRequired && Predicate.isString(monitorUserId);
  const runningConversation = conversationMention(
    conversationRef(client, workspaceId, runningConversationId),
  );
  const content = Predicate.isString(monitorUserId)
    ? checkinIsRequired
      ? parts(
          userMention(monitorUserId),
          text(` please check in for hour ${hour} in `),
          runningConversation,
          text("."),
        )
      : parts(
          userMention(monitorUserId),
          text(` is continuing from hour ${hour - 1} in `),
          runningConversation,
          text("; no new monitor check-in is required."),
        )
    : null;

  return {
    content,
    embeds: [
      makeEmbed({
        title: [text("Auto check-in summary for monitors")],
        description: automaticSummaryDescription(monitorCheckinMessage, monitorFailureMessage),
        fields: [
          { name: "Running channel", value: [runningConversation], inline: true },
          { name: "Hour", value: String(hour), inline: true },
        ],
      }),
    ],
    ...(checkinIsRequired ? { components: [checkinActionRow()] } : {}),
    allowedMentions: Predicate.isString(monitorUserId) ? "default" : "none",
  };
};

export const renderCheckedInContent = (
  initialMessage: ReadonlyArray<BotTextPart>,
  members: ReadonlyArray<{ readonly memberId: string; readonly checkinAt: Option.Option<unknown> }>,
): BotTextPart[] => {
  const checkedInMentions = members.filter((member) => Option.isSome(member.checkinAt));
  return checkedInMentions.length === 0
    ? [...initialMessage]
    : parts(
        ...initialMessage,
        text("\n\nChecked in: "),
        ...checkedInMentions.flatMap((member, index) =>
          parts(index === 0 ? undefined : text(" "), userMention(member.memberId)),
        ),
      );
};

type FillParticipant = {
  readonly key: string;
  readonly name: string;
};

type RoomOrderContentEntry = {
  readonly position: number;
  readonly team: string;
  readonly tags: ReadonlyArray<string>;
  readonly effectValue: number;
};

const participantMovement = (
  previousParticipants: ReadonlyArray<FillParticipant>,
  participants: ReadonlyArray<FillParticipant>,
) => {
  const previousKeys = new Set(previousParticipants.map((participant) => participant.key));
  const keys = new Set(participants.map((participant) => participant.key));
  return {
    in: participants.filter((participant) => !previousKeys.has(participant.key)),
    out: previousParticipants.filter((participant) => !keys.has(participant.key)),
  };
};

const formatEffectValue = (effectValue: number): string => {
  const rounded = Number(effectValue.toFixed(1));
  return `+${Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1)}%`;
};

const participantList = (participants: ReadonlyArray<FillParticipant>): string =>
  participants.length === 0 ? "(none)" : participants.map(({ name }) => name).join(", ");

export const buildRoomOrderContent = (
  hour: number,
  start: DateTime.DateTime,
  end: DateTime.DateTime,
  monitor: string | null,
  previousParticipants: ReadonlyArray<FillParticipant>,
  participants: ReadonlyArray<FillParticipant>,
  entries: ReadonlyArray<RoomOrderContentEntry>,
): BotTextPart[] => {
  const movement = participantMovement(previousParticipants, participants);
  // The example displays each supported room-order tag inline.
  // fallow-ignore-next-line complexity
  const entryLines = entries.map(({ position, team, tags, effectValue }) => {
    const effectLabels = tags.includes("tierer")
      ? []
      : [
          formatEffectValue(effectValue),
          ...(tags.includes("enc") ? ["enc"] : []),
          ...(tags.includes("not_enc") ? ["not enc"] : []),
        ];
    const effectText = effectLabels.length === 0 ? "" : ` (${effectLabels.join(", ")})`;
    return parts(inlineCode(`P${position + 1}:`), text(`  ${team}${effectText}`));
  });
  return joinText(
    [
      parts(
        strong([text(`Hour ${hour}`)]),
        text(" "),
        timestamp(DateTime.toEpochMillis(start)),
        text(" - "),
        timestamp(DateTime.toEpochMillis(end)),
      ),
      ...(monitor === null ? [] : [parts(inlineCode("Monitor:"), text(` ${monitor}`))]),
      [text("")],
      ...entryLines,
      [text("")],
      parts(inlineCode("In:"), text(` ${participantList(movement.in)}`)),
      parts(inlineCode("Out:"), text(` ${participantList(movement.out)}`)),
    ],
    "\n",
  );
};

const roomOrderActionRow = (
  range: { readonly minRank: number; readonly maxRank: number },
  rank: number,
): BotMessageActionRow =>
  actionRow(
    button({
      actionId: ROOM_ORDER_PREVIOUS_ACTION_ID,
      label: "Previous",
      style: "secondary",
      disabled: range.minRank === rank,
    }),
    button({
      actionId: ROOM_ORDER_NEXT_ACTION_ID,
      label: "Next",
      style: "secondary",
      disabled: range.maxRank === rank,
    }),
    button({ actionId: ROOM_ORDER_SEND_ACTION_ID, label: "Send", style: "primary" }),
  );

const tentativeRoomOrderActionRow = (
  range: { readonly minRank: number; readonly maxRank: number },
  rank: number,
): BotMessageActionRow =>
  actionRow(
    button({
      actionId: ROOM_ORDER_PREVIOUS_ACTION_ID,
      label: "Previous",
      style: "secondary",
      disabled: range.minRank === rank,
    }),
    button({
      actionId: ROOM_ORDER_NEXT_ACTION_ID,
      label: "Next",
      style: "secondary",
      disabled: range.maxRank === rank,
    }),
    button({
      actionId: ROOM_ORDER_TENTATIVE_PIN_ACTION_ID,
      label: "Pin",
      style: "primary",
      emoji: { name: "📌" },
    }),
  );

export const roomOrderDraftMessage = (
  content: ReadonlyArray<BotTextPart>,
  range: { readonly minRank: number; readonly maxRank: number },
  rank: number,
): BotOutboundMessage => ({ content, components: [roomOrderActionRow(range, rank)] });

export const publishedRoomOrderMessage = (
  content: ReadonlyArray<BotTextPart>,
): BotOutboundMessage => ({ content });

export const tentativeRoomOrderMessage = (
  content: ReadonlyArray<BotTextPart>,
  range: { readonly minRank: number; readonly maxRank: number },
  rank: number,
): BotOutboundMessage => ({
  content: lines([text(TENTATIVE_ROOM_ORDER_PREFIX)], content),
  components: [tentativeRoomOrderActionRow(range, rank)],
});

export const roomOrderSendAcknowledgementMessage = (
  pinned: boolean,
): { readonly content: string } => ({
  content: pinned ? "sent room order and pinned it!" : "sent room order, but failed to pin it.",
});

export const tentativeRoomOrderPinAcknowledgementMessage = (
  cleanedUp: boolean,
): { readonly content: string } => ({
  content: cleanedUp
    ? "pinned tentative room order!"
    : "pinned tentative room order, but failed to clean up the message.",
});
