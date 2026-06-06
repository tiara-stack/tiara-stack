import {
  Chunk,
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Random,
  Schema,
  String as EffectString,
  pipe,
} from "effect";
import { DiscordMessageRequestSchema } from "dfx-discord-utils/discord/schema";
import {
  formatTentativeRoomOrderContent,
  hasTentativeRoomOrderPrefix,
  shouldSendTentativeRoomOrder,
} from "sheet-ingress-api/discordComponents";
import type { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import type { MessageSlot } from "sheet-ingress-api/schemas/messageSlot";
import type {
  CheckinDispatchPayload,
  CheckinDispatchResult,
  CheckinHandleButtonPayload,
  CheckinHandleButtonResult,
  ChannelListConfigDispatchPayload,
  ChannelListConfigDispatchResult,
  ChannelSetDispatchPayload,
  ChannelSetDispatchResult,
  ChannelUnsetDispatchPayload,
  ChannelUnsetDispatchResult,
  GuildWelcomeDispatchPayload,
  GuildWelcomeDispatchResult,
  KickoutDispatchPayload,
  KickoutDispatchResult,
  RoomOrderButtonResult,
  RoomOrderDispatchPayload,
  RoomOrderDispatchResult,
  RoomOrderNextButtonPayload,
  RoomOrderPinTentativeButtonPayload,
  RoomOrderPreviousButtonPayload,
  RoomOrderSendButtonPayload,
  ScheduleListDispatchPayload,
  ScheduleListDispatchResult,
  ServiceGuildFeatureFlagDispatchPayload,
  ServiceGuildFeatureFlagDispatchResult,
  ServiceStatusDispatchPayload,
  ServiceStatusDispatchResult,
  ServerAddMonitorRoleDispatchPayload,
  ServerAddMonitorRoleDispatchResult,
  ServerListConfigDispatchPayload,
  ServerListConfigDispatchResult,
  ServerRemoveMonitorRoleDispatchPayload,
  ServerRemoveMonitorRoleDispatchResult,
  ServerSetAutoCheckinDispatchPayload,
  ServerSetAutoCheckinDispatchResult,
  ServerSetSheetDispatchPayload,
  ServerSetSheetDispatchResult,
  ScreenshotDispatchPayload,
  ScreenshotDispatchResult,
  SlotButtonDispatchPayload,
  SlotButtonDispatchResult,
  SlotListDispatchPayload,
  SlotListDispatchResult,
  SlotOpenButtonPayload,
  SlotOpenButtonResult,
  TeamListDispatchPayload,
  TeamListDispatchResult,
  UpdateAnnouncementDispatchPayload,
  UpdateAnnouncementDispatchResult,
} from "sheet-ingress-api/sheet-apis-rpc";
import * as Sheet from "sheet-ingress-api/schemas/sheet";
import type { ServiceStatus } from "sheet-ingress-api/sheet-apis-rpc";
import { makeArgumentError, makeUnknownError } from "typhoon-core/error";
import { markInteractionFailureHandled } from "@/handlers/shared/interactionFailure";
import {
  checkinActionRow,
  roomOrderActionRow,
  slotActionRow,
  tentativeRoomOrderActionRow,
  tentativeRoomOrderPinActionRow,
} from "./discordComponents";
import { IngressBotClient } from "./ingressBotClient";
import { buildRoomOrderContent } from "./roomOrderContent";
import { SheetApisClient } from "./sheetApisClient";

const MessageFlags = {
  Ephemeral: 64,
} as const;

const updateAnnouncementsFeatureFlag = "update-announcements";

type DiscordMessage = {
  readonly id: string;
  readonly channel_id: string;
};

type DiscordChannelCacheEntry = {
  readonly parentId: string;
  readonly resourceId: string;
  readonly value: {
    readonly id: string;
    readonly type: number;
    readonly guild_id?: string;
    readonly name?: string;
    readonly position?: number;
  };
};

type MessagePayload = Schema.Schema.Type<typeof DiscordMessageRequestSchema>;
type SheetServiceApi = {
  readonly getEventConfig: ReturnType<
    typeof makeSheetApisServices
  >["sheetService"]["getEventConfig"];
};
type RoomOrderRankDirection = "previous" | "next";
type RoomOrderButtonPayload = RoomOrderPreviousButtonPayload;
type RoomOrderButtonMode = "normal" | "tentative";

type DispatchRequester = {
  readonly accountId: string;
  readonly userId: string;
};

type DispatchMessageSink = {
  readonly sendPrimary: (payload: MessagePayload) => Effect.Effect<DiscordMessage, unknown, never>;
  readonly updatePrimary: (
    message: DiscordMessage,
    payload: MessagePayload,
  ) => Effect.Effect<DiscordMessage, unknown, never>;
};

const optionalArgumentError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchIf(
      (error) => Predicate.hasProperty(error, "_tag") && error._tag === "ArgumentError",
      () => Effect.succeed(Option.none<A>()),
    ),
  );

const makeSheetApisServices = (sheetApisClient: typeof SheetApisClient.Service) => {
  const sheetApis = sheetApisClient.get();

  const messageRoomOrderService = {
    getMessageRoomOrder: (messageId: string) =>
      optionalArgumentError(
        sheetApis.messageRoomOrder.getMessageRoomOrder({ query: { messageId } }),
      ),
    upsertMessageRoomOrder: (
      messageId: string,
      data: Parameters<
        typeof sheetApis.messageRoomOrder.upsertMessageRoomOrder
      >[0]["payload"]["data"],
    ) => sheetApis.messageRoomOrder.upsertMessageRoomOrder({ payload: { messageId, data } }),
    persistMessageRoomOrder: (
      messageId: string,
      payload: Omit<
        Parameters<typeof sheetApis.messageRoomOrder.persistMessageRoomOrder>[0]["payload"],
        "messageId"
      >,
    ) =>
      sheetApis.messageRoomOrder.persistMessageRoomOrder({
        payload: { messageId, ...payload },
      }),
    decrementMessageRoomOrderRank: (
      messageId: string,
      payload: Omit<
        Parameters<typeof sheetApis.messageRoomOrder.decrementMessageRoomOrderRank>[0]["payload"],
        "messageId"
      >,
    ) =>
      sheetApis.messageRoomOrder.decrementMessageRoomOrderRank({
        payload: { messageId, ...payload },
      }),
    incrementMessageRoomOrderRank: (
      messageId: string,
      payload: Omit<
        Parameters<typeof sheetApis.messageRoomOrder.incrementMessageRoomOrderRank>[0]["payload"],
        "messageId"
      >,
    ) =>
      sheetApis.messageRoomOrder.incrementMessageRoomOrderRank({
        payload: { messageId, ...payload },
      }),
    getMessageRoomOrderEntry: (messageId: string, rank: number) =>
      sheetApis.messageRoomOrder.getMessageRoomOrderEntry({ query: { messageId, rank } }),
    getMessageRoomOrderRange: (messageId: string) =>
      optionalArgumentError(
        sheetApis.messageRoomOrder.getMessageRoomOrderRange({ query: { messageId } }),
      ),
    removeMessageRoomOrderEntry: (messageId: string) =>
      sheetApis.messageRoomOrder.removeMessageRoomOrderEntry({ payload: { messageId } }),
    claimMessageRoomOrderSend: (messageId: string, claimId: string) =>
      sheetApis.messageRoomOrder.claimMessageRoomOrderSend({ payload: { messageId, claimId } }),
    completeMessageRoomOrderSend: (
      messageId: string,
      claimId: string,
      sentMessage: { readonly id: string; readonly channelId: string },
    ) =>
      sheetApis.messageRoomOrder.completeMessageRoomOrderSend({
        payload: { messageId, claimId, sentMessage },
      }),
    releaseMessageRoomOrderSendClaim: (messageId: string, claimId: string) =>
      sheetApis.messageRoomOrder.releaseMessageRoomOrderSendClaim({
        payload: { messageId, claimId },
      }),
    claimMessageRoomOrderTentativeUpdate: (messageId: string, claimId: string) =>
      sheetApis.messageRoomOrder.claimMessageRoomOrderTentativeUpdate({
        payload: { messageId, claimId },
      }),
    releaseMessageRoomOrderTentativeUpdateClaim: (messageId: string, claimId: string) =>
      sheetApis.messageRoomOrder.releaseMessageRoomOrderTentativeUpdateClaim({
        payload: { messageId, claimId },
      }),
    claimMessageRoomOrderTentativePin: (messageId: string, claimId: string) =>
      sheetApis.messageRoomOrder.claimMessageRoomOrderTentativePin({
        payload: { messageId, claimId },
      }),
    completeMessageRoomOrderTentativePin: (messageId: string, claimId: string) =>
      sheetApis.messageRoomOrder.completeMessageRoomOrderTentativePin({
        payload: { messageId, claimId },
      }),
    releaseMessageRoomOrderTentativePinClaim: (messageId: string, claimId: string) =>
      sheetApis.messageRoomOrder.releaseMessageRoomOrderTentativePinClaim({
        payload: { messageId, claimId },
      }),
    markMessageRoomOrderTentative: (messageId: string) =>
      sheetApis.messageRoomOrder.markMessageRoomOrderTentative({
        payload: { messageId },
      }),
  };

  return {
    checkinService: {
      generate: (payload: CheckinDispatchPayload) => sheetApis.checkin.generate({ payload }),
    },
    guildConfigService: {
      getGuildConfig: (guildId: string) =>
        optionalArgumentError(sheetApis.guildConfig.getGuildConfig({ query: { guildId } })),
      upsertGuildConfig: (
        guildId: string,
        config: {
          readonly sheetId?: string | null | undefined;
          readonly autoCheckin?: boolean | null | undefined;
        },
      ) => sheetApis.guildConfig.upsertGuildConfig({ payload: { guildId, config } }),
      getGuildMonitorRoles: (guildId: string) =>
        sheetApis.guildConfig.getGuildMonitorRoles({ query: { guildId } }),
      getGuildFeatureFlags: (guildId: string) =>
        sheetApis.guildConfig.getGuildFeatureFlags({ query: { guildId } }),
      claimGuildUpdateAnnouncementDelivery: (claim: {
        readonly guildId: string;
        readonly announcementId: string;
        readonly publishedAt: DateTime.Utc;
        readonly claimToken: string;
      }) => sheetApis.guildConfig.claimGuildUpdateAnnouncementDelivery({ payload: claim }),
      releaseGuildUpdateAnnouncementDeliveryClaim: (claim: {
        readonly guildId: string;
        readonly announcementId: string;
        readonly claimToken: string;
      }) => sheetApis.guildConfig.releaseGuildUpdateAnnouncementDeliveryClaim({ payload: claim }),
      addGuildMonitorRole: (guildId: string, roleId: string) =>
        sheetApis.guildConfig.addGuildMonitorRole({ payload: { guildId, roleId } }),
      removeGuildMonitorRole: (guildId: string, roleId: string) =>
        sheetApis.guildConfig.removeGuildMonitorRole({ payload: { guildId, roleId } }),
      addGuildFeatureFlag: (guildId: string, flagName: string) =>
        sheetApis.guildConfig.addGuildFeatureFlag({ payload: { guildId, flagName } }),
      removeGuildFeatureFlag: (guildId: string, flagName: string) =>
        sheetApis.guildConfig.removeGuildFeatureFlag({ payload: { guildId, flagName } }),
      recordGuildUpdateAnnouncementDelivery: (delivery: {
        readonly guildId: string;
        readonly announcementId: string;
        readonly publishedAt: DateTime.Utc;
        readonly deliveredAt: DateTime.Utc;
        readonly channelId: string;
        readonly messageId: string;
      }) => sheetApis.guildConfig.recordGuildUpdateAnnouncementDelivery({ payload: delivery }),
      upsertGuildChannelConfig: (
        guildId: string,
        channelId: string,
        config: {
          readonly name?: string | null | undefined;
          readonly running?: boolean | null | undefined;
          readonly roleId?: string | null | undefined;
          readonly checkinChannelId?: string | null | undefined;
        },
      ) =>
        sheetApis.guildConfig.upsertGuildChannelConfig({
          payload: { guildId, channelId, config },
        }),
      getGuildChannelById: (query: {
        readonly guildId: string;
        readonly channelId: string;
        readonly running?: boolean | undefined;
      }) => optionalArgumentError(sheetApis.guildConfig.getGuildChannelById({ query })),
      getGuildChannelByName: (query: {
        readonly guildId: string;
        readonly channelName: string;
        readonly running?: boolean | undefined;
      }) => optionalArgumentError(sheetApis.guildConfig.getGuildChannelByName({ query })),
    },
    messageCheckinService: {
      getMessageCheckinData: (messageId: string) =>
        optionalArgumentError(
          sheetApis.messageCheckin.getMessageCheckinData({ query: { messageId } }),
        ),
      getMessageCheckinMembers: (messageId: string) =>
        sheetApis.messageCheckin.getMessageCheckinMembers({ query: { messageId } }),
      persistMessageCheckin: (
        messageId: string,
        payload: Omit<
          Parameters<typeof sheetApis.messageCheckin.persistMessageCheckin>[0]["payload"],
          "messageId"
        >,
      ) => sheetApis.messageCheckin.persistMessageCheckin({ payload: { messageId, ...payload } }),
      setMessageCheckinMemberCheckinAtIfUnset: (
        messageId: string,
        memberId: string,
        checkinAt: number,
        checkinClaimId: string,
      ) =>
        sheetApis.messageCheckin.setMessageCheckinMemberCheckinAtIfUnset({
          payload: { messageId, memberId, checkinAt, checkinClaimId },
        }),
    },
    messageRoomOrderService,
    messageSlotService: {
      getMessageSlotData: (messageId: string) =>
        optionalArgumentError(sheetApis.messageSlot.getMessageSlotData({ query: { messageId } })),
      upsertMessageSlotData: (
        messageId: string,
        data: Parameters<typeof sheetApis.messageSlot.upsertMessageSlotData>[0]["payload"]["data"],
      ) => sheetApis.messageSlot.upsertMessageSlotData({ payload: { messageId, data } }),
    },
    roomOrderService: {
      generate: (
        payload: RoomOrderDispatchPayload | { guildId: string; channelId: string; hour: number },
      ) => sheetApis.roomOrder.generate({ payload }),
    },
    scheduleService: {
      dayPopulatedFillerSchedules: (guildId: string, day: number) =>
        sheetApis.schedule
          .getDayPopulatedSchedules({ query: { guildId, day, view: "filler" } })
          .pipe(Effect.map(({ schedules }) => schedules)),
      dayPlayerSchedule: (guildId: string, day: number, accountId: string) =>
        sheetApis.schedule.getDayPlayerSchedule({
          query: { guildId, day, accountId, view: "filler" },
        }),
      channelPopulatedMonitorSchedules: (guildId: string, channel: string) =>
        sheetApis.schedule
          .getChannelPopulatedSchedules({ query: { guildId, channel, view: "monitor" } })
          .pipe(Effect.map(({ schedules }) => schedules)),
    },
    sheetService: {
      getEventConfig: (guildId: string) => sheetApis.sheet.getEventConfig({ query: { guildId } }),
    },
    statusService: {
      getServicesStatus: () => sheetApis.status.getServices({}),
    },
    playerService: {
      getTeamsByIds: (guildId: string, ids: readonly string[]) =>
        sheetApis.player.getTeamsByIds({ query: { guildId, ids } }),
    },
    screenshotService: {
      getScreenshot: (guildId: string, channel: string, day: number) =>
        sheetApis.screenshot.getScreenshot({ query: { guildId, channel, day } }),
    },
  };
};

const logEnableFailure = (message: string) => (error: unknown) =>
  Effect.logWarning(message).pipe(Effect.annotateLogs({ cause: globalThis.String(error) }));

const makeInteractionMessageSink = (
  botClient: typeof IngressBotClient.Service,
  interactionToken: string,
): DispatchMessageSink => ({
  sendPrimary: (payload) => botClient.updateOriginalInteractionResponse(interactionToken, payload),
  updatePrimary: (_message, payload) =>
    botClient.updateOriginalInteractionResponse(interactionToken, payload),
});

const makeChannelMessageSink = (
  botClient: typeof IngressBotClient.Service,
  channelId: string,
): DispatchMessageSink => ({
  sendPrimary: (payload) => botClient.sendMessage(channelId, payload),
  updatePrimary: (message, payload) =>
    botClient.updateMessage(message.channel_id, message.id, payload),
});

const makeMessageSink = (
  botClient: typeof IngressBotClient.Service,
  channelId: string,
  interactionToken: string | undefined,
): DispatchMessageSink =>
  typeof interactionToken === "string"
    ? makeInteractionMessageSink(botClient, interactionToken)
    : makeChannelMessageSink(botClient, channelId);

const mentionUser = (userId: string): string => `<@${userId}>`;

const mentionChannel = (channelId: string): string => `<#${channelId}>`;

const mentionRole = (roleId: string): string => `<@&${roleId}>`;

const escapeMarkdown = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("`", "\\`")
    .replaceAll("~", "\\~")
    .replaceAll("|", "\\|")
    .replaceAll(">", "\\>");

const bold = (value: string): string => `**${value}**`;

const time = (epochSeconds: number): string => `<t:${Math.floor(epochSeconds)}:t>`;

const makeEmbed = (embed: {
  readonly title?: string;
  readonly description?: string | null;
  readonly fields?: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
    readonly inline?: boolean;
  }>;
  readonly footer?: { readonly text: string };
  readonly color?: number;
}) => embed;

const makeWebScheduleEmbed = () =>
  makeEmbed({
    description: "📅 **Preview**: View your schedule online at <https://schedule.theerapakg.moe/>",
    color: 0x5865f2,
  });

const isAutoCheckinEnabled = (autoCheckin: Option.Option<boolean>) =>
  Option.getOrElse(autoCheckin, () => false);

const formatChannelConfigFields = (config: {
  readonly name: Option.Option<string>;
  readonly running: Option.Option<boolean>;
  readonly roleId: Option.Option<string>;
  readonly checkinChannelId: Option.Option<string>;
}) => [
  {
    name: "Name",
    value: Option.match(config.name, {
      onSome: escapeMarkdown,
      onNone: () => "None!",
    }),
  },
  { name: "Running channel", value: Option.getOrUndefined(config.running) ? "Yes" : "No" },
  {
    name: "Role",
    value: Option.match(config.roleId, {
      onSome: mentionRole,
      onNone: () => "None!",
    }),
  },
  {
    name: "Checkin channel",
    value: Option.match(config.checkinChannelId, {
      onSome: mentionChannel,
      onNone: () => "None!",
    }),
  },
];

const formatHourRanges = (hours: readonly number[]): string => {
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

const welcomeEmbed = () =>
  makeEmbed({
    title: "Thanks for adding Tiara",
    description:
      "I help manage and monitor Project SEKAI tiering runs: schedules, check-ins, slots, room order, and run status from your team's Google Sheet.",
    color: 0x5865f2,
    fields: [
      {
        name: "Google Sheet adapter required",
        value:
          "This bot needs a compatible Google Sheet adapter before it can do useful work. For now, message <@394295776655966219> (Theerie) to get one.",
      },
      {
        name: "Run your own bot",
        value:
          "If you would rather not give the hosted bot your sheet ID, you can run your own bot from https://github.com/tiara-stack/tiara-stack with the Docker Compose file or Helm chart.",
      },
      {
        name: "Self-hosting requirements",
        value:
          "You will need a Discord application and bot token, a Google Cloud service account with Sheets access, Postgres, Redis, and either Docker Compose or a Kubernetes cluster. Optional pieces include Infisical for secret sync and an OTLP endpoint for traces/metrics.",
      },
    ],
    footer: {
      text: "happy mana/moniing~",
    },
  });

const sendableGuildChannelTypes = new Set([0, 5]);

const isSendableGuildChannel = (channel: DiscordChannelCacheEntry) =>
  sendableGuildChannelTypes.has(channel.value.type);

const channelPosition = (channel: DiscordChannelCacheEntry) =>
  typeof channel.value.position === "number" ? channel.value.position : Number.MAX_SAFE_INTEGER;

const guildWelcomeChannelCandidates = (
  channels: ReadonlyArray<DiscordChannelCacheEntry>,
  systemChannelId: string | undefined,
) => {
  const sendableChannels = channels.filter(isSendableGuildChannel);
  const byId = new Map(sendableChannels.map((channel) => [channel.resourceId, channel]));
  const candidates: Array<DiscordChannelCacheEntry> = [];
  const seen = new Set<string>();
  const addCandidate = (channel: DiscordChannelCacheEntry | undefined) => {
    if (channel !== undefined && !seen.has(channel.resourceId)) {
      seen.add(channel.resourceId);
      candidates.push(channel);
    }
  };

  if (systemChannelId !== undefined) {
    addCandidate(byId.get(systemChannelId));
  }

  addCandidate(sendableChannels.find((channel) => channel.value.name?.toLowerCase() === "general"));

  for (const channel of [...sendableChannels].sort((left, right) => {
    const positionDifference = channelPosition(left) - channelPosition(right);
    return positionDifference === 0
      ? left.resourceId.localeCompare(right.resourceId)
      : positionDifference;
  })) {
    addCandidate(channel);
  }

  return candidates;
};

const sendGuildAnnouncementWithWelcomeHeuristic = (params: {
  readonly botClient: typeof IngressBotClient.Service;
  readonly guildId: string;
  readonly systemChannelId: string | undefined;
  readonly messagePayload: MessagePayload;
  readonly logLabel: string;
}) =>
  Effect.gen(function* () {
    const channels = yield* params.botClient.getChannelsForParent(params.guildId);
    const candidates = guildWelcomeChannelCandidates(channels, params.systemChannelId);

    for (const channel of candidates) {
      const sentMessage = yield* params.botClient
        .sendMessage(channel.resourceId, params.messagePayload)
        .pipe(
          Effect.map(Option.some),
          Effect.catchCause((cause) =>
            Effect.logWarning(`Failed to send ${params.logLabel}`).pipe(
              Effect.annotateLogs({
                guildId: params.guildId,
                channelId: channel.resourceId,
                channelName: channel.value.name,
              }),
              Effect.andThen(Effect.logDebug(cause)),
              Effect.as(Option.none<DiscordMessage>()),
            ),
          ),
        );

      if (Option.isSome(sentMessage)) {
        return sentMessage.value;
      }
    }

    return yield* Effect.fail(makeArgumentError(`Cannot send ${params.logLabel}`));
  });

const formatDateTime = (dateTime: DateTime.DateTime) => DateTime.toEpochMillis(dateTime) / 1000;

const formatServiceStatusFieldValue = (service: ServiceStatus) => {
  if (service.status === "ok") {
    const latency = service.latencyMs === null ? "unknown latency" : `${service.latencyMs}ms`;
    return `OK - ${service.httpStatus ?? "unknown"} - ${latency}`;
  }

  if (service.httpStatus !== null) {
    const latency = service.latencyMs === null ? "unknown latency" : `${service.latencyMs}ms`;
    return `DOWN - ${service.httpStatus} - ${latency}`;
  }

  return `DOWN - ${service.error ?? "request failed"}`;
};

const hourWindowFor = (eventConfig: { readonly startTime: DateTime.DateTime }, hour: number) => ({
  start: pipe(eventConfig.startTime, DateTime.addDuration(Duration.hours(hour - 1))),
  end: pipe(eventConfig.startTime, DateTime.addDuration(Duration.hours(hour))),
});

const formatHourWindow = (hourWindow: {
  readonly start: DateTime.DateTime;
  readonly end: DateTime.DateTime;
}) => `${time(formatDateTime(hourWindow.start))}-${time(formatDateTime(hourWindow.end))}`;

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

const formatOpenSlot = (
  schedule: Sheet.PopulatedBreakSchedule | Sheet.PopulatedSchedule,
  eventConfig: { readonly startTime: DateTime.DateTime },
) =>
  Match.value(schedule).pipe(
    Match.tagsExhaustive({
      PopulatedBreakSchedule: () => "",
      PopulatedSchedule: (schedule) => {
        const empty = Sheet.PopulatedSchedule.empty(schedule);
        const slotCountString = schedule.visible ? bold(`+${empty} |`) : "";
        const hourString = pipe(
          schedule.hour,
          Option.map((hour) => bold(`hour ${hour}`)),
          Option.getOrElse(() => bold("hour ??")),
        );
        const rangeString = formatScheduleRange(schedule, eventConfig);

        return !schedule.visible || empty > 0
          ? [slotCountString, hourString, rangeString].filter(EffectString.isNonEmpty).join(" ")
          : "";
      },
    }),
  );

const formatFilledSlot = (
  schedule: Sheet.PopulatedBreakSchedule | Sheet.PopulatedSchedule,
  eventConfig: { readonly startTime: DateTime.DateTime },
) =>
  Match.value(schedule).pipe(
    Match.tagsExhaustive({
      PopulatedBreakSchedule: () => "",
      PopulatedSchedule: (schedule) => {
        const empty = Sheet.PopulatedSchedule.empty(schedule);
        const hourString = pipe(
          schedule.hour,
          Option.map((hour) => bold(`hour ${hour}`)),
          Option.getOrElse(() => bold("hour ??")),
        );
        const rangeString = formatScheduleRange(schedule, eventConfig);

        return schedule.visible && empty === 0
          ? [hourString, rangeString].filter(EffectString.isNonEmpty).join(" ")
          : "";
      },
    }),
  );

const joinDedupeAdjacent = (items: ReadonlyArray<string>) =>
  pipe(Chunk.fromIterable(items), Chunk.dedupeAdjacent, Chunk.join("\n"));

const renderCheckedInContent = (
  initialMessage: string,
  members: ReadonlyArray<{ readonly memberId: string; readonly checkinAt: Option.Option<unknown> }>,
) => {
  const checkedInMentions = members
    .filter((member) => Option.isSome(member.checkinAt))
    .map((member) => mentionUser(member.memberId));

  return checkedInMentions.length > 0
    ? `${initialMessage}\n\nChecked in: ${checkedInMentions.join(" ")}`
    : initialMessage;
};

const fillParticipantFromName = (name: string) => ({
  key: `name:${name}`,
  label: name,
  name,
});

const renderRoomOrderReply = Effect.fn("DispatchService.renderRoomOrderReply")(function* ({
  guildId,
  messageId,
  mode,
  roomOrder,
  sheetService,
  messageRoomOrderService,
}: {
  readonly guildId: string;
  readonly messageId: string;
  readonly mode: "normal" | "tentative";
  readonly roomOrder: MessageRoomOrder;
  readonly sheetService: SheetServiceApi;
  readonly messageRoomOrderService: ReturnType<
    typeof makeSheetApisServices
  >["messageRoomOrderService"];
}) {
  yield* Effect.annotateCurrentSpan({ guildId, messageId, mode, hour: roomOrder.hour });
  const maybeRange = yield* messageRoomOrderService.getMessageRoomOrderRange(messageId);
  const entries = yield* messageRoomOrderService.getMessageRoomOrderEntry(
    messageId,
    roomOrder.rank,
  );
  const range = yield* Option.match(maybeRange, {
    onSome: Effect.succeed,
    onNone: () => Effect.fail(makeArgumentError("Cannot render room order, no entries found")),
  });
  const eventConfig = yield* sheetService.getEventConfig(guildId);
  const start = pipe(
    eventConfig.startTime,
    DateTime.addDuration(Duration.hours(roomOrder.hour - 1)),
  );
  const end = pipe(eventConfig.startTime, DateTime.addDuration(Duration.hours(roomOrder.hour)));

  const content = buildRoomOrderContent(
    roomOrder.hour,
    start,
    end,
    Option.getOrNull(roomOrder.monitor),
    roomOrder.previousFills.map(fillParticipantFromName),
    roomOrder.fills.map(fillParticipantFromName),
    entries,
  );

  return mode === "tentative"
    ? {
        content: formatTentativeRoomOrderContent(content),
        components: [tentativeRoomOrderActionRow(range, roomOrder.rank)],
      }
    : {
        content,
        components: [roomOrderActionRow(range, roomOrder.rank)],
      };
});

const sendTentativeRoomOrder = Effect.fn("DispatchService.sendTentativeRoomOrder")(function* ({
  guildId,
  runningChannelId,
  hour,
  fillCount,
  createdByUserId,
  botClient,
  roomOrderService,
  messageRoomOrderService,
}: {
  readonly guildId: string;
  readonly runningChannelId: string;
  readonly hour: number;
  readonly fillCount: number;
  readonly createdByUserId: string | null;
  readonly botClient: typeof IngressBotClient.Service;
  readonly roomOrderService: ReturnType<typeof makeSheetApisServices>["roomOrderService"];
  readonly messageRoomOrderService: ReturnType<
    typeof makeSheetApisServices
  >["messageRoomOrderService"];
}) {
  yield* Effect.annotateCurrentSpan({
    guildId,
    channelId: runningChannelId,
    hour,
    fillCount,
  });
  if (!shouldSendTentativeRoomOrder(fillCount)) {
    return null;
  }

  return yield* Effect.gen(function* () {
    const generated = yield* roomOrderService.generate({
      guildId,
      channelId: runningChannelId,
      hour,
    });

    const sentMessage = yield* botClient.sendMessage(runningChannelId, {
      content: formatTentativeRoomOrderContent(generated.content),
      components: [tentativeRoomOrderActionRow(generated.range, generated.rank)],
    });

    yield* Effect.gen(function* () {
      yield* messageRoomOrderService.persistMessageRoomOrder(sentMessage.id, {
        data: {
          previousFills: generated.previousFills,
          fills: generated.fills,
          hour: generated.hour,
          rank: generated.rank,
          tentative: true,
          monitor: generated.monitor,
          guildId,
          messageChannelId: sentMessage.channel_id,
          createdByUserId,
        },
        entries: generated.entries,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Failed to persist tentative room order").pipe(
          Effect.annotateLogs({
            guildId,
            runningChannelId,
            hour,
            messageId: sentMessage.id,
          }),
          Effect.andThen(Effect.logError(cause)),
          Effect.andThen(
            botClient
              .updateMessage(sentMessage.channel_id, sentMessage.id, {
                components: [tentativeRoomOrderPinActionRow()],
              })
              .pipe(
                Effect.catchCause((updateCause) =>
                  Effect.logError(
                    "Failed to persist tentative room order and downgrade buttons",
                  ).pipe(
                    Effect.annotateLogs({
                      guildId,
                      runningChannelId,
                      hour,
                      messageId: sentMessage.id,
                    }),
                    Effect.andThen(Effect.logError(cause)),
                    Effect.andThen(Effect.logError(updateCause)),
                  ),
                ),
              ),
          ),
        ),
      ),
    );

    return {
      messageId: sentMessage.id,
      messageChannelId: sentMessage.channel_id,
    };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Failed to send tentative room order").pipe(
        Effect.annotateLogs({
          guildId,
          runningChannelId,
          hour,
        }),
        Effect.andThen(Effect.logError(cause)),
        Effect.as(null),
      ),
    ),
  );
});

export class DispatchService extends Context.Service<DispatchService>()("DispatchService", {
  make: Effect.gen(function* () {
    const botClient = yield* IngressBotClient;
    const sheetApisClient = yield* SheetApisClient;
    const {
      checkinService,
      guildConfigService,
      messageCheckinService,
      messageRoomOrderService,
      messageSlotService,
      roomOrderService,
      scheduleService,
      sheetService,
      statusService,
      playerService,
      screenshotService,
    } = makeSheetApisServices(sheetApisClient);

    const failRoomOrderInteraction = (
      payload: RoomOrderButtonPayload,
      content: string,
      errorMessage: string,
    ) =>
      botClient
        .updateOriginalInteractionResponse(payload.interactionToken, {
          content,
          components: [],
        })
        .pipe(
          Effect.andThen(
            Effect.fail(markInteractionFailureHandled(makeArgumentError(errorMessage))),
          ),
        );

    const requireRoomOrderMatch = (payload: RoomOrderButtonPayload, roomOrder: MessageRoomOrder) =>
      Effect.gen(function* () {
        if (
          !Option.contains(roomOrder.guildId, payload.guildId) ||
          !Option.contains(roomOrder.messageChannelId, payload.messageChannelId)
        ) {
          return yield* failRoomOrderInteraction(
            payload,
            "This room-order message authorization changed.",
            "Cannot handle room-order button, authorization changed",
          );
        }
      });

    const requireClaimedRoomOrderMatch = (
      payload: RoomOrderButtonPayload,
      roomOrder: MessageRoomOrder,
      releaseClaim: Effect.Effect<unknown, unknown, never>,
    ) =>
      requireRoomOrderMatch(payload, roomOrder).pipe(
        Effect.catchCause((cause) =>
          releaseClaim.pipe(
            Effect.catchCause(() => Effect.void),
            Effect.andThen(Effect.failCause(cause)),
          ),
        ),
      );

    const loadInitialRoomOrder = Effect.fn("DispatchService.loadInitialRoomOrder")(function* (
      payload: RoomOrderButtonPayload,
      authorizedRoomOrder?: MessageRoomOrder | null,
    ) {
      return authorizedRoomOrder === null
        ? Option.none<MessageRoomOrder>()
        : authorizedRoomOrder === undefined
          ? yield* messageRoomOrderService.getMessageRoomOrder(payload.messageId)
          : Option.some(authorizedRoomOrder);
    });

    const handleFallbackTentativePin = Effect.fn(
      "DispatchService.roomOrderPinTentativeButton.handleFallbackTentativePin",
    )(function* (payload: RoomOrderPinTentativeButtonPayload) {
      const fallbackChannel = yield* guildConfigService.getGuildChannelById({
        guildId: payload.guildId,
        channelId: payload.messageChannelId,
        running: true,
      });
      if (Option.isNone(fallbackChannel)) {
        yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
          content: "This channel is not a registered running channel.",
          components: [],
        });
        return yield* Effect.fail(
          markInteractionFailureHandled(
            makeArgumentError(
              "Cannot handle room-order button, message channel is not a registered running channel",
            ),
          ),
        );
      }

      const pinned = yield* botClient.createPin(payload.messageChannelId, payload.messageId).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logError("Failed to pin fallback tentative room order").pipe(
            Effect.annotateLogs({
              guildId: payload.guildId,
              channelId: payload.messageChannelId,
              messageId: payload.messageId,
            }),
            Effect.andThen(Effect.logError(cause)),
            Effect.as(false),
          ),
        ),
      );

      const cleanedUp = pinned
        ? yield* botClient
            .updateMessage(payload.messageChannelId, payload.messageId, {
              components: [],
            })
            .pipe(
              Effect.as(true),
              Effect.catchCause((cause) =>
                Effect.logError("Failed to clean up fallback tentative room order").pipe(
                  Effect.annotateLogs({
                    guildId: payload.guildId,
                    channelId: payload.messageChannelId,
                    messageId: payload.messageId,
                  }),
                  Effect.andThen(Effect.logError(cause)),
                  Effect.as(false),
                ),
              ),
            )
        : false;

      const detail = pinned
        ? cleanedUp
          ? "pinned tentative room order!"
          : "pinned tentative room order, but failed to clean up the message."
        : "tentative room order could not be pinned.";
      yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
        content: detail,
        components: [],
      });

      return {
        messageId: payload.messageId,
        messageChannelId: payload.messageChannelId,
        status: pinned ? (cleanedUp ? "pinned" : "partial") : "failed",
        detail,
      } satisfies RoomOrderButtonResult;
    });

    const loadRequiredRoomOrderContext = Effect.fn("DispatchService.loadRequiredRoomOrderContext")(
      function* (payload: RoomOrderButtonPayload, initialRoomOrder: MessageRoomOrder) {
        yield* requireRoomOrderMatch(payload, initialRoomOrder);
        const trustedGuildId = yield* Option.match(initialRoomOrder.guildId, {
          onSome: Effect.succeed,
          onNone: () =>
            failRoomOrderInteraction(
              payload,
              "This room-order message guild is not registered.",
              "Cannot handle room-order button, message guild is not registered",
            ),
        });
        const trustedMessageChannelId = yield* Option.match(initialRoomOrder.messageChannelId, {
          onSome: Effect.succeed,
          onNone: () =>
            failRoomOrderInteraction(
              payload,
              "This room-order message channel is not registered.",
              "Cannot handle room-order button, message channel is not registered",
            ),
        });
        const messageHasTentativePrefix = hasTentativeRoomOrderPrefix(payload.messageContent ?? "");
        const effectiveInitialRoomOrder =
          !initialRoomOrder.tentative && messageHasTentativePrefix
            ? yield* messageRoomOrderService.markMessageRoomOrderTentative(payload.messageId).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Failed to repair legacy tentative room-order flag").pipe(
                    Effect.annotateLogs({
                      guildId: trustedGuildId,
                      messageId: payload.messageId,
                      channelId: trustedMessageChannelId,
                    }),
                    Effect.andThen(Effect.logError(cause)),
                    Effect.as(initialRoomOrder),
                  ),
                ),
              )
            : initialRoomOrder;
        const mode: RoomOrderButtonMode = effectiveInitialRoomOrder.tentative
          ? "tentative"
          : "normal";
        const interactionResponseType =
          payload.interactionResponseType ?? (mode === "tentative" ? "reply" : "update");
        const renderReply = (
          roomOrder: MessageRoomOrder,
          replyMode: "normal" | "tentative" = mode,
        ) =>
          renderRoomOrderReply({
            guildId: trustedGuildId,
            messageId: payload.messageId,
            mode: replyMode,
            roomOrder,
            sheetService,
            messageRoomOrderService,
          });

        const updateInteraction = (
          content: string,
          components: ReadonlyArray<Record<string, unknown>> = [],
        ) =>
          botClient.updateOriginalInteractionResponse(payload.interactionToken, {
            content,
            components,
          });

        const getRoomOrderBusyDetail = (roomOrder: MessageRoomOrder) => {
          if (Option.isSome(roomOrder.sendClaimId)) {
            return "room order is already being sent.";
          }
          if (Option.isSome(roomOrder.tentativeUpdateClaimId)) {
            return "tentative room order is already being updated.";
          }
          if (Option.isSome(roomOrder.tentativePinnedAt)) {
            return "tentative room order is already pinned.";
          }
          return "tentative room order is already being pinned.";
        };

        const requireCurrentRoomOrderMatch = () =>
          Effect.gen(function* () {
            const maybeCurrentRoomOrder = yield* messageRoomOrderService.getMessageRoomOrder(
              payload.messageId,
            );
            const currentRoomOrder = yield* Option.match(maybeCurrentRoomOrder, {
              onSome: Effect.succeed,
              onNone: () =>
                failRoomOrderInteraction(
                  payload,
                  "This room-order message is not registered.",
                  "Cannot handle room-order button, message is not registered",
                ),
            });
            yield* requireRoomOrderMatch(payload, currentRoomOrder);
            return currentRoomOrder;
          });

        return {
          initialRoomOrder,
          trustedGuildId,
          trustedMessageChannelId,
          mode,
          interactionResponseType,
          renderReply,
          updateInteraction,
          getRoomOrderBusyDetail,
          requireCurrentRoomOrderMatch,
        };
      },
    );

    const requireInitialRoomOrder = (
      payload: RoomOrderButtonPayload,
      maybeInitialRoomOrder: Option.Option<MessageRoomOrder>,
    ) =>
      Option.match(maybeInitialRoomOrder, {
        onSome: Effect.succeed,
        onNone: () =>
          botClient
            .updateOriginalInteractionResponse(payload.interactionToken, {
              content: "This room-order message is not registered.",
              components: [],
            })
            .pipe(
              Effect.andThen(
                Effect.fail(
                  markInteractionFailureHandled(
                    makeArgumentError("Cannot handle room-order button, message is not registered"),
                  ),
                ),
              ),
            ),
      });

    const roomOrderButtonResult = (
      payload: RoomOrderButtonPayload,
      messageChannelId: string,
      status: RoomOrderButtonResult["status"],
      detail: string | null,
    ) =>
      ({
        messageId: payload.messageId,
        messageChannelId,
        status,
        detail,
      }) satisfies RoomOrderButtonResult;

    const denyRoomOrderButton = Effect.fn("DispatchService.denyRoomOrderButton")(function* ({
      detail,
      messageChannelId,
      payload,
      updateInteraction,
    }: {
      readonly detail: string;
      readonly messageChannelId: string;
      readonly payload: RoomOrderButtonPayload;
      readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
    }) {
      yield* updateInteraction(detail);
      return roomOrderButtonResult(payload, messageChannelId, "denied", detail);
    });

    const acknowledgeRoomOrderButton = (
      updateInteraction: (content: string) => Effect.Effect<unknown, unknown>,
      content: string,
    ) =>
      updateInteraction(content).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Failed to update room-order button acknowledgement").pipe(
            Effect.andThen(Effect.logError(cause)),
          ),
        ),
      );

    const releaseTentativeUpdateClaim = (messageId: string, updateClaimId: string) =>
      messageRoomOrderService
        .releaseMessageRoomOrderTentativeUpdateClaim(messageId, updateClaimId)
        .pipe(Effect.catchCause(() => Effect.void));

    const rollbackRoomOrderRankUpdate = (
      payload: RoomOrderButtonPayload,
      updateClaimId: string,
      updatedRank: MessageRoomOrder,
      direction: RoomOrderRankDirection,
      updateInteraction: (content: string) => Effect.Effect<unknown, unknown>,
      cause: Cause.Cause<unknown>,
    ) =>
      (direction === "previous"
        ? messageRoomOrderService.incrementMessageRoomOrderRank(payload.messageId, {
            expectedRank: updatedRank.rank,
            tentativeUpdateClaimId: updateClaimId,
          })
        : messageRoomOrderService.decrementMessageRoomOrderRank(payload.messageId, {
            expectedRank: updatedRank.rank,
            tentativeUpdateClaimId: updateClaimId,
          })
      ).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.andThen(releaseTentativeUpdateClaim(payload.messageId, updateClaimId)),
        Effect.andThen(
          updateInteraction("room order could not be updated.").pipe(
            Effect.catchCause(() => Effect.void),
          ),
        ),
        Effect.andThen(
          Effect.fail(
            markInteractionFailureHandled(
              makeUnknownError("Failed to update room-order button interaction", cause),
            ),
          ),
        ),
      );

    const requireTentativeUpdateClaim = Effect.fn("DispatchService.requireTentativeUpdateClaim")(
      function* ({
        claimedRoomOrder,
        getRoomOrderBusyDetail,
        messageChannelId,
        payload,
        updateClaimId,
        updateInteraction,
      }: {
        readonly claimedRoomOrder: MessageRoomOrder;
        readonly getRoomOrderBusyDetail: (roomOrder: MessageRoomOrder) => string;
        readonly messageChannelId: string;
        readonly payload: RoomOrderButtonPayload;
        readonly updateClaimId: string;
        readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
      }) {
        if (
          Option.isSome(claimedRoomOrder.tentativePinnedAt) ||
          Option.isSome(claimedRoomOrder.tentativePinClaimId) ||
          !Option.contains(claimedRoomOrder.tentativeUpdateClaimId, updateClaimId)
        ) {
          return Option.some(
            yield* denyRoomOrderButton({
              detail: getRoomOrderBusyDetail(claimedRoomOrder),
              messageChannelId,
              payload,
              updateInteraction,
            }),
          );
        }

        return Option.none<RoomOrderButtonResult>();
      },
    );

    const updateRoomOrderRank = Effect.fn("DispatchService.updateRoomOrderRank")(function* ({
      direction,
      getRoomOrderBusyDetail,
      initialRoomOrder,
      messageChannelId,
      payload,
      updateClaimId,
      updateInteraction,
    }: {
      readonly direction: RoomOrderRankDirection;
      readonly getRoomOrderBusyDetail: (roomOrder: MessageRoomOrder) => string;
      readonly initialRoomOrder: MessageRoomOrder;
      readonly messageChannelId: string;
      readonly payload: RoomOrderButtonPayload;
      readonly updateClaimId: string;
      readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
    }) {
      const isPrevious = direction === "previous";
      const updatedRank = yield* (
        isPrevious
          ? messageRoomOrderService.decrementMessageRoomOrderRank(payload.messageId, {
              expectedRank: initialRoomOrder.rank,
              tentativeUpdateClaimId: updateClaimId,
            })
          : messageRoomOrderService.incrementMessageRoomOrderRank(payload.messageId, {
              expectedRank: initialRoomOrder.rank,
              tentativeUpdateClaimId: updateClaimId,
            })
      ).pipe(
        Effect.catchCause((cause) =>
          releaseTentativeUpdateClaim(payload.messageId, updateClaimId).pipe(
            Effect.andThen(Effect.failCause(cause)),
          ),
        ),
      );
      const expectedRank = initialRoomOrder.rank + (isPrevious ? -1 : 1);
      if (updatedRank.rank === expectedRank) {
        return { _tag: "updated" as const, roomOrder: updatedRank };
      }

      const detail =
        Option.isSome(updatedRank.sendClaimId) ||
        Option.isSome(updatedRank.tentativeUpdateClaimId) ||
        Option.isSome(updatedRank.tentativePinnedAt) ||
        Option.isSome(updatedRank.tentativePinClaimId)
          ? getRoomOrderBusyDetail(updatedRank)
          : "room order could not be updated.";
      yield* releaseTentativeUpdateClaim(payload.messageId, updateClaimId);
      return {
        _tag: "denied" as const,
        result: yield* denyRoomOrderButton({
          detail,
          messageChannelId,
          payload,
          updateInteraction,
        }),
      };
    });

    const publishRoomOrderRankUpdate = Effect.fn("DispatchService.publishRoomOrderRankUpdate")(
      function* ({
        direction,
        interactionResponseType,
        messageChannelId,
        mode,
        payload,
        renderReply,
        updateClaimId,
        updatedRank,
        updateInteraction,
      }: {
        readonly direction: RoomOrderRankDirection;
        readonly interactionResponseType: "reply" | "update";
        readonly messageChannelId: string;
        readonly mode: RoomOrderButtonMode;
        readonly payload: RoomOrderButtonPayload;
        readonly renderReply: (
          roomOrder: MessageRoomOrder,
        ) => Effect.Effect<MessagePayload, unknown>;
        readonly updateClaimId: string;
        readonly updatedRank: MessageRoomOrder;
        readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
      }) {
        const rollback = (cause: Cause.Cause<unknown>) =>
          rollbackRoomOrderRankUpdate(
            payload,
            updateClaimId,
            updatedRank,
            direction,
            updateInteraction,
            cause,
          );
        const reply = yield* renderReply(updatedRank).pipe(Effect.catchCause(rollback));

        if (mode === "tentative" || interactionResponseType === "reply") {
          yield* botClient
            .updateMessage(messageChannelId, payload.messageId, reply)
            .pipe(Effect.catchCause(rollback));
          yield* releaseTentativeUpdateClaim(payload.messageId, updateClaimId);
          yield* acknowledgeRoomOrderButton(
            updateInteraction,
            mode === "tentative" ? "updated tentative room order." : "updated room order.",
          );
          return;
        }

        yield* botClient
          .updateOriginalInteractionResponse(payload.interactionToken, reply)
          .pipe(Effect.catchCause(rollback));
        yield* releaseTentativeUpdateClaim(payload.messageId, updateClaimId);
      },
    );

    const handleRoomOrderRankButton = Effect.fn("DispatchService.handleRoomOrderRankButton")(
      function* (
        payload: RoomOrderButtonPayload,
        authorizedRoomOrder: MessageRoomOrder | undefined,
        direction: RoomOrderRankDirection,
      ) {
        yield* Effect.annotateCurrentSpan({
          guildId: payload.guildId,
          channelId: payload.messageChannelId,
          messageId: payload.messageId,
          direction,
        });
        const maybeInitialRoomOrder = yield* loadInitialRoomOrder(payload, authorizedRoomOrder);
        const initialRoomOrder = yield* requireInitialRoomOrder(payload, maybeInitialRoomOrder);
        const {
          trustedMessageChannelId,
          mode,
          interactionResponseType,
          renderReply,
          updateInteraction,
          getRoomOrderBusyDetail,
          requireCurrentRoomOrderMatch,
        } = yield* loadRequiredRoomOrderContext(payload, initialRoomOrder);
        if (mode === "tentative" && Option.isSome(initialRoomOrder.tentativePinnedAt)) {
          return yield* denyRoomOrderButton({
            detail: "tentative room order is already pinned.",
            messageChannelId: trustedMessageChannelId,
            payload,
            updateInteraction,
          });
        }

        yield* requireCurrentRoomOrderMatch();
        const updateClaimId = globalThis.crypto.randomUUID();
        const claimedRoomOrder =
          yield* messageRoomOrderService.claimMessageRoomOrderTentativeUpdate(
            payload.messageId,
            updateClaimId,
          );
        yield* requireClaimedRoomOrderMatch(
          payload,
          claimedRoomOrder,
          messageRoomOrderService.releaseMessageRoomOrderTentativeUpdateClaim(
            payload.messageId,
            updateClaimId,
          ),
        );
        const unavailableClaim = yield* requireTentativeUpdateClaim({
          claimedRoomOrder,
          getRoomOrderBusyDetail,
          messageChannelId: trustedMessageChannelId,
          payload,
          updateClaimId,
          updateInteraction,
        });
        if (Option.isSome(unavailableClaim)) {
          return unavailableClaim.value;
        }

        const rankUpdate = yield* updateRoomOrderRank({
          direction,
          getRoomOrderBusyDetail,
          initialRoomOrder,
          messageChannelId: trustedMessageChannelId,
          payload,
          updateClaimId,
          updateInteraction,
        });
        if (rankUpdate._tag === "denied") {
          return rankUpdate.result;
        }

        yield* publishRoomOrderRankUpdate({
          direction,
          interactionResponseType,
          messageChannelId: trustedMessageChannelId,
          mode,
          payload,
          renderReply,
          updateClaimId,
          updatedRank: rankUpdate.roomOrder,
          updateInteraction,
        });

        return roomOrderButtonResult(payload, trustedMessageChannelId, "updated", null);
      },
    );

    const requireRoomOrderSendPreflight = Effect.fn(
      "DispatchService.requireRoomOrderSendPreflight",
    )(function* ({
      initialRoomOrder,
      mode,
      payload,
      trustedMessageChannelId,
      updateInteraction,
    }: {
      readonly initialRoomOrder: MessageRoomOrder;
      readonly mode: RoomOrderButtonMode;
      readonly payload: RoomOrderSendButtonPayload;
      readonly trustedMessageChannelId: string;
      readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
    }) {
      if (mode === "tentative") {
        return Option.some(
          yield* denyRoomOrderButton({
            detail: "cannot send a tentative room order.",
            messageChannelId: trustedMessageChannelId,
            payload,
            updateInteraction,
          }),
        );
      }
      if (
        Option.isSome(initialRoomOrder.sentMessageId) &&
        Option.isSome(initialRoomOrder.sentMessageChannelId)
      ) {
        const detail = "room order was already sent.";
        yield* updateInteraction(detail);
        return Option.some({
          messageId: initialRoomOrder.sentMessageId.value,
          messageChannelId: initialRoomOrder.sentMessageChannelId.value,
          status: "sent",
          detail,
        } satisfies RoomOrderButtonResult);
      }
      if (Option.isSome(initialRoomOrder.tentativePinnedAt)) {
        return Option.some(
          yield* denyRoomOrderButton({
            detail: "tentative room order is already pinned.",
            messageChannelId: trustedMessageChannelId,
            payload,
            updateInteraction,
          }),
        );
      }

      return Option.none<RoomOrderButtonResult>();
    });

    const requireRoomOrderSendClaim = Effect.fn("DispatchService.requireRoomOrderSendClaim")(
      function* ({
        claimId,
        claimedRoomOrder,
        getRoomOrderBusyDetail,
        payload,
        trustedMessageChannelId,
        updateInteraction,
      }: {
        readonly claimId: string;
        readonly claimedRoomOrder: MessageRoomOrder;
        readonly getRoomOrderBusyDetail: (roomOrder: MessageRoomOrder) => string;
        readonly payload: RoomOrderSendButtonPayload;
        readonly trustedMessageChannelId: string;
        readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
      }) {
        if (
          Option.isSome(claimedRoomOrder.sentMessageId) &&
          Option.isSome(claimedRoomOrder.sentMessageChannelId)
        ) {
          const detail = "room order was already sent.";
          yield* updateInteraction(detail);
          return Option.some({
            messageId: claimedRoomOrder.sentMessageId.value,
            messageChannelId: claimedRoomOrder.sentMessageChannelId.value,
            status: "sent",
            detail,
          } satisfies RoomOrderButtonResult);
        }
        if (!Option.contains(claimedRoomOrder.sendClaimId, claimId)) {
          return Option.some(
            yield* denyRoomOrderButton({
              detail: getRoomOrderBusyDetail(claimedRoomOrder),
              messageChannelId: trustedMessageChannelId,
              payload,
              updateInteraction,
            }),
          );
        }

        return Option.none<RoomOrderButtonResult>();
      },
    );

    const failRoomOrderSend = (
      payload: RoomOrderSendButtonPayload,
      claimId: string,
      updateInteraction: (content: string) => Effect.Effect<unknown, unknown>,
      cause: Cause.Cause<unknown>,
    ) =>
      messageRoomOrderService.releaseMessageRoomOrderSendClaim(payload.messageId, claimId).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.andThen(
          updateInteraction("room order could not be sent.").pipe(
            Effect.catchCause(() => Effect.void),
          ),
        ),
        Effect.andThen(
          Effect.fail(
            markInteractionFailureHandled(
              makeUnknownError("Failed to send room-order button interaction", cause),
            ),
          ),
        ),
      );

    const sendRoomOrderMessage = Effect.fn("DispatchService.sendRoomOrderMessage")(function* ({
      claimId,
      claimedRoomOrder,
      payload,
      renderReply,
      trustedMessageChannelId,
      updateInteraction,
    }: {
      readonly claimId: string;
      readonly claimedRoomOrder: MessageRoomOrder;
      readonly payload: RoomOrderSendButtonPayload;
      readonly renderReply: (
        roomOrder: MessageRoomOrder,
        replyMode: "normal",
      ) => Effect.Effect<MessagePayload, unknown>;
      readonly trustedMessageChannelId: string;
      readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
    }) {
      const reply = yield* renderReply(claimedRoomOrder, "normal").pipe(
        Effect.catchCause((cause) => failRoomOrderSend(payload, claimId, updateInteraction, cause)),
      );
      return yield* botClient
        .sendMessage(trustedMessageChannelId, {
          content: reply.content,
          nonce: payload.messageId,
          enforce_nonce: true,
        })
        .pipe(
          Effect.catchCause((cause) =>
            failRoomOrderSend(payload, claimId, updateInteraction, cause),
          ),
        );
    });

    const completeRoomOrderSendTracking = Effect.fn(
      "DispatchService.completeRoomOrderSendTracking",
    )(function* ({
      claimId,
      payload,
      sentMessage,
      updateInteraction,
    }: {
      readonly claimId: string;
      readonly payload: RoomOrderSendButtonPayload;
      readonly sentMessage: { readonly id: string; readonly channel_id: string };
      readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
    }) {
      const completedRoomOrder = yield* messageRoomOrderService.completeMessageRoomOrderSend(
        payload.messageId,
        claimId,
        {
          id: sentMessage.id,
          channelId: sentMessage.channel_id,
        },
      );
      if (
        Option.isNone(completedRoomOrder.sendClaimId) &&
        Option.contains(completedRoomOrder.sentMessageId, sentMessage.id) &&
        Option.contains(completedRoomOrder.sentMessageChannelId, sentMessage.channel_id)
      ) {
        return Option.none<RoomOrderButtonResult>();
      }

      const detail = "sent room order, but failed to track it.";
      yield* updateInteraction(detail);
      return Option.some({
        messageId: sentMessage.id,
        messageChannelId: sentMessage.channel_id,
        status: "partial",
        detail,
      } satisfies RoomOrderButtonResult);
    });

    const pinSentRoomOrder = Effect.fn("DispatchService.pinSentRoomOrder")(function* ({
      sentMessage,
      trustedGuildId,
    }: {
      readonly sentMessage: { readonly id: string; readonly channel_id: string };
      readonly trustedGuildId: string;
    }) {
      return yield* botClient.createPin(sentMessage.channel_id, sentMessage.id).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logError("Failed to pin sent room order").pipe(
            Effect.annotateLogs({
              guildId: trustedGuildId,
              channelId: sentMessage.channel_id,
              messageId: sentMessage.id,
            }),
            Effect.andThen(Effect.logError(cause)),
            Effect.as(false),
          ),
        ),
      );
    });

    const handleRoomOrderSendButton = Effect.fn("DispatchService.roomOrderSendButton")(function* (
      payload: RoomOrderSendButtonPayload,
      authorizedRoomOrder?: MessageRoomOrder,
    ) {
      yield* Effect.annotateCurrentSpan({
        guildId: payload.guildId,
        channelId: payload.messageChannelId,
        messageId: payload.messageId,
      });
      const maybeInitialRoomOrder = yield* loadInitialRoomOrder(payload, authorizedRoomOrder);
      const initialRoomOrder = yield* requireInitialRoomOrder(payload, maybeInitialRoomOrder);
      const {
        trustedGuildId,
        trustedMessageChannelId,
        mode,
        renderReply,
        updateInteraction,
        getRoomOrderBusyDetail,
        requireCurrentRoomOrderMatch,
      } = yield* loadRequiredRoomOrderContext(payload, initialRoomOrder);
      const preflightResult = yield* requireRoomOrderSendPreflight({
        initialRoomOrder,
        mode,
        payload,
        trustedMessageChannelId,
        updateInteraction,
      });
      if (Option.isSome(preflightResult)) {
        return preflightResult.value;
      }

      yield* requireCurrentRoomOrderMatch();
      const claimId = globalThis.crypto.randomUUID();
      const claimedRoomOrder = yield* messageRoomOrderService.claimMessageRoomOrderSend(
        payload.messageId,
        claimId,
      );
      yield* requireClaimedRoomOrderMatch(
        payload,
        claimedRoomOrder,
        messageRoomOrderService.releaseMessageRoomOrderSendClaim(payload.messageId, claimId),
      );
      const claimResult = yield* requireRoomOrderSendClaim({
        claimId,
        claimedRoomOrder,
        getRoomOrderBusyDetail,
        payload,
        trustedMessageChannelId,
        updateInteraction,
      });
      if (Option.isSome(claimResult)) {
        return claimResult.value;
      }

      const sentMessage = yield* sendRoomOrderMessage({
        claimId,
        claimedRoomOrder,
        payload,
        renderReply,
        trustedMessageChannelId,
        updateInteraction,
      });
      const trackingResult = yield* completeRoomOrderSendTracking({
        claimId,
        payload,
        sentMessage,
        updateInteraction,
      });
      if (Option.isSome(trackingResult)) {
        return trackingResult.value;
      }

      const pinned = yield* pinSentRoomOrder({ sentMessage, trustedGuildId });

      const detail = pinned
        ? "sent room order and pinned it!"
        : "sent room order, but failed to pin it.";
      yield* acknowledgeRoomOrderButton(updateInteraction, detail);

      return {
        messageId: sentMessage.id,
        messageChannelId: sentMessage.channel_id,
        status: pinned ? "pinned" : "partial",
        detail,
      } satisfies RoomOrderButtonResult;
    });

    const requireTentativeFallbackPinPayload = (payload: RoomOrderPinTentativeButtonPayload) =>
      hasTentativeRoomOrderPrefix(payload.messageContent ?? "")
        ? Effect.void
        : failRoomOrderInteraction(
            payload,
            "This is not a tentative room-order message.",
            "Cannot handle tentative room-order pin button, message is not tentative",
          );

    const requireTentativePinMode = Effect.fn("DispatchService.requireTentativePinMode")(
      function* ({
        mode,
        payload,
        trustedMessageChannelId,
        updateInteraction,
      }: {
        readonly mode: RoomOrderButtonMode;
        readonly payload: RoomOrderPinTentativeButtonPayload;
        readonly trustedMessageChannelId: string;
        readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
      }) {
        if (mode === "tentative") {
          return Option.none<RoomOrderButtonResult>();
        }

        return Option.some(
          yield* denyRoomOrderButton({
            detail: "cannot pin a non-tentative room order.",
            messageChannelId: trustedMessageChannelId,
            payload,
            updateInteraction,
          }),
        );
      },
    );

    const requireTentativePinClaim = Effect.fn("DispatchService.requireTentativePinClaim")(
      function* ({
        getRoomOrderBusyDetail,
        pinClaimId,
        pinClaimedRoomOrder,
        payload,
        trustedMessageChannelId,
        updateInteraction,
      }: {
        readonly getRoomOrderBusyDetail: (roomOrder: MessageRoomOrder) => string;
        readonly pinClaimId: string;
        readonly pinClaimedRoomOrder: MessageRoomOrder;
        readonly payload: RoomOrderPinTentativeButtonPayload;
        readonly trustedMessageChannelId: string;
        readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
      }) {
        if (Option.isSome(pinClaimedRoomOrder.tentativePinnedAt)) {
          return Option.some(
            yield* denyRoomOrderButton({
              detail: "tentative room order is already pinned.",
              messageChannelId: trustedMessageChannelId,
              payload,
              updateInteraction,
            }),
          );
        }
        if (!Option.contains(pinClaimedRoomOrder.tentativePinClaimId, pinClaimId)) {
          return Option.some(
            yield* denyRoomOrderButton({
              detail: getRoomOrderBusyDetail(pinClaimedRoomOrder),
              messageChannelId: trustedMessageChannelId,
              payload,
              updateInteraction,
            }),
          );
        }

        return Option.none<RoomOrderButtonResult>();
      },
    );

    const createTentativePin = Effect.fn("DispatchService.createTentativePin")(function* ({
      payload,
      trustedGuildId,
      trustedMessageChannelId,
    }: {
      readonly payload: RoomOrderPinTentativeButtonPayload;
      readonly trustedGuildId: string;
      readonly trustedMessageChannelId: string;
    }) {
      return yield* botClient.createPin(trustedMessageChannelId, payload.messageId).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logError("Failed to pin tentative room order").pipe(
            Effect.annotateLogs({
              guildId: trustedGuildId,
              channelId: trustedMessageChannelId,
              messageId: payload.messageId,
            }),
            Effect.andThen(Effect.logError(cause)),
            Effect.as(false),
          ),
        ),
      );
    });

    const completeTentativePin = Effect.fn("DispatchService.completeTentativePin")(function* ({
      pinClaimId,
      payload,
      trustedGuildId,
      trustedMessageChannelId,
      updateInteraction,
    }: {
      readonly pinClaimId: string;
      readonly payload: RoomOrderPinTentativeButtonPayload;
      readonly trustedGuildId: string;
      readonly trustedMessageChannelId: string;
      readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
    }) {
      return yield* messageRoomOrderService
        .completeMessageRoomOrderTentativePin(payload.messageId, pinClaimId)
        .pipe(
          Effect.map(Option.some),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const detail = "pinned tentative room order, but failed to track it.";
              yield* Effect.logError("Failed to track pinned tentative room order").pipe(
                Effect.annotateLogs({
                  guildId: trustedGuildId,
                  channelId: trustedMessageChannelId,
                  messageId: payload.messageId,
                }),
                Effect.andThen(Effect.logError(cause)),
              );
              yield* updateInteraction(detail).pipe(Effect.catchCause(() => Effect.void));
              yield* messageRoomOrderService
                .releaseMessageRoomOrderTentativePinClaim(payload.messageId, pinClaimId)
                .pipe(Effect.catchCause(() => Effect.void));
              return Option.none<MessageRoomOrder>();
            }),
          ),
        );
    });

    const cleanupTentativePin = Effect.fn("DispatchService.cleanupTentativePin")(function* ({
      initialRoomOrder,
      payload,
      pinnedRoomOrder,
      renderReply,
      trustedGuildId,
      trustedMessageChannelId,
    }: {
      readonly initialRoomOrder: MessageRoomOrder;
      readonly payload: RoomOrderPinTentativeButtonPayload;
      readonly pinnedRoomOrder: MessageRoomOrder | null;
      readonly renderReply: (
        roomOrder: MessageRoomOrder,
        replyMode: "normal",
      ) => Effect.Effect<MessagePayload, unknown>;
      readonly trustedGuildId: string;
      readonly trustedMessageChannelId: string;
    }) {
      return yield* Effect.gen(function* () {
        const latestReply = yield* renderReply(pinnedRoomOrder ?? initialRoomOrder, "normal");

        return yield* botClient
          .updateMessage(trustedMessageChannelId, payload.messageId, {
            content: latestReply.content,
            components: [],
          })
          .pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logError("Failed to clean up pinned tentative room order").pipe(
                Effect.annotateLogs({
                  guildId: trustedGuildId,
                  channelId: trustedMessageChannelId,
                  messageId: payload.messageId,
                }),
                Effect.andThen(Effect.logError(cause)),
                Effect.as(false),
              ),
            ),
          );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Failed to render pinned tentative room order cleanup").pipe(
            Effect.annotateLogs({
              guildId: trustedGuildId,
              channelId: trustedMessageChannelId,
              messageId: payload.messageId,
            }),
            Effect.andThen(Effect.logError(cause)),
            Effect.as(false),
          ),
        ),
      );
    });

    const publishTentativePin = Effect.fn("DispatchService.publishTentativePin")(function* ({
      initialRoomOrder,
      pinClaimId,
      payload,
      renderReply,
      trustedGuildId,
      trustedMessageChannelId,
      updateInteraction,
    }: {
      readonly initialRoomOrder: MessageRoomOrder;
      readonly pinClaimId: string;
      readonly payload: RoomOrderPinTentativeButtonPayload;
      readonly renderReply: (
        roomOrder: MessageRoomOrder,
        replyMode: "normal",
      ) => Effect.Effect<MessagePayload, unknown>;
      readonly trustedGuildId: string;
      readonly trustedMessageChannelId: string;
      readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
    }) {
      const pinned = yield* createTentativePin({
        payload,
        trustedGuildId,
        trustedMessageChannelId,
      });
      if (!pinned) {
        yield* messageRoomOrderService
          .releaseMessageRoomOrderTentativePinClaim(payload.messageId, pinClaimId)
          .pipe(Effect.catchCause(() => Effect.void));
        const detail = "tentative room order could not be pinned.";
        yield* updateInteraction(detail);
        return roomOrderButtonResult(payload, trustedMessageChannelId, "failed", detail);
      }

      const maybePinnedRoomOrder = yield* completeTentativePin({
        pinClaimId,
        payload,
        trustedGuildId,
        trustedMessageChannelId,
        updateInteraction,
      });
      if (Option.isNone(maybePinnedRoomOrder)) {
        return roomOrderButtonResult(
          payload,
          trustedMessageChannelId,
          "partial",
          "pinned tentative room order, but failed to track it.",
        );
      }

      const pinnedRoomOrder = maybePinnedRoomOrder.value;
      if (Option.isNone(pinnedRoomOrder.tentativePinnedAt)) {
        const detail = "pinned tentative room order, but failed to track it.";
        yield* updateInteraction(detail);
        return roomOrderButtonResult(payload, trustedMessageChannelId, "partial", detail);
      }

      const cleanedUp = yield* cleanupTentativePin({
        initialRoomOrder,
        payload,
        pinnedRoomOrder,
        renderReply,
        trustedGuildId,
        trustedMessageChannelId,
      });
      const detail = cleanedUp
        ? "pinned tentative room order!"
        : "pinned tentative room order, but failed to clean up the message.";
      yield* acknowledgeRoomOrderButton(updateInteraction, detail);
      return roomOrderButtonResult(
        payload,
        trustedMessageChannelId,
        cleanedUp ? "pinned" : "partial",
        detail,
      );
    });

    const handleRoomOrderPinTentativeButton = Effect.fn(
      "DispatchService.roomOrderPinTentativeButton",
    )(function* (
      payload: RoomOrderPinTentativeButtonPayload,
      authorizedRoomOrder?: MessageRoomOrder | null,
    ) {
      yield* Effect.annotateCurrentSpan({
        guildId: payload.guildId,
        channelId: payload.messageChannelId,
        messageId: payload.messageId,
      });
      const maybeInitialRoomOrder = yield* loadInitialRoomOrder(payload, authorizedRoomOrder);
      if (Option.isNone(maybeInitialRoomOrder)) {
        yield* requireTentativeFallbackPinPayload(payload);
        return yield* handleFallbackTentativePin(payload);
      }
      const initialRoomOrder = maybeInitialRoomOrder.value;
      const {
        trustedGuildId,
        trustedMessageChannelId,
        mode,
        renderReply,
        updateInteraction,
        getRoomOrderBusyDetail,
        requireCurrentRoomOrderMatch,
      } = yield* loadRequiredRoomOrderContext(payload, initialRoomOrder);
      const notTentative = yield* requireTentativePinMode({
        mode,
        payload,
        trustedMessageChannelId,
        updateInteraction,
      });
      if (Option.isSome(notTentative)) {
        return notTentative.value;
      }

      const pinClaimId = globalThis.crypto.randomUUID();
      yield* requireCurrentRoomOrderMatch();
      const pinClaimedRoomOrder = yield* messageRoomOrderService.claimMessageRoomOrderTentativePin(
        payload.messageId,
        pinClaimId,
      );
      yield* requireClaimedRoomOrderMatch(
        payload,
        pinClaimedRoomOrder,
        messageRoomOrderService.releaseMessageRoomOrderTentativePinClaim(
          payload.messageId,
          pinClaimId,
        ),
      );
      const unavailableClaim = yield* requireTentativePinClaim({
        getRoomOrderBusyDetail,
        pinClaimId,
        pinClaimedRoomOrder,
        payload,
        trustedMessageChannelId,
        updateInteraction,
      });
      if (Option.isSome(unavailableClaim)) {
        return unavailableClaim.value;
      }

      return yield* publishTentativePin({
        initialRoomOrder,
        pinClaimId,
        payload,
        renderReply,
        trustedGuildId,
        trustedMessageChannelId,
        updateInteraction,
      });
    });

    const makeSlotEmbeds = Effect.fn("DispatchService.makeSlotEmbeds")(function* (
      guildId: string,
      day: number,
    ) {
      const eventConfig = yield* sheetService.getEventConfig(guildId);
      const daySchedule = yield* scheduleService.dayPopulatedFillerSchedules(guildId, day);
      const sortedSchedules = daySchedule
        .flatMap((schedule) =>
          Option.match(schedule.hour, {
            onSome: (hour) => [{ schedule, hour }],
            onNone: () => [],
          }),
        )
        .sort((left, right) => left.hour - right.hour)
        .map(({ schedule }) => schedule);
      const openSlots = pipe(
        sortedSchedules.map((schedule) => formatOpenSlot(schedule, eventConfig)),
        joinDedupeAdjacent,
        (description) =>
          EffectString.Equivalence(description, EffectString.empty) ? "All Filled :3" : description,
      );
      const filledSlots = pipe(
        sortedSchedules.map((schedule) => formatFilledSlot(schedule, eventConfig)),
        joinDedupeAdjacent,
        (description) =>
          EffectString.Equivalence(description, EffectString.empty) ? "All Open :3" : description,
      );

      return [
        makeEmbed({
          title: `Day ${day} Open Slots`,
          description: openSlots,
        }),
        makeEmbed({
          title: `Day ${day} Filled Slots`,
          description: filledSlots,
        }),
      ];
    });

    return {
      checkin: Effect.fn("DispatchService.checkin")(function* (
        payload: CheckinDispatchPayload,
        requester: DispatchRequester,
      ) {
        yield* Effect.annotateCurrentSpan({
          guildId: payload.guildId,
          channelName: payload.channelName,
          hour: payload.hour,
          "requester.accountId": requester.accountId,
          "requester.userId": requester.userId,
        });
        const createdByUserId = requester.userId;
        const generated = yield* checkinService.generate(payload);
        const messageSink = makeMessageSink(
          botClient,
          generated.runningChannelId,
          payload.interactionToken,
        );
        const primaryMessage = yield* messageSink.sendPrimary(
          typeof payload.interactionToken === "string"
            ? {
                content: "Dispatching check-in...",
                flags: MessageFlags.Ephemeral,
              }
            : {
                content: generated.monitorCheckinMessage,
              },
        );

        let checkinMessage: DiscordMessage | null = null;
        let tentativeRoomOrderMessage: {
          readonly messageId: string;
          readonly messageChannelId: string;
        } | null = null;

        if (generated.initialMessage !== null) {
          checkinMessage = yield* botClient.sendMessage(generated.checkinChannelId, {
            content: generated.initialMessage,
          });

          yield* messageCheckinService.persistMessageCheckin(checkinMessage.id, {
            data: {
              initialMessage: generated.initialMessage,
              hour: generated.hour,
              channelId: generated.runningChannelId,
              roleId: generated.roleId,
              guildId: payload.guildId,
              messageChannelId: generated.checkinChannelId,
              createdByUserId,
            },
            memberIds: generated.fillIds,
          });

          yield* botClient
            .updateMessage(checkinMessage.channel_id, checkinMessage.id, {
              components: [checkinActionRow()],
            })
            .pipe(
              Effect.catch(
                logEnableFailure(
                  "Failed to enable check-in message after persistence; leaving message without components",
                ),
              ),
            );

          tentativeRoomOrderMessage = yield* sendTentativeRoomOrder({
            guildId: payload.guildId,
            runningChannelId: generated.runningChannelId,
            hour: generated.hour,
            fillCount: generated.fillCount,
            createdByUserId,
            botClient,
            roomOrderService,
            messageRoomOrderService,
          });
        }

        const finalPrimaryMessage =
          typeof payload.interactionToken === "string"
            ? checkinMessage === null
              ? yield* messageSink.updatePrimary(primaryMessage, {
                  content: generated.monitorCheckinMessage,
                  flags: MessageFlags.Ephemeral,
                })
              : yield* messageSink
                  .updatePrimary(primaryMessage, {
                    content: generated.monitorCheckinMessage,
                    flags: MessageFlags.Ephemeral,
                  })
                  .pipe(
                    Effect.catch((error) =>
                      logEnableFailure(
                        "Failed to update check-in primary response after persistence; leaving progress message",
                      )(error).pipe(Effect.as(primaryMessage)),
                    ),
                  )
            : primaryMessage;

        return {
          hour: generated.hour,
          runningChannelId: generated.runningChannelId,
          checkinChannelId: generated.checkinChannelId,
          checkinMessageId: checkinMessage?.id ?? null,
          checkinMessageChannelId: checkinMessage?.channel_id ?? null,
          primaryMessageId: finalPrimaryMessage.id,
          primaryMessageChannelId: finalPrimaryMessage.channel_id,
          tentativeRoomOrderMessageId: tentativeRoomOrderMessage?.messageId ?? null,
          tentativeRoomOrderMessageChannelId: tentativeRoomOrderMessage?.messageChannelId ?? null,
        } satisfies CheckinDispatchResult;
      }),
      roomOrder: Effect.fn("DispatchService.roomOrder")(function* (
        payload: RoomOrderDispatchPayload,
        requester: DispatchRequester,
      ) {
        yield* Effect.annotateCurrentSpan({
          guildId: payload.guildId,
          channelId: payload.channelId,
          hour: payload.hour,
          "requester.accountId": requester.accountId,
          "requester.userId": requester.userId,
        });
        const createdByUserId = requester.userId;
        const generated = yield* roomOrderService.generate(payload);
        const messageSink = makeMessageSink(
          botClient,
          generated.runningChannelId,
          payload.interactionToken,
        );
        const message = yield* messageSink.sendPrimary({
          content: generated.content,
          components: [roomOrderActionRow(generated.range, generated.rank, true)],
        });

        yield* messageRoomOrderService.persistMessageRoomOrder(message.id, {
          data: {
            previousFills: generated.previousFills,
            fills: generated.fills,
            hour: generated.hour,
            rank: generated.rank,
            tentative: false,
            monitor: generated.monitor,
            guildId: payload.guildId,
            messageChannelId: message.channel_id,
            createdByUserId,
          },
          entries: generated.entries,
        });

        const enabledMessage = yield* messageSink
          .updatePrimary(message, {
            components: [roomOrderActionRow(generated.range, generated.rank)],
          })
          .pipe(
            Effect.catch((error) =>
              logEnableFailure(
                "Failed to enable room-order message after persistence; leaving disabled components",
              )(error).pipe(Effect.as(message)),
            ),
          );

        return {
          messageId: enabledMessage.id,
          messageChannelId: enabledMessage.channel_id,
          hour: generated.hour,
          runningChannelId: generated.runningChannelId,
          rank: generated.rank,
        } satisfies RoomOrderDispatchResult;
      }),
      kickout: Effect.fn("DispatchService.kickout")(function* (
        payload: KickoutDispatchPayload,
        requester: DispatchRequester,
      ) {
        yield* Effect.annotateCurrentSpan({
          guildId: payload.guildId,
          channelId: payload.channelId,
          channelName: payload.channelName,
          hour: payload.hour,
          "requester.accountId": requester.accountId,
          "requester.userId": requester.userId,
        });
        const updateInteraction = (content: string) =>
          typeof payload.interactionToken === "string"
            ? botClient.updateOriginalInteractionResponse(payload.interactionToken, {
                content,
                allowed_mentions: { parse: [] },
              })
            : Effect.void;
        const date = yield* DateTime.now;
        const minute = DateTime.getPart(date, "minute");

        if (minute >= 40) {
          yield* updateInteraction("Cannot kick out until next hour starts");
          return {
            guildId: payload.guildId,
            runningChannelId: payload.channelId ?? "",
            hour: payload.hour ?? 0,
            roleId: null,
            removedMemberIds: [],
            status: "tooEarly",
          } satisfies KickoutDispatchResult;
        }

        const hour =
          payload.hour ??
          pipe(
            DateTime.distance(
              (yield* sheetService.getEventConfig(payload.guildId)).startTime,
              pipe(DateTime.addDuration(date, "20 minutes"), DateTime.startOf("hour")),
            ),
            Duration.toHours,
            Math.floor,
            (value) => value + 1,
          );
        const maybeRunningChannel =
          typeof payload.channelName === "string"
            ? yield* guildConfigService.getGuildChannelByName({
                guildId: payload.guildId,
                channelName: payload.channelName,
                running: true,
              })
            : yield* guildConfigService.getGuildChannelById({
                guildId: payload.guildId,
                channelId: payload.channelId ?? "",
                running: true,
              });
        const runningChannel = yield* Option.match(maybeRunningChannel, {
          onSome: Effect.succeed,
          onNone: () =>
            updateInteraction("Cannot kick out, running channel not found").pipe(
              Effect.andThen(
                Effect.fail(
                  markInteractionFailureHandled(
                    makeArgumentError("Cannot kick out, running channel not found"),
                  ),
                ),
              ),
            ),
        });
        const channelName = yield* Option.match(runningChannel.name, {
          onSome: Effect.succeed,
          onNone: () =>
            updateInteraction("Cannot kick out, channel has no name").pipe(
              Effect.andThen(
                Effect.fail(
                  markInteractionFailureHandled(
                    makeArgumentError("Cannot kick out, channel has no name"),
                  ),
                ),
              ),
            ),
        });
        const runningChannelId = runningChannel.channelId;
        const roleId = Option.getOrNull(runningChannel.roleId);

        if (roleId === null) {
          yield* updateInteraction("No role configured for this channel");
          return {
            guildId: payload.guildId,
            runningChannelId,
            hour,
            roleId: null,
            removedMemberIds: [],
            status: "missingRole",
          } satisfies KickoutDispatchResult;
        }

        const scheduleItem = (yield* scheduleService.channelPopulatedMonitorSchedules(
          payload.guildId,
          channelName,
        )).find((schedule) => Option.contains(schedule.hour, hour));
        if (scheduleItem === undefined) {
          yield* Effect.logWarning("Skipping kickout because no schedule was found").pipe(
            Effect.annotateLogs({
              guildId: payload.guildId,
              runningChannelId,
              channelName,
              hour,
            }),
          );
          yield* updateInteraction(
            "No schedule found for this channel and hour; no players kicked out",
          );
          return {
            guildId: payload.guildId,
            runningChannelId,
            hour,
            roleId,
            removedMemberIds: [],
            status: "empty",
          } satisfies KickoutDispatchResult;
        }

        const fillIds: ReadonlyArray<string> = Match.value(scheduleItem).pipe(
          Match.tagsExhaustive({
            PopulatedBreakSchedule: () => [],
            PopulatedSchedule: (schedule) =>
              schedule.fills.filter(Option.isSome).flatMap((player) =>
                Match.value(player.value.player).pipe(
                  Match.tagsExhaustive({
                    Player: (player) => [player.id],
                    PartialNamePlayer: () => [],
                  }),
                ),
              ),
          }),
        );
        const members = yield* botClient.getMembersForParent(payload.guildId);
        const removedMemberIds = members
          .filter((member) => member.value.roles.includes(roleId))
          .map((member) => member.value.user.id)
          .filter((memberId) => !fillIds.includes(memberId));

        const removalResults = yield* Effect.forEach(removedMemberIds, (memberId) =>
          botClient.removeGuildMemberRole(payload.guildId, memberId, roleId).pipe(
            Effect.as({ memberId, removed: true as const }),
            Effect.catchCause((cause) =>
              Effect.logError("Failed to remove kickout role from member").pipe(
                Effect.annotateLogs({
                  guildId: payload.guildId,
                  runningChannelId,
                  memberId,
                  roleId,
                }),
                Effect.andThen(Effect.logError(cause)),
                Effect.as({ memberId, removed: false as const }),
              ),
            ),
          ),
        );
        const actualRemovedIds = removalResults
          .filter((result) => result.removed)
          .map((result) => result.memberId);

        yield* updateInteraction(
          actualRemovedIds.length > 0
            ? `Kicked out ${actualRemovedIds.map(mentionUser).join(" ")}`
            : "No players to kick out",
        );

        return {
          guildId: payload.guildId,
          runningChannelId,
          hour,
          roleId,
          removedMemberIds: actualRemovedIds,
          status: actualRemovedIds.length > 0 ? "removed" : "empty",
        } satisfies KickoutDispatchResult;
      }),
      slotButton: Effect.fn("DispatchService.slotButton")(function* (
        payload: SlotButtonDispatchPayload,
        requester: DispatchRequester,
      ) {
        yield* Effect.annotateCurrentSpan({
          guildId: payload.guildId,
          channelId: payload.channelId,
          day: payload.day,
          "requester.accountId": requester.accountId,
          "requester.userId": requester.userId,
        });
        const message = yield* botClient.sendMessage(payload.channelId, {
          content: `Press the button below to get the current open slots for day ${payload.day}`,
          components: [slotActionRow()],
        });

        yield* messageSlotService
          .upsertMessageSlotData(message.id, {
            day: payload.day,
            guildId: payload.guildId,
            messageChannelId: payload.channelId,
            createdByUserId: requester.userId,
          })
          .pipe(
            Effect.catchCause((cause) =>
              botClient.deleteMessage(payload.channelId, message.id).pipe(
                Effect.catchCause(() => Effect.void),
                Effect.andThen(Effect.failCause(cause)),
              ),
            ),
          );

        yield* botClient
          .updateOriginalInteractionResponse(payload.interactionToken, {
            content: "Slot button sent!",
            flags: MessageFlags.Ephemeral,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Failed to update slot button interaction response").pipe(
                Effect.annotateLogs({
                  guildId: payload.guildId,
                  channelId: payload.channelId,
                  messageId: message.id,
                }),
                Effect.andThen(Effect.logError(cause)),
              ),
            ),
          );

        return {
          messageId: message.id,
          messageChannelId: message.channel_id,
          day: payload.day,
        } satisfies SlotButtonDispatchResult;
      }),
      slotList: Effect.fn("DispatchService.slotList")(function* (payload: SlotListDispatchPayload) {
        yield* Effect.annotateCurrentSpan({
          guildId: payload.guildId,
          day: payload.day,
          messageType: payload.messageType,
        });
        const slotEmbeds = yield* makeSlotEmbeds(payload.guildId, payload.day);

        yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
          embeds: [...slotEmbeds, makeWebScheduleEmbed()],
        });

        return {
          guildId: payload.guildId,
          day: payload.day,
          messageType: payload.messageType,
        } satisfies SlotListDispatchResult;
      }),
      channelListConfig: Effect.fn("DispatchService.channelListConfig")(function* (
        payload: ChannelListConfigDispatchPayload,
      ) {
        const maybeConfig = yield* guildConfigService.getGuildChannelById({
          guildId: payload.guildId,
          channelId: payload.channelId,
        });
        const config = yield* Option.match(maybeConfig, {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(
              makeArgumentError(
                `Cannot list channel config, channel ${payload.channelId} is not configured`,
              ),
            ),
        });

        yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
          embeds: [
            makeEmbed({
              title: "Config for this channel",
              fields: formatChannelConfigFields(config),
            }),
          ],
        });

        return {
          guildId: payload.guildId,
          channelId: payload.channelId,
        } satisfies ChannelListConfigDispatchResult;
      }),
      channelSet: Effect.fn("DispatchService.channelSet")(function* (
        payload: ChannelSetDispatchPayload,
      ) {
        const config = yield* guildConfigService.upsertGuildChannelConfig(
          payload.guildId,
          payload.channelId,
          {
            ...(payload.running === undefined ? {} : { running: payload.running }),
            ...(payload.name === undefined ? {} : { name: payload.name }),
            ...(payload.roleId === undefined ? {} : { roleId: payload.roleId }),
            ...(payload.checkinChannelId === undefined
              ? {}
              : { checkinChannelId: payload.checkinChannelId }),
          },
        );

        yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
          embeds: [
            makeEmbed({
              title: "Success!",
              description: `${mentionChannel(payload.channelId)} configuration updated`,
              fields: formatChannelConfigFields(config),
            }),
          ],
        });

        return {
          guildId: payload.guildId,
          channelId: payload.channelId,
        } satisfies ChannelSetDispatchResult;
      }),
      channelUnset: Effect.fn("DispatchService.channelUnset")(function* (
        payload: ChannelUnsetDispatchPayload,
      ) {
        const config = yield* guildConfigService.upsertGuildChannelConfig(
          payload.guildId,
          payload.channelId,
          {
            ...(payload.running ? { running: null } : {}),
            ...(payload.name ? { name: null } : {}),
            ...(payload.role ? { roleId: null } : {}),
            ...(payload.checkinChannel ? { checkinChannelId: null } : {}),
          },
        );

        yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
          embeds: [
            makeEmbed({
              title: "Success!",
              description: `${mentionChannel(payload.channelId)} configuration updated`,
              fields: formatChannelConfigFields(config),
            }),
          ],
        });

        return {
          guildId: payload.guildId,
          channelId: payload.channelId,
        } satisfies ChannelUnsetDispatchResult;
      }),
      serverListConfig: Effect.fn("DispatchService.serverListConfig")(function* (
        payload: ServerListConfigDispatchPayload,
      ) {
        const maybeGuildConfig = yield* guildConfigService.getGuildConfig(payload.guildId);
        const guildConfig = yield* Option.match(maybeGuildConfig, {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(makeArgumentError(`Cannot list config for guild ${payload.guildId}`)),
        });
        const monitorRoles = yield* guildConfigService.getGuildMonitorRoles(payload.guildId);
        const sheetId = Option.match(guildConfig.sheetId, {
          onSome: escapeMarkdown,
          onNone: () => "None",
        });

        yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
          embeds: [
            makeEmbed({
              title: `Config for ${escapeMarkdown(payload.guildId)}`,
              description: [
                `Sheet id: ${sheetId}`,
                `Auto check-in: ${
                  isAutoCheckinEnabled(guildConfig.autoCheckin) ? "Enabled" : "Disabled"
                }`,
                `Monitor roles: ${
                  monitorRoles.length > 0
                    ? monitorRoles.map((role) => mentionRole(role.roleId)).join(", ")
                    : "None"
                }`,
              ].join("\n"),
            }),
          ],
        });

        return {
          guildId: payload.guildId,
          monitorRoleCount: monitorRoles.length,
        } satisfies ServerListConfigDispatchResult;
      }),
      serverAddMonitorRole: Effect.fn("DispatchService.serverAddMonitorRole")(function* (
        payload: ServerAddMonitorRoleDispatchPayload,
      ) {
        yield* guildConfigService.addGuildMonitorRole(payload.guildId, payload.roleId);
        yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
          embeds: [
            makeEmbed({
              title: "Success!",
              description: `${mentionRole(payload.roleId)} is now a monitor role for ${escapeMarkdown(
                payload.guildId,
              )}`,
            }),
          ],
        });
        return {
          guildId: payload.guildId,
          roleId: payload.roleId,
        } satisfies ServerAddMonitorRoleDispatchResult;
      }),
      serverRemoveMonitorRole: Effect.fn("DispatchService.serverRemoveMonitorRole")(function* (
        payload: ServerRemoveMonitorRoleDispatchPayload,
      ) {
        yield* guildConfigService.removeGuildMonitorRole(payload.guildId, payload.roleId);
        yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
          embeds: [
            makeEmbed({
              title: "Success!",
              description: `${mentionRole(payload.roleId)} is no longer a monitor role for ${escapeMarkdown(
                payload.guildId,
              )}`,
            }),
          ],
        });
        return {
          guildId: payload.guildId,
          roleId: payload.roleId,
        } satisfies ServerRemoveMonitorRoleDispatchResult;
      }),
      serverSetSheet: Effect.fn("DispatchService.serverSetSheet")(function* (
        payload: ServerSetSheetDispatchPayload,
      ) {
        yield* guildConfigService.upsertGuildConfig(payload.guildId, { sheetId: payload.sheetId });
        yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
          embeds: [
            makeEmbed({
              title: "Success!",
              description: `Sheet id for ${escapeMarkdown(payload.guildId)} is now set to ${escapeMarkdown(
                payload.sheetId,
              )}`,
            }),
          ],
        });
        return {
          guildId: payload.guildId,
          sheetId: payload.sheetId,
        } satisfies ServerSetSheetDispatchResult;
      }),
      serverSetAutoCheckin: Effect.fn("DispatchService.serverSetAutoCheckin")(function* (
        payload: ServerSetAutoCheckinDispatchPayload,
      ) {
        const guildConfig = yield* guildConfigService.upsertGuildConfig(payload.guildId, {
          autoCheckin: payload.autoCheckin,
        });
        const autoCheckin = isAutoCheckinEnabled(guildConfig.autoCheckin);
        yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
          embeds: [
            makeEmbed({
              title: "Success!",
              description: `Auto check-in for ${escapeMarkdown(payload.guildId)} is now ${
                autoCheckin ? "enabled" : "disabled"
              }.`,
            }),
          ],
        });
        return {
          guildId: payload.guildId,
          autoCheckin,
        } satisfies ServerSetAutoCheckinDispatchResult;
      }),
      teamList: Effect.fn("DispatchService.teamList")(function* (payload: TeamListDispatchPayload) {
        const teams = yield* playerService.getTeamsByIds(payload.guildId, [payload.targetUserId]);
        const formattedTeams = teams
          .flat()
          // Exclude "tierer_hint" entries: these are internal/temporary suggestions used by the
          // tiering process and should not be shown to users in the public team list.
          .filter((team) => !team.tags.includes("tierer_hint"))
          .sort((left, right) => {
            const leftName = Option.getOrElse(left.playerName, () => "");
            const rightName = Option.getOrElse(right.playerName, () => "");
            return (
              leftName.localeCompare(rightName) ||
              Sheet.Team.getEffectValue(right) - Sheet.Team.getEffectValue(left)
            );
          })
          .flatMap((team) =>
            Option.match(team.teamName, {
              onNone: () => [],
              onSome: (teamName) => [
                {
                  teamName,
                  tags: team.tags,
                  lead: `${team.lead}`,
                  backline: `${team.backline}`,
                  talent: Option.match(team.talent, {
                    onSome: (talent) => `${talent}k`,
                    onNone: () => undefined,
                  }),
                  effectValue: `(+${Sheet.Team.getEffectValue(team)}%)`,
                },
              ],
            }),
          );

        yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
          embeds: [
            makeEmbed({
              title: `${escapeMarkdown(payload.targetUsername)}'s Teams`,
              description: formattedTeams.length === 0 ? "No teams found" : null,
              fields: formattedTeams.map((team) => ({
                name: escapeMarkdown(team.teamName),
                value: [
                  `Tags: ${team.tags.length === 0 ? "None" : escapeMarkdown(team.tags.join(", "))}`,
                  `ISV: ${[team.lead, team.backline, team.talent].filter(Boolean).join("/")} ${
                    team.effectValue
                  }`,
                ].join("\n"),
              })),
            }),
          ],
        });

        return {
          guildId: payload.guildId,
          targetUserId: payload.targetUserId,
          teamCount: formattedTeams.length,
        } satisfies TeamListDispatchResult;
      }),
      scheduleList: Effect.fn("DispatchService.scheduleList")(function* (
        payload: ScheduleListDispatchPayload,
      ) {
        const { schedule } = yield* scheduleService.dayPlayerSchedule(
          payload.guildId,
          payload.day,
          payload.targetUserId,
        );
        yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
          embeds: [
            makeEmbed({
              title: `${escapeMarkdown(payload.targetUsername)}'s Schedule for Day ${payload.day}`,
              description: schedule.invisible
                ? "It is kinda foggy around here... This schedule is not visible to you yet."
                : null,
              fields: schedule.invisible
                ? []
                : [
                    { name: "Fill", value: formatHourRanges(schedule.fillHours) },
                    { name: "Overfill", value: formatHourRanges(schedule.overfillHours) },
                    { name: "Standby", value: formatHourRanges(schedule.standbyHours) },
                  ],
            }),
            makeWebScheduleEmbed(),
          ],
        });

        return {
          guildId: payload.guildId,
          day: payload.day,
          targetUserId: payload.targetUserId,
          invisible: schedule.invisible,
        } satisfies ScheduleListDispatchResult;
      }),
      screenshot: Effect.fn("DispatchService.screenshot")(function* (
        payload: ScreenshotDispatchPayload,
      ) {
        const screenshot = yield* screenshotService.getScreenshot(
          payload.guildId,
          payload.channelName,
          payload.day,
        );
        yield* botClient.updateOriginalInteractionResponseWithFiles(
          payload.interactionToken,
          {
            attachments: [
              {
                id: "0",
                description: `Day ${payload.day}'s schedule screenshot`,
                filename: "screenshot.png",
              },
            ],
          },
          [
            {
              name: "screenshot.png",
              contentType: "image/png",
              content: screenshot,
            },
          ],
        );

        return {
          guildId: payload.guildId,
          channelName: payload.channelName,
          day: payload.day,
          byteLength: screenshot.byteLength,
        } satisfies ScreenshotDispatchResult;
      }),
      serviceStatus: Effect.fn("DispatchService.serviceStatus")(function* (
        payload: ServiceStatusDispatchPayload,
      ) {
        yield* Effect.annotateCurrentSpan({ operation: "serviceStatus" });
        return yield* Effect.gen(function* () {
          const status = yield* statusService.getServicesStatus();
          const okCount = status.services.filter((service) => service.status === "ok").length;
          const downCount = status.services.length - okCount;

          yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
            embeds: [
              makeEmbed({
                title: "Service Status",
                description:
                  status.overallStatus === "ok"
                    ? "All services are ready."
                    : "Some services are not ready.",
                color: status.overallStatus === "ok" ? 0x57f287 : 0xfee75c,
                fields: status.services.map((service) => ({
                  name: service.name,
                  value: formatServiceStatusFieldValue(service),
                  inline: true,
                })),
                footer: {
                  text: `Checked at ${DateTime.formatIso(status.checkedAt)}`,
                },
              }),
            ],
          });

          return {
            overallStatus: status.overallStatus,
            okCount,
            downCount,
          } satisfies ServiceStatusDispatchResult;
        }).pipe(
          Effect.catch((error) =>
            botClient
              .updateOriginalInteractionResponse(payload.interactionToken, {
                content: "Failed to check service status. Please try again.",
              })
              .pipe(
                Effect.catch(() => Effect.void),
                Effect.andThen(Effect.fail(markInteractionFailureHandled(error))),
              ),
          ),
        );
      }),
      guildWelcome: Effect.fn("DispatchService.guildWelcome")(function* (
        payload: GuildWelcomeDispatchPayload,
      ) {
        yield* Effect.annotateCurrentSpan({
          guildId: payload.guildId,
          guildName: payload.guildName,
          systemChannelId: payload.systemChannelId,
        });

        const messagePayload = {
          embeds: [welcomeEmbed()],
        } satisfies MessagePayload;

        const sentMessage = yield* sendGuildAnnouncementWithWelcomeHeuristic({
          botClient,
          guildId: payload.guildId,
          systemChannelId: payload.systemChannelId,
          messagePayload,
          logLabel: "guild welcome message",
        });

        return {
          guildId: payload.guildId,
          channelId: sentMessage.channel_id,
          messageId: sentMessage.id,
        } satisfies GuildWelcomeDispatchResult;
      }),
      updateAnnouncement: Effect.fn("DispatchService.updateAnnouncement")(function* (
        payload: UpdateAnnouncementDispatchPayload,
      ) {
        yield* Effect.annotateCurrentSpan({
          guildId: payload.guildId,
          guildName: payload.guildName,
          announcementId: payload.announcement.id,
          systemChannelId: payload.systemChannelId,
        });

        const featureFlags = yield* guildConfigService.getGuildFeatureFlags(payload.guildId);
        if (!featureFlags.some((flag) => flag.flagName === updateAnnouncementsFeatureFlag)) {
          return {
            guildId: payload.guildId,
            announcementId: payload.announcement.id,
            status: "skipped_not_gated",
            announcementChannelId: null,
            announcementMessageId: null,
          } satisfies UpdateAnnouncementDispatchResult;
        }

        if (Number.isNaN(Date.parse(payload.announcement.publishedAt))) {
          return yield* Effect.fail(
            makeArgumentError(
              `Invalid update announcement publishedAt timestamp: ${payload.announcement.publishedAt}`,
            ),
          );
        }

        const publishedAt = DateTime.makeUnsafe(payload.announcement.publishedAt);
        const random = yield* Random.next;
        const claimToken = `${payload.dispatchRequestId}:${random}`;
        const claim = yield* guildConfigService.claimGuildUpdateAnnouncementDelivery({
          guildId: payload.guildId,
          announcementId: payload.announcement.id,
          publishedAt,
          claimToken,
        });
        if (claim.status === "already_delivered" && Option.isSome(claim.delivery)) {
          return {
            guildId: payload.guildId,
            announcementId: payload.announcement.id,
            status: "skipped_already_delivered",
            announcementChannelId: claim.delivery.value.channelId,
            announcementMessageId: claim.delivery.value.messageId,
          } satisfies UpdateAnnouncementDispatchResult;
        }

        if (claim.status !== "claimed") {
          return {
            guildId: payload.guildId,
            announcementId: payload.announcement.id,
            status: "skipped_already_delivered",
            announcementChannelId: null,
            announcementMessageId: null,
          } satisfies UpdateAnnouncementDispatchResult;
        }

        const deliveredAt = yield* DateTime.now;
        const messagePayload = {
          embeds: [
            makeEmbed({
              title: payload.announcement.title,
              description: payload.announcement.description,
              ...(typeof payload.announcement.color === "number"
                ? { color: payload.announcement.color }
                : {}),
            }),
          ],
        } satisfies MessagePayload;

        const sentMessage = yield* sendGuildAnnouncementWithWelcomeHeuristic({
          botClient,
          guildId: payload.guildId,
          systemChannelId: payload.systemChannelId,
          messagePayload,
          logLabel: "update announcement",
        }).pipe(
          Effect.catchCause((cause) =>
            guildConfigService
              .releaseGuildUpdateAnnouncementDeliveryClaim({
                guildId: payload.guildId,
                announcementId: payload.announcement.id,
                claimToken,
              })
              .pipe(
                Effect.catchCause(() => Effect.void),
                Effect.andThen(Effect.failCause(cause)),
              ),
          ),
        );

        yield* guildConfigService.recordGuildUpdateAnnouncementDelivery({
          guildId: payload.guildId,
          announcementId: payload.announcement.id,
          publishedAt,
          deliveredAt,
          channelId: sentMessage.channel_id,
          messageId: sentMessage.id,
        });

        return {
          guildId: payload.guildId,
          announcementId: payload.announcement.id,
          status: "sent",
          announcementChannelId: sentMessage.channel_id,
          announcementMessageId: sentMessage.id,
        } satisfies UpdateAnnouncementDispatchResult;
      }),
      serviceAddGuildFeatureFlag: Effect.fn("DispatchService.serviceAddGuildFeatureFlag")(
        function* (payload: ServiceGuildFeatureFlagDispatchPayload) {
          yield* Effect.annotateCurrentSpan({
            guildId: payload.guildId,
            flagName: payload.flagName,
            systemChannelId: payload.systemChannelId,
          });

          const flag = yield* guildConfigService.addGuildFeatureFlag(
            payload.guildId,
            payload.flagName,
          );
          const messagePayload = {
            embeds: [
              makeEmbed({
                title: "Feature flag enabled",
                description: `This server has been enlisted for \`${escapeMarkdown(flag.flagName)}\`.`,
                color: 0x57f287,
              }),
            ],
          } satisfies MessagePayload;
          const sentMessage = yield* sendGuildAnnouncementWithWelcomeHeuristic({
            botClient,
            guildId: payload.guildId,
            systemChannelId: payload.systemChannelId,
            messagePayload,
            logLabel: "guild feature flag enlistment announcement",
          }).pipe(
            Effect.map(Option.some),
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to announce guild feature flag enlistment").pipe(
                Effect.annotateLogs({
                  guildId: payload.guildId,
                  flagName: flag.flagName,
                }),
                Effect.andThen(Effect.logDebug(cause)),
                Effect.as(Option.none<DiscordMessage>()),
              ),
            ),
          );

          return {
            guildId: payload.guildId,
            flagName: flag.flagName,
            announcementChannelId: Option.match(sentMessage, {
              onSome: (message) => message.channel_id,
              onNone: () => null,
            }),
            announcementMessageId: Option.match(sentMessage, {
              onSome: (message) => message.id,
              onNone: () => null,
            }),
          } satisfies ServiceGuildFeatureFlagDispatchResult;
        },
      ),
      serviceRemoveGuildFeatureFlag: Effect.fn("DispatchService.serviceRemoveGuildFeatureFlag")(
        function* (payload: ServiceGuildFeatureFlagDispatchPayload) {
          yield* Effect.annotateCurrentSpan({
            guildId: payload.guildId,
            flagName: payload.flagName,
            systemChannelId: payload.systemChannelId,
          });

          const flag = yield* guildConfigService.removeGuildFeatureFlag(
            payload.guildId,
            payload.flagName,
          );
          const messagePayload = {
            embeds: [
              makeEmbed({
                title: "Feature flag disabled",
                description: `This server has been delisted from \`${escapeMarkdown(flag.flagName)}\`.`,
                color: 0xed4245,
              }),
            ],
          } satisfies MessagePayload;
          const sentMessage = yield* sendGuildAnnouncementWithWelcomeHeuristic({
            botClient,
            guildId: payload.guildId,
            systemChannelId: payload.systemChannelId,
            messagePayload,
            logLabel: "guild feature flag delistment announcement",
          }).pipe(
            Effect.map(Option.some),
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to announce guild feature flag delistment").pipe(
                Effect.annotateLogs({
                  guildId: payload.guildId,
                  flagName: flag.flagName,
                }),
                Effect.andThen(Effect.logDebug(cause)),
                Effect.as(Option.none<DiscordMessage>()),
              ),
            ),
          );

          return {
            guildId: payload.guildId,
            flagName: flag.flagName,
            announcementChannelId: Option.match(sentMessage, {
              onSome: (message) => message.channel_id,
              onNone: () => null,
            }),
            announcementMessageId: Option.match(sentMessage, {
              onSome: (message) => message.id,
              onNone: () => null,
            }),
          } satisfies ServiceGuildFeatureFlagDispatchResult;
        },
      ),
      slotOpenButton: Effect.fn("DispatchService.slotOpenButton")(function* (
        payload: SlotOpenButtonPayload,
        messageSlot: MessageSlot,
      ) {
        yield* Effect.annotateCurrentSpan({
          messageId: payload.messageId,
          day: messageSlot.day,
        });
        const guildId = Option.getOrUndefined(messageSlot.guildId);
        const messageChannelId = Option.getOrUndefined(messageSlot.messageChannelId);
        if (guildId === undefined) {
          yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
            content: "This slot message is not registered to a server.",
          });
          return yield* Effect.fail(
            markInteractionFailureHandled(
              makeArgumentError("Cannot handle slot button, message guild is not registered"),
            ),
          );
        }

        if (messageChannelId === undefined) {
          yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
            content: "This slot message channel is not registered.",
          });
          return yield* Effect.fail(
            markInteractionFailureHandled(
              makeArgumentError("Cannot handle slot button, message channel is not registered"),
            ),
          );
        }

        const slotEmbeds = yield* makeSlotEmbeds(guildId, messageSlot.day);

        yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
          embeds: slotEmbeds,
        });

        return {
          messageId: payload.messageId,
          guildId,
          day: messageSlot.day,
        } satisfies SlotOpenButtonResult;
      }),
      checkinButton: Effect.fn("DispatchService.checkinButton")(function* (
        payload: CheckinHandleButtonPayload,
        requester: DispatchRequester,
      ) {
        yield* Effect.annotateCurrentSpan({
          messageId: payload.messageId,
          "requester.accountId": requester.accountId,
          "requester.userId": requester.userId,
        });
        const accountId = requester.accountId;
        const checkinAt = Date.now();
        const checkinClaimId = globalThis.crypto.randomUUID();

        const maybeMessageCheckinData = yield* messageCheckinService.getMessageCheckinData(
          payload.messageId,
        );
        const failCheckinInteraction = (content: string, errorMessage: string) =>
          botClient
            .updateOriginalInteractionResponse(payload.interactionToken, {
              content,
            })
            .pipe(
              Effect.andThen(
                Effect.fail(markInteractionFailureHandled(makeArgumentError(errorMessage))),
              ),
            );
        const messageCheckinData = yield* Option.match(maybeMessageCheckinData, {
          onSome: Effect.succeed,
          onNone: () =>
            failCheckinInteraction(
              "This check-in message is not registered.",
              "Cannot handle check-in button, message is not registered",
            ),
        });
        const messageChannelId = yield* Option.match(messageCheckinData.messageChannelId, {
          onSome: Effect.succeed,
          onNone: () =>
            failCheckinInteraction(
              "This check-in message channel is not registered.",
              "Cannot handle check-in button, message channel is not registered",
            ),
        });
        const guildId = yield* Option.match(messageCheckinData.guildId, {
          onSome: Effect.succeed,
          onNone: () =>
            failCheckinInteraction(
              "This check-in message guild is not registered.",
              "Cannot handle check-in button, message guild is not registered",
            ),
        });

        const checkedInMember = yield* messageCheckinService
          .setMessageCheckinMemberCheckinAtIfUnset(
            payload.messageId,
            accountId,
            checkinAt,
            checkinClaimId,
          )
          .pipe(
            Effect.catch((error) =>
              botClient
                .updateOriginalInteractionResponse(payload.interactionToken, {
                  content: "We could not check you in. Please try again.",
                })
                .pipe(Effect.andThen(Effect.fail(markInteractionFailureHandled(error)))),
            ),
          );
        const isFirstCheckin = Option.contains(
          Option.map(checkedInMember.checkinAt, (value) => Number(DateTime.toEpochMillis(value))),
          checkinAt,
        );

        yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
          content: isFirstCheckin
            ? "You have been checked in!"
            : "You have already been checked in!",
        });

        const checkedInMembers = yield* messageCheckinService.getMessageCheckinMembers(
          payload.messageId,
        );
        const content = renderCheckedInContent(messageCheckinData.initialMessage, checkedInMembers);

        yield* botClient
          .updateMessage(messageChannelId, payload.messageId, {
            content,
            components: [checkinActionRow()],
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Failed to update check-in message after button check-in").pipe(
                Effect.annotateLogs({
                  guildId,
                  messageId: payload.messageId,
                  messageChannelId,
                  accountId,
                }),
                Effect.andThen(Effect.logError(cause)),
              ),
            ),
          );

        if (isFirstCheckin) {
          yield* botClient
            .sendMessage(messageCheckinData.channelId, {
              content: `${mentionUser(accountId)} has checked in!`,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Failed to announce button check-in").pipe(
                  Effect.annotateLogs({
                    guildId,
                    accountId,
                    channelId: messageCheckinData.channelId,
                    messageId: payload.messageId,
                  }),
                  Effect.andThen(Effect.logError(cause)),
                ),
              ),
            );
        }

        if (Option.isSome(messageCheckinData.roleId)) {
          const roleId = messageCheckinData.roleId.value;
          // Re-apply the role on repeat clicks to repair missed Discord side effects.
          yield* botClient.addGuildMemberRole(guildId, accountId, roleId).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Failed to add check-in role after button check-in").pipe(
                Effect.annotateLogs({
                  guildId,
                  accountId,
                  roleId,
                  messageId: payload.messageId,
                }),
                Effect.andThen(Effect.logError(cause)),
              ),
            ),
          );
        }

        return {
          messageId: payload.messageId,
          messageChannelId,
          checkedInMemberId: accountId,
        } satisfies CheckinHandleButtonResult;
      }),
      roomOrderPreviousButton(
        payload: RoomOrderPreviousButtonPayload,
        authorizedRoomOrder?: MessageRoomOrder,
      ) {
        return handleRoomOrderRankButton(payload, authorizedRoomOrder, "previous");
      },
      roomOrderNextButton(
        payload: RoomOrderNextButtonPayload,
        authorizedRoomOrder?: MessageRoomOrder,
      ) {
        return handleRoomOrderRankButton(payload, authorizedRoomOrder, "next");
      },
      roomOrderSendButton(
        payload: RoomOrderSendButtonPayload,
        authorizedRoomOrder?: MessageRoomOrder,
      ) {
        return handleRoomOrderSendButton(payload, authorizedRoomOrder);
      },
      roomOrderPinTentativeButton(
        payload: RoomOrderPinTentativeButtonPayload,
        authorizedRoomOrder?: MessageRoomOrder | null,
      ) {
        return handleRoomOrderPinTentativeButton(payload, authorizedRoomOrder);
      },
    };
  }),
}) {
  // fallow-ignore-next-line unused-class-member
  static layer = Layer.effect(DispatchService, this.make).pipe(
    Layer.provide(Layer.mergeAll(IngressBotClient.layer, SheetApisClient.layer)),
  );
}
