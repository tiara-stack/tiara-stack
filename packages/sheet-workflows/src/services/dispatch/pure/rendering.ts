import {
  Chunk,
  DateTime,
  Duration,
  Match,
  Option,
  Predicate,
  String as EffectString,
  pipe,
} from "effect";
import type {
  ClientRef,
  SheetOutboundMessage,
  SheetTextPart,
} from "sheet-ingress-api/schemas/client";
import * as Sheet from "sheet-ingress-api/schemas/sheet";
import type { ServiceStatus } from "sheet-ingress-api/sheet-apis-rpc";
import * as MessageText from "../../messageText";

type ClientConversationCacheEntry = {
  readonly parentId: string;
  readonly resourceId: string;
  readonly value: {
    readonly id: string;
    readonly type: number;
    readonly workspace_id?: string;
    readonly name?: string;
    readonly position?: number;
  };
};

type MessagePayload = SheetOutboundMessage;
type MessageEmbed = NonNullable<NonNullable<MessagePayload["embeds"]>[number]>;
type MessageTextValue = ReadonlyArray<SheetTextPart>;
type MessageTextInput = string | MessageTextValue;

export const textValue = (value: MessageTextInput): MessageTextValue =>
  Predicate.isString(value) ? [MessageText.text(value)] : value;

export const conversationMentionValue = (
  client: ClientRef,
  workspaceId: string,
  conversationId: string,
): MessageTextValue => [
  MessageText.conversationMention(MessageText.conversationRef(client, workspaceId, conversationId)),
];

export const roleMentionValue = (
  client: ClientRef,
  workspaceId: string,
  roleId: string,
): MessageTextValue => [
  MessageText.roleMention(MessageText.workspaceRef(client, workspaceId), roleId),
];

export const escapeMarkdown = (value: string): string =>
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
    .replaceAll("#", "\\#")
    .replaceAll("-", "\\-")
    .replaceAll("+", "\\+")
    .replaceAll("!", "\\!")
    .replaceAll("~", "\\~")
    .replaceAll("|", "\\|")
    .replaceAll(">", "\\>");

export const escapeInlineCode = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("`", "\\`");

const discordEmbedDescriptionLimit = 4_096;

export const boundEmbedDescription = (description: string, overflowSummary: string): string =>
  description.length <= discordEmbedDescriptionLimit
    ? description
    : (() => {
        const boundedSummary = overflowSummary.slice(0, discordEmbedDescriptionLimit);
        return `${description
          .slice(0, discordEmbedDescriptionLimit - boundedSummary.length)
          .trimEnd()}${boundedSummary}`;
      })();

const bold = (value: string): string => `**${value}**`;

export const makeEmbed = (embed: {
  readonly title?: MessageTextInput;
  readonly description?: MessageTextInput | null;
  readonly fields?: ReadonlyArray<{
    readonly name: MessageTextInput;
    readonly value: MessageTextInput;
    readonly inline?: boolean;
  }>;
  readonly footer?: { readonly text: MessageTextInput };
  readonly color?: number;
}): MessageEmbed => ({
  ...embed,
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
});

export const autoCheckinTestHour = 1;
const autoCheckinTestColor = 0xf59e0b;
export const autoCheckinTestNotice =
  "TEST RUN - no check-ins, room orders, roles, or persistent message records were created.";
const autoCheckinTestFailureDetailLength = 900;

export const truncateAutoCheckinTestFailureDetail = (value: string): string =>
  value.length <= autoCheckinTestFailureDetailLength
    ? value
    : `${value.slice(0, autoCheckinTestFailureDetailLength - 3)}...`;

export const makeAutoCheckinTestEmbed = (embed: {
  readonly title: MessageTextInput;
  readonly description?: MessageTextInput | null;
  readonly fields?: ReadonlyArray<{
    readonly name: MessageTextInput;
    readonly value: MessageTextInput;
    readonly inline?: boolean;
  }>;
}) =>
  makeEmbed({
    ...embed,
    color: autoCheckinTestColor,
    footer: { text: autoCheckinTestNotice },
  });

export const makeWebScheduleEmbed = () =>
  makeEmbed({
    description: [
      MessageText.text("📅 "),
      MessageText.strong([MessageText.text("Preview")]),
      MessageText.text(": View your schedule online at "),
      MessageText.externalLink("https://schedule.theerapakg.moe/"),
    ],
    color: 0x5865f2,
  });

export const isAutoCheckinEnabled = (autoCheckin: Option.Option<boolean>) =>
  Option.getOrElse(autoCheckin, () => false);

export const formatConversationConfigFields = (config: {
  readonly client: ClientRef;
  readonly workspaceId: string;
  readonly name: Option.Option<string>;
  readonly running: Option.Option<boolean>;
  readonly roleId: Option.Option<string>;
  readonly checkinConversationId: Option.Option<string>;
}) => [
  {
    name: "Name",
    value: Option.match(config.name, {
      onSome: escapeMarkdown,
      onNone: () => "None!",
    }),
  },
  {
    name: [MessageText.clientTerm("runDestination", { casing: "sentence" })],
    value: Option.match(config.running, {
      onSome: (running) => (running ? "Yes" : "No"),
      onNone: () => "None!",
    }),
  },
  {
    name: [MessageText.clientTerm("monitorRole", { casing: "sentence" })],
    value: Option.match(config.roleId, {
      onSome: (roleId) => roleMentionValue(config.client, config.workspaceId, roleId),
      onNone: () => "None!",
    }),
  },
  {
    name: [MessageText.clientTerm("checkinDestination", { casing: "sentence" })],
    value: Option.match(config.checkinConversationId, {
      onSome: (conversationId) =>
        conversationMentionValue(config.client, config.workspaceId, conversationId),
      onNone: () => "None!",
    }),
  },
];

export const formatHourRanges = (hours: readonly number[]): string => {
  if (hours.length === 0) return "None";
  const sorted = [...hours].sort((a, b) => a - b);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const h of sorted) {
    const last = ranges[ranges.length - 1];
    if (last === undefined) {
      ranges.push({ start: h, end: h });
    } else if (h === last.end + 1) {
      last.end = h;
    } else if (h !== last.end) {
      ranges.push({ start: h, end: h });
    }
  }
  return ranges
    .map(({ start, end }) => (start === end ? `${start}` : `${start}-${end}`))
    .join(", ");
};

export const welcomeEmbed = () =>
  makeEmbed({
    title: "Thanks for adding Tiara",
    description:
      "I help manage and monitor Project SEKAI tiering runs: schedules, check-ins, slots, room order, and run status from your team's Google Sheet.",
    color: 0x5865f2,
    fields: [
      {
        name: "Google Sheet adapter required",
        value: [
          MessageText.text(
            "This bot needs a compatible Google Sheet adapter before it can do useful work. For now, message ",
          ),
          MessageText.userMention("394295776655966219"),
          MessageText.text(" (Theerie) to get one."),
        ],
      },
      {
        name: "Run your own bot",
        value:
          "If you would rather not give the hosted bot your sheet ID, you can run your own bot from https://github.com/tiara-stack/tiara-stack with the Docker Compose file or Helm chart.",
      },
      {
        name: "Self-hosting requirements",
        value:
          "You will need a client application and bot token, a Google Cloud service account with Sheets access, Postgres, Redis, and either Docker Compose or a Kubernetes cluster. Optional pieces include Infisical for secret sync and an OTLP endpoint for traces/metrics.",
      },
    ],
    footer: {
      text: "happy mana/moniing~",
    },
  });

const discordGuildTextConversationType = 0;
const discordGuildAnnouncementConversationType = 5;
const sendableWorkspaceConversationTypes = new Set([
  discordGuildTextConversationType,
  discordGuildAnnouncementConversationType,
]);

const isSendableWorkspaceConversation = (conversation: ClientConversationCacheEntry) =>
  sendableWorkspaceConversationTypes.has(conversation.value.type);

const conversationPosition = (conversation: ClientConversationCacheEntry) =>
  Predicate.isNumber(conversation.value.position)
    ? conversation.value.position
    : Number.MAX_SAFE_INTEGER;

export const workspaceWelcomeConversationCandidates = (
  conversations: ReadonlyArray<ClientConversationCacheEntry>,
  systemConversationId: string | undefined,
) => {
  const sendableConversations = conversations.filter(isSendableWorkspaceConversation);
  const byId = new Map(
    sendableConversations.map((conversation) => [conversation.resourceId, conversation]),
  );
  const candidates: Array<ClientConversationCacheEntry> = [];
  const seen = new Set<string>();
  const addCandidate = (conversation: ClientConversationCacheEntry | undefined) => {
    if (conversation !== undefined && !seen.has(conversation.resourceId)) {
      seen.add(conversation.resourceId);
      candidates.push(conversation);
    }
  };

  if (systemConversationId !== undefined) {
    addCandidate(byId.get(systemConversationId));
  }

  addCandidate(
    sendableConversations.find(
      (conversation) => conversation.value.name?.toLowerCase() === "general",
    ),
  );

  for (const conversation of [...sendableConversations].sort((left, right) => {
    const positionDifference = conversationPosition(left) - conversationPosition(right);
    return positionDifference === 0
      ? left.resourceId.localeCompare(right.resourceId)
      : positionDifference;
  })) {
    addCandidate(conversation);
  }

  return candidates;
};

export const formatServiceStatusFieldValue = (service: ServiceStatus) => {
  const latency = service.latencyMs === null ? "unknown latency" : `${service.latencyMs}ms`;
  return Match.value(service.status).pipe(
    Match.when("ok", () => `OK - ${service.httpStatus ?? "unknown"} - ${latency}`),
    Match.when("down", () =>
      service.httpStatus !== null
        ? `DOWN - ${service.httpStatus} - ${latency}`
        : `DOWN - ${service.error ?? "request failed"}`,
    ),
    Match.exhaustive,
  );
};

export const hourWindowFor = (
  eventConfig: { readonly startTime: DateTime.DateTime },
  hour: number,
) => ({
  start: pipe(eventConfig.startTime, DateTime.addDuration(Duration.hours(hour - 1))),
  end: pipe(eventConfig.startTime, DateTime.addDuration(Duration.hours(hour))),
});

const formatHourWindow = (hourWindow: {
  readonly start: DateTime.DateTime;
  readonly end: DateTime.DateTime;
}) => {
  const formatTime = DateTime.format({
    hour: "2-digit",
    hourCycle: "h23",
    locale: "en-GB",
    minute: "2-digit",
  });
  return `${formatTime(hourWindow.start)}-${formatTime(hourWindow.end)}`;
};

const formatScheduleRange = (
  schedule: Sheet.PopulatedBreakSchedule | Sheet.PopulatedSchedule,
  eventConfig: { readonly startTime: DateTime.DateTime },
) =>
  pipe(
    schedule.hourWindow,
    Option.match({
      onSome: (hourWindow) => formatHourWindow(hourWindow),
      onNone: () =>
        pipe(
          schedule.hour,
          Option.match({
            onSome: (hour) => formatHourWindow(hourWindowFor(eventConfig, hour)),
            onNone: () => "??-??",
          }),
        ),
    }),
  );

const formatScheduleSlotParts = (
  schedule: Sheet.PopulatedSchedule,
  eventConfig: { readonly startTime: DateTime.DateTime },
) => ({
  empty: Sheet.PopulatedSchedule.empty(schedule),
  hourString: pipe(
    schedule.hour,
    Option.map((hour) => bold(`hour ${hour}`)),
    Option.getOrElse(() => bold("hour ??")),
  ),
  rangeString: formatScheduleRange(schedule, eventConfig),
});

const formatSlot = (
  schedule: Sheet.PopulatedBreakSchedule | Sheet.PopulatedSchedule,
  eventConfig: { readonly startTime: DateTime.DateTime },
  mode: "open" | "filled",
) =>
  Match.value(schedule).pipe(
    Match.tagsExhaustive({
      PopulatedBreakSchedule: () => "",
      PopulatedSchedule: (schedule) => {
        const { empty, hourString, rangeString } = formatScheduleSlotParts(schedule, eventConfig);
        const visible =
          mode === "open" ? !schedule.visible || empty > 0 : schedule.visible && empty === 0;
        if (!visible) {
          return "";
        }
        const slotCountString = mode === "open" && schedule.visible ? bold(`+${empty} |`) : "";
        return [slotCountString, hourString, rangeString].filter(EffectString.isNonEmpty).join(" ");
      },
    }),
  );

export const formatOpenSlot = (
  schedule: Sheet.PopulatedBreakSchedule | Sheet.PopulatedSchedule,
  eventConfig: { readonly startTime: DateTime.DateTime },
) => formatSlot(schedule, eventConfig, "open");

export const formatFilledSlot = (
  schedule: Sheet.PopulatedBreakSchedule | Sheet.PopulatedSchedule,
  eventConfig: { readonly startTime: DateTime.DateTime },
) => formatSlot(schedule, eventConfig, "filled");

export const joinDedupeAdjacent = (items: ReadonlyArray<string>) =>
  pipe(
    Chunk.fromIterable(items),
    Chunk.filter(EffectString.isNonEmpty),
    Chunk.dedupeAdjacent,
    Chunk.join("\n"),
  );

export const renderCheckedInContent = (
  initialMessage: ReadonlyArray<SheetTextPart>,
  members: ReadonlyArray<{ readonly memberId: string; readonly checkinAt: Option.Option<unknown> }>,
) => {
  const checkedInMentions = members.filter((member) => Option.isSome(member.checkinAt));

  return checkedInMentions.length > 0
    ? MessageText.parts(
        ...initialMessage,
        MessageText.text("\n\nChecked in: "),
        ...checkedInMentions.flatMap((member, index) =>
          MessageText.parts(
            index === 0 ? undefined : MessageText.text(" "),
            MessageText.userMention(member.memberId),
          ),
        ),
      )
    : initialMessage;
};

export const fillParticipantFromName = (name: string) => ({
  key: `name:${name}`,
  label: name,
  name,
});
