// fallow-ignore-file code-duplication
// fallow-ignore-file complexity
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
  String as EffectString,
  pipe,
} from "effect";
import type {
  ClientRef,
  SheetOutboundMessage,
  SheetTextPart,
} from "sheet-ingress-api/schemas/client";
import {
  hasTentativeRoomOrderPrefix,
  shouldSendTentativeRoomOrder,
} from "sheet-ingress-api/clientActions";
import type { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import type { MessageSlot } from "sheet-ingress-api/schemas/messageSlot";
import type {
  AutoCheckinTestConversationResult,
  AutoCheckinTestDispatchPayload,
  AutoCheckinTestDispatchResult,
  CheckinDispatchPayload,
  CheckinDispatchResult,
  CheckinHandleButtonPayload,
  CheckinHandleButtonResult,
  ConversationListConfigDispatchPayload,
  ConversationListConfigDispatchResult,
  ConversationSetDispatchPayload,
  ConversationSetDispatchResult,
  ConversationUnsetDispatchPayload,
  ConversationUnsetDispatchResult,
  WorkspaceWelcomeDispatchPayload,
  WorkspaceWelcomeDispatchResult,
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
  ServiceWorkspaceFeatureFlagDispatchPayload,
  ServiceWorkspaceFeatureFlagDispatchResult,
  ServiceStatusDispatchPayload,
  ServiceStatusDispatchResult,
  WorkspaceAddMonitorRoleDispatchPayload,
  WorkspaceAddMonitorRoleDispatchResult,
  WorkspaceListConfigDispatchPayload,
  WorkspaceListConfigDispatchResult,
  WorkspaceRemoveMonitorRoleDispatchPayload,
  WorkspaceRemoveMonitorRoleDispatchResult,
  WorkspaceSetAutoCheckinDispatchPayload,
  WorkspaceSetAutoCheckinDispatchResult,
  WorkspaceSetSheetDispatchPayload,
  WorkspaceSetSheetDispatchResult,
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
import { config } from "@/config";
import {
  checkinActionRow,
  roomOrderActionRow,
  slotActionRow,
  tentativeRoomOrderActionRow,
} from "./messageComponents";
import type { SheetMessageComponent } from "sheet-ingress-api/schemas/client";
import { ClientDeliveryClient, ClientDeliveryClientRef } from "./clientDeliveryClient";
import { buildRoomOrderContent } from "./roomOrderContent";
import { SheetApisClient } from "./sheetApisClient";
import { uniqueConversationNames } from "./autoCheckinConversations";
import * as MessageText from "./messageText";
import { sendTentativeRoomOrder, tentativeRoomOrderContent } from "./tentativeRoomOrder";

const updateAnnouncementsFeatureFlag = "update-announcements";

type DeliveredMessage = {
  readonly id: string;
  readonly conversation_id: string;
};

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
type SheetServiceApi = {
  readonly getEventConfig: ReturnType<
    typeof makeSheetApisServices
  >["sheetService"]["getEventConfig"];
};
type RoomOrderRankDirection = "previous" | "next";
type RoomOrderButtonPayload = RoomOrderPreviousButtonPayload;
type RoomOrderButtonMode = "normal" | "tentative";
type MessageEmbed = NonNullable<NonNullable<MessagePayload["embeds"]>[number]>;
type MessageTextValue = ReadonlyArray<SheetTextPart>;
type MessageTextInput = string | MessageTextValue;

type DispatchRequester = {
  readonly accountId: string;
  readonly userId: string;
};

type DispatchMessageSink = {
  readonly sendPrimary: (
    payload: MessagePayload,
  ) => Effect.Effect<DeliveredMessage, unknown, never>;
  readonly updatePrimary: (
    message: DeliveredMessage,
    payload: MessagePayload,
  ) => Effect.Effect<DeliveredMessage, unknown, never>;
};

type MessageKey = {
  readonly clientPlatform: string;
  readonly clientId: string;
  readonly messageId: string;
};

const messageKeyFor = (messageId: string): Effect.Effect<MessageKey, never, never> =>
  Effect.map(ClientDeliveryClientRef, (client) => ({
    clientPlatform: client.platform,
    clientId: client.clientId,
    messageId,
  }));

const optionalArgumentError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchIf(Predicate.isTagged("ArgumentError"), () => Effect.succeed(Option.none<A>())),
  );

const makeSheetApisServices = (sheetApisClient: typeof SheetApisClient.Service) => {
  const sheetApis = sheetApisClient.get();

  const messageRoomOrderService = {
    getMessageRoomOrder: (messageId: string) =>
      Effect.gen(function* () {
        const key = yield* messageKeyFor(messageId);
        return yield* optionalArgumentError(
          sheetApis.messageRoomOrder.getMessageRoomOrder({ query: key }),
        );
      }),
    upsertMessageRoomOrder: (
      messageId: string,
      data: Parameters<
        typeof sheetApis.messageRoomOrder.upsertMessageRoomOrder
      >[0]["payload"]["data"],
    ) =>
      Effect.gen(function* () {
        const key = yield* messageKeyFor(messageId);
        return yield* sheetApis.messageRoomOrder.upsertMessageRoomOrder({
          payload: { ...key, data },
        });
      }),
    persistMessageRoomOrder: (
      messageId: string,
      payload: Omit<
        Parameters<typeof sheetApis.messageRoomOrder.persistMessageRoomOrder>[0]["payload"],
        keyof MessageKey
      >,
    ) =>
      Effect.gen(function* () {
        const key = yield* messageKeyFor(messageId);
        return yield* sheetApis.messageRoomOrder.persistMessageRoomOrder({
          payload: { ...key, ...payload },
        });
      }),
    decrementMessageRoomOrderRank: (
      messageId: string,
      payload: Omit<
        Parameters<typeof sheetApis.messageRoomOrder.decrementMessageRoomOrderRank>[0]["payload"],
        keyof MessageKey
      >,
    ) =>
      Effect.gen(function* () {
        const key = yield* messageKeyFor(messageId);
        return yield* sheetApis.messageRoomOrder.decrementMessageRoomOrderRank({
          payload: { ...key, ...payload },
        });
      }),
    incrementMessageRoomOrderRank: (
      messageId: string,
      payload: Omit<
        Parameters<typeof sheetApis.messageRoomOrder.incrementMessageRoomOrderRank>[0]["payload"],
        keyof MessageKey
      >,
    ) =>
      Effect.gen(function* () {
        const key = yield* messageKeyFor(messageId);
        return yield* sheetApis.messageRoomOrder.incrementMessageRoomOrderRank({
          payload: { ...key, ...payload },
        });
      }),
    getMessageRoomOrderEntry: (messageId: string, rank: number) =>
      Effect.gen(function* () {
        const key = yield* messageKeyFor(messageId);
        return yield* sheetApis.messageRoomOrder.getMessageRoomOrderEntry({
          query: { ...key, rank },
        });
      }),
    getMessageRoomOrderRange: (messageId: string) =>
      Effect.gen(function* () {
        const key = yield* messageKeyFor(messageId);
        return yield* optionalArgumentError(
          sheetApis.messageRoomOrder.getMessageRoomOrderRange({ query: key }),
        );
      }),
    removeMessageRoomOrderEntry: (messageId: string) =>
      Effect.gen(function* () {
        const key = yield* messageKeyFor(messageId);
        return yield* sheetApis.messageRoomOrder.removeMessageRoomOrderEntry({ payload: key });
      }),
    claimMessageRoomOrderSend: (messageId: string, claimId: string) =>
      Effect.gen(function* () {
        const key = yield* messageKeyFor(messageId);
        return yield* sheetApis.messageRoomOrder.claimMessageRoomOrderSend({
          payload: { ...key, claimId },
        });
      }),
    completeMessageRoomOrderSend: (
      messageId: string,
      claimId: string,
      sentMessage: { readonly id: string; readonly conversationId: string },
    ) =>
      Effect.gen(function* () {
        const key = yield* messageKeyFor(messageId);
        return yield* sheetApis.messageRoomOrder.completeMessageRoomOrderSend({
          payload: { ...key, claimId, sentMessage },
        });
      }),
    releaseMessageRoomOrderSendClaim: (messageId: string, claimId: string) =>
      Effect.gen(function* () {
        const key = yield* messageKeyFor(messageId);
        return yield* sheetApis.messageRoomOrder.releaseMessageRoomOrderSendClaim({
          payload: { ...key, claimId },
        });
      }),
    claimMessageRoomOrderTentativeUpdate: (messageId: string, claimId: string) =>
      Effect.gen(function* () {
        const key = yield* messageKeyFor(messageId);
        return yield* sheetApis.messageRoomOrder.claimMessageRoomOrderTentativeUpdate({
          payload: { ...key, claimId },
        });
      }),
    releaseMessageRoomOrderTentativeUpdateClaim: (messageId: string, claimId: string) =>
      Effect.gen(function* () {
        const key = yield* messageKeyFor(messageId);
        return yield* sheetApis.messageRoomOrder.releaseMessageRoomOrderTentativeUpdateClaim({
          payload: { ...key, claimId },
        });
      }),
    claimMessageRoomOrderTentativePin: (messageId: string, claimId: string) =>
      Effect.gen(function* () {
        const key = yield* messageKeyFor(messageId);
        return yield* sheetApis.messageRoomOrder.claimMessageRoomOrderTentativePin({
          payload: { ...key, claimId },
        });
      }),
    completeMessageRoomOrderTentativePin: (messageId: string, claimId: string) =>
      Effect.gen(function* () {
        const key = yield* messageKeyFor(messageId);
        return yield* sheetApis.messageRoomOrder.completeMessageRoomOrderTentativePin({
          payload: { ...key, claimId },
        });
      }),
    releaseMessageRoomOrderTentativePinClaim: (messageId: string, claimId: string) =>
      Effect.gen(function* () {
        const key = yield* messageKeyFor(messageId);
        return yield* sheetApis.messageRoomOrder.releaseMessageRoomOrderTentativePinClaim({
          payload: { ...key, claimId },
        });
      }),
    markMessageRoomOrderTentative: (messageId: string) =>
      Effect.gen(function* () {
        const key = yield* messageKeyFor(messageId);
        return yield* sheetApis.messageRoomOrder.markMessageRoomOrderTentative({
          payload: key,
        });
      }),
  };

  return {
    checkinService: {
      generate: (payload: CheckinDispatchPayload) =>
        sheetApis.checkin.generate({
          payload: {
            workspaceId: payload.workspaceId,
            ...(payload.conversationId === undefined
              ? {}
              : { conversationId: payload.conversationId }),
            ...(payload.conversationName === undefined
              ? {}
              : { conversationName: payload.conversationName }),
            ...(payload.hour === undefined ? {} : { hour: payload.hour }),
            ...(payload.template === undefined ? {} : { template: payload.template }),
          },
        }),
    },
    workspaceConfigService: {
      getWorkspaceConfig: (workspaceId: string) =>
        optionalArgumentError(
          sheetApis.workspaceConfig.getWorkspaceConfig({ query: { workspaceId } }),
        ),
      upsertWorkspaceConfig: (
        workspaceId: string,
        config: {
          readonly sheetId?: string | null | undefined;
          readonly autoCheckin?: boolean | null | undefined;
        },
      ) => sheetApis.workspaceConfig.upsertWorkspaceConfig({ payload: { workspaceId, config } }),
      getWorkspaceMonitorRoles: (workspaceId: string) =>
        sheetApis.workspaceConfig.getWorkspaceMonitorRoles({ query: { workspaceId } }),
      getWorkspaceFeatureFlags: (workspaceId: string) =>
        sheetApis.workspaceConfig.getWorkspaceFeatureFlags({ query: { workspaceId } }),
      claimWorkspaceUpdateAnnouncementDelivery: (claim: {
        readonly workspaceId: string;
        readonly announcementId: string;
        readonly publishedAt: DateTime.Utc;
        readonly claimToken: string;
      }) => sheetApis.workspaceConfig.claimWorkspaceUpdateAnnouncementDelivery({ payload: claim }),
      releaseWorkspaceUpdateAnnouncementDeliveryClaim: (claim: {
        readonly workspaceId: string;
        readonly announcementId: string;
        readonly claimToken: string;
      }) =>
        sheetApis.workspaceConfig.releaseWorkspaceUpdateAnnouncementDeliveryClaim({
          payload: claim,
        }),
      addWorkspaceMonitorRole: (workspaceId: string, roleId: string) =>
        sheetApis.workspaceConfig.addWorkspaceMonitorRole({ payload: { workspaceId, roleId } }),
      removeWorkspaceMonitorRole: (workspaceId: string, roleId: string) =>
        sheetApis.workspaceConfig.removeWorkspaceMonitorRole({ payload: { workspaceId, roleId } }),
      addWorkspaceFeatureFlag: (workspaceId: string, flagName: string) =>
        sheetApis.workspaceConfig.addWorkspaceFeatureFlag({ payload: { workspaceId, flagName } }),
      removeWorkspaceFeatureFlag: (workspaceId: string, flagName: string) =>
        sheetApis.workspaceConfig.removeWorkspaceFeatureFlag({
          payload: { workspaceId, flagName },
        }),
      recordWorkspaceUpdateAnnouncementDelivery: (delivery: {
        readonly workspaceId: string;
        readonly announcementId: string;
        readonly publishedAt: DateTime.Utc;
        readonly deliveredAt: DateTime.Utc;
        readonly conversationId: string;
        readonly messageId: string;
      }) =>
        sheetApis.workspaceConfig.recordWorkspaceUpdateAnnouncementDelivery({ payload: delivery }),
      upsertWorkspaceConversationConfig: (
        workspaceId: string,
        conversationId: string,
        config: {
          readonly name?: string | null | undefined;
          readonly running?: boolean | null | undefined;
          readonly roleId?: string | null | undefined;
          readonly checkinConversationId?: string | null | undefined;
        },
      ) =>
        sheetApis.workspaceConfig.upsertWorkspaceConversationConfig({
          payload: { workspaceId, conversationId, config },
        }),
      getWorkspaceConversationById: (query: {
        readonly workspaceId: string;
        readonly conversationId: string;
        readonly running?: boolean | undefined;
      }) =>
        optionalArgumentError(sheetApis.workspaceConfig.getWorkspaceConversationById({ query })),
      getWorkspaceConversationByName: (query: {
        readonly workspaceId: string;
        readonly conversationName: string;
        readonly running?: boolean | undefined;
      }) =>
        optionalArgumentError(sheetApis.workspaceConfig.getWorkspaceConversationByName({ query })),
      getWorkspaceConversations: (workspaceId: string, running: boolean) =>
        sheetApis.workspaceConfig.getWorkspaceConversations({ query: { workspaceId, running } }),
    },
    messageCheckinService: {
      getMessageCheckinData: (messageId: string) =>
        Effect.gen(function* () {
          const key = yield* messageKeyFor(messageId);
          return yield* optionalArgumentError(
            sheetApis.messageCheckin.getMessageCheckinData({ query: key }),
          );
        }),
      getMessageCheckinMembers: (messageId: string) =>
        Effect.gen(function* () {
          const key = yield* messageKeyFor(messageId);
          return yield* sheetApis.messageCheckin.getMessageCheckinMembers({ query: key });
        }),
      persistMessageCheckin: (
        messageId: string,
        payload: Omit<
          Parameters<typeof sheetApis.messageCheckin.persistMessageCheckin>[0]["payload"],
          keyof MessageKey
        >,
      ) =>
        Effect.gen(function* () {
          const key = yield* messageKeyFor(messageId);
          return yield* sheetApis.messageCheckin.persistMessageCheckin({
            payload: { ...key, ...payload },
          });
        }),
      setMessageCheckinMemberCheckinAtIfUnset: (
        messageId: string,
        memberId: string,
        checkinAt: number,
        checkinClaimId: string,
      ) =>
        Effect.gen(function* () {
          const key = yield* messageKeyFor(messageId);
          return yield* sheetApis.messageCheckin.setMessageCheckinMemberCheckinAtIfUnset({
            payload: { ...key, memberId, checkinAt, checkinClaimId },
          });
        }),
    },
    messageRoomOrderService,
    messageSlotService: {
      getMessageSlotData: (messageId: string) =>
        Effect.gen(function* () {
          const key = yield* messageKeyFor(messageId);
          return yield* optionalArgumentError(
            sheetApis.messageSlot.getMessageSlotData({ query: key }),
          );
        }),
      upsertMessageSlotData: (
        messageId: string,
        data: Parameters<typeof sheetApis.messageSlot.upsertMessageSlotData>[0]["payload"]["data"],
      ) =>
        Effect.gen(function* () {
          const key = yield* messageKeyFor(messageId);
          return yield* sheetApis.messageSlot.upsertMessageSlotData({
            payload: { ...key, data },
          });
        }),
    },
    roomOrderService: {
      generate: (
        payload:
          | RoomOrderDispatchPayload
          | { workspaceId: string; conversationId: string; hour: number },
      ) =>
        sheetApis.roomOrder.generate({
          payload: {
            workspaceId: payload.workspaceId,
            ...("conversationId" in payload && payload.conversationId !== undefined
              ? { conversationId: payload.conversationId }
              : {}),
            ...("conversationName" in payload && payload.conversationName !== undefined
              ? { conversationName: payload.conversationName }
              : {}),
            ...("hour" in payload && payload.hour !== undefined ? { hour: payload.hour } : {}),
            ...("healNeeded" in payload && payload.healNeeded !== undefined
              ? { healNeeded: payload.healNeeded }
              : {}),
          },
        }),
    },
    scheduleService: {
      dayPopulatedFillerSchedules: (workspaceId: string, day: number) =>
        sheetApis.schedule
          .getDayPopulatedSchedules({ query: { workspaceId, day, view: "filler" } })
          .pipe(Effect.map(({ schedules }) => schedules)),
      dayPlayerSchedule: (workspaceId: string, day: number, accountId: string) =>
        sheetApis.schedule.getDayPlayerSchedule({
          query: { workspaceId, day, accountId, view: "filler" },
        }),
      conversationPopulatedMonitorSchedules: (workspaceId: string, conversation: string) =>
        sheetApis.schedule
          .getConversationPopulatedSchedules({
            query: { workspaceId, conversationName: conversation, view: "monitor" },
          })
          .pipe(Effect.map(({ schedules }) => schedules)),
    },
    sheetService: {
      getEventConfig: (workspaceId: string) =>
        sheetApis.sheet.getEventConfig({ query: { workspaceId } }),
    },
    statusService: {
      getServicesStatus: () => sheetApis.status.getServices({}),
    },
    playerService: {
      getTeamsByIds: (workspaceId: string, ids: readonly string[]) =>
        sheetApis.player.getTeamsByIds({ query: { workspaceId, ids } }),
    },
    screenshotService: {
      getScreenshot: (workspaceId: string, conversation: string, day: number) =>
        sheetApis.screenshot.getScreenshot({
          query: { workspaceId, conversationName: conversation, day },
        }),
    },
  };
};

const logEnableFailure = (message: string) => (error: unknown) =>
  Effect.logWarning(message).pipe(Effect.annotateLogs({ cause: globalThis.String(error) }));

const makeInteractionMessageSink = (
  botClient: typeof ClientDeliveryClient.Service,
  interactionResponseToken: string,
): DispatchMessageSink => ({
  sendPrimary: (payload) =>
    botClient.updateOriginalInteractionResponse(interactionResponseToken, payload),
  updatePrimary: (_message, payload) =>
    botClient.updateOriginalInteractionResponse(interactionResponseToken, payload),
});

const makeConversationMessageSink = (
  botClient: typeof ClientDeliveryClient.Service,
  conversationId: string,
): DispatchMessageSink => ({
  sendPrimary: (payload) => botClient.sendMessage(conversationId, payload),
  updatePrimary: (message, payload) =>
    botClient.updateMessage(message.conversation_id, message.id, payload),
});

const makeMessageSink = (
  botClient: typeof ClientDeliveryClient.Service,
  conversationId: string,
  interactionResponseToken: string | undefined,
): DispatchMessageSink =>
  typeof interactionResponseToken === "string"
    ? makeInteractionMessageSink(botClient, interactionResponseToken)
    : makeConversationMessageSink(botClient, conversationId);

const textValue = (value: MessageTextInput): MessageTextValue =>
  typeof value === "string" ? [MessageText.text(value)] : value;

const conversationMentionValue = (
  client: ClientRef,
  workspaceId: string,
  conversationId: string,
): MessageTextValue => [
  MessageText.conversationMention(MessageText.conversationRef(client, workspaceId, conversationId)),
];

const roleMentionValue = (
  client: ClientRef,
  workspaceId: string,
  roleId: string,
): MessageTextValue => [
  MessageText.roleMention(MessageText.workspaceRef(client, workspaceId), roleId),
];

const escapeMarkdown = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("`", "\\`")
    .replaceAll("~", "\\~")
    .replaceAll("|", "\\|")
    .replaceAll(">", "\\>");

const resolveWorkspaceDisplayName = (
  botClient: typeof ClientDeliveryClient.Service,
  workspaceId: string,
): Effect.Effect<MessageTextValue> =>
  botClient.getWorkspace(workspaceId).pipe(
    Effect.map((workspace) => {
      const name = workspace.name.trim();
      return name.length > 0
        ? [MessageText.text(escapeMarkdown(name))]
        : [MessageText.text("this "), MessageText.clientTerm("workspace")];
    }),
    Effect.catch(() =>
      Effect.succeed([MessageText.text("this "), MessageText.clientTerm("workspace")]),
    ),
  );

const bold = (value: string): string => `**${value}**`;

const time = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString();

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

const autoCheckinTestHour = 1;
const autoCheckinTestColor = 0xf59e0b;
const autoCheckinTestNotice =
  "TEST RUN - no check-ins, room orders, roles, or persistent message records were created.";
const autoCheckinTestFailureDetailLength = 900;

const truncateAutoCheckinTestFailureDetail = (value: string): string =>
  value.length <= autoCheckinTestFailureDetailLength
    ? value
    : `${value.slice(0, autoCheckinTestFailureDetailLength - 3)}...`;

const makeAutoCheckinTestEmbed = (embed: {
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

const makeWebScheduleEmbed = () =>
  makeEmbed({
    description: [
      MessageText.text("📅 "),
      MessageText.strong([MessageText.text("Preview")]),
      MessageText.text(": View your schedule online at "),
      MessageText.externalLink("https://schedule.theerapakg.moe/"),
    ],
    color: 0x5865f2,
  });

const isAutoCheckinEnabled = (autoCheckin: Option.Option<boolean>) =>
  Option.getOrElse(autoCheckin, () => false);

const formatConversationConfigFields = (config: {
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
    value: Option.getOrUndefined(config.running) ? "Yes" : "No",
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

const sendableWorkspaceConversationTypes = new Set([0, 5]);

const isSendableWorkspaceConversation = (conversation: ClientConversationCacheEntry) =>
  sendableWorkspaceConversationTypes.has(conversation.value.type);

const conversationPosition = (conversation: ClientConversationCacheEntry) =>
  typeof conversation.value.position === "number"
    ? conversation.value.position
    : Number.MAX_SAFE_INTEGER;

const workspaceWelcomeConversationCandidates = (
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

const sendWorkspaceAnnouncementWithWelcomeHeuristic = (params: {
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly workspaceId: string;
  readonly systemConversationId: string | undefined;
  readonly messagePayload: MessagePayload;
  readonly logLabel: string;
}) =>
  Effect.gen(function* () {
    const conversations = yield* params.botClient.getConversationsForParent(params.workspaceId);
    const candidates = workspaceWelcomeConversationCandidates(
      conversations,
      params.systemConversationId,
    );

    for (const conversation of candidates) {
      const sentMessage = yield* params.botClient
        .sendMessage(conversation.resourceId, params.messagePayload)
        .pipe(
          Effect.map(Option.some),
          Effect.catchCause((cause) =>
            Effect.logWarning(`Failed to send ${params.logLabel}`).pipe(
              Effect.annotateLogs({
                workspaceId: params.workspaceId,
                conversationId: conversation.resourceId,
                conversationName: conversation.value.name,
              }),
              Effect.andThen(Effect.logDebug(cause)),
              Effect.as(Option.none<DeliveredMessage>()),
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

const fillParticipantFromName = (name: string) => ({
  key: `name:${name}`,
  label: name,
  name,
});

const renderRoomOrderReply = Effect.fn("DispatchService.renderRoomOrderReply")(function* ({
  workspaceId,
  messageId,
  mode,
  roomOrder,
  sheetService,
  messageRoomOrderService,
}: {
  readonly workspaceId: string;
  readonly messageId: string;
  readonly mode: "normal" | "tentative";
  readonly roomOrder: MessageRoomOrder;
  readonly sheetService: SheetServiceApi;
  readonly messageRoomOrderService: ReturnType<
    typeof makeSheetApisServices
  >["messageRoomOrderService"];
}) {
  yield* Effect.annotateCurrentSpan({ workspaceId, messageId, mode, hour: roomOrder.hour });
  const maybeRange = yield* messageRoomOrderService.getMessageRoomOrderRange(messageId);
  const entries = yield* messageRoomOrderService.getMessageRoomOrderEntry(
    messageId,
    roomOrder.rank,
  );
  const range = yield* Option.match(maybeRange, {
    onSome: Effect.succeed,
    onNone: () => Effect.fail(makeArgumentError("Cannot render room order, no entries found")),
  });
  const eventConfig = yield* sheetService.getEventConfig(workspaceId);
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
        content: tentativeRoomOrderContent(content),
        components: [tentativeRoomOrderActionRow(range, roomOrder.rank)],
      }
    : {
        content,
        components: [roomOrderActionRow(range, roomOrder.rank)],
      };
});

export class DispatchService extends Context.Service<DispatchService>()("DispatchService", {
  make: Effect.gen(function* () {
    const botClient = yield* ClientDeliveryClient;
    const sheetApisClient = yield* SheetApisClient;
    const {
      checkinService,
      workspaceConfigService,
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
    const autoCheckinConcurrency = yield* config.autoCheckinConcurrency;

    const failRoomOrderInteraction = (
      payload: RoomOrderButtonPayload,
      content: string,
      errorMessage: string,
    ) =>
      botClient
        .updateOriginalInteractionResponse(payload.interactionResponseToken, {
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
          !Option.contains(roomOrder.workspaceId, payload.workspaceId) ||
          !Option.contains(roomOrder.conversationId, payload.messageConversationId)
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
      const fallbackConversation = yield* workspaceConfigService.getWorkspaceConversationById({
        workspaceId: payload.workspaceId,
        conversationId: payload.messageConversationId,
        running: true,
      });
      if (Option.isNone(fallbackConversation)) {
        yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
          content: "This conversation is not a registered running conversation.",
          components: [],
        });
        return yield* Effect.fail(
          markInteractionFailureHandled(
            makeArgumentError(
              "Cannot handle room-order button, message conversation is not a registered running conversation",
            ),
          ),
        );
      }

      const pinned = yield* botClient
        .createPin(payload.messageConversationId, payload.messageId)
        .pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logError("Failed to pin fallback tentative room order").pipe(
              Effect.annotateLogs({
                workspaceId: payload.workspaceId,
                conversationId: payload.messageConversationId,
                messageId: payload.messageId,
              }),
              Effect.andThen(Effect.logError(cause)),
              Effect.as(false),
            ),
          ),
        );

      const cleanedUp = pinned
        ? yield* botClient
            .updateMessage(payload.messageConversationId, payload.messageId, {
              components: [],
            })
            .pipe(
              Effect.as(true),
              Effect.catchCause((cause) =>
                Effect.logError("Failed to clean up fallback tentative room order").pipe(
                  Effect.annotateLogs({
                    workspaceId: payload.workspaceId,
                    conversationId: payload.messageConversationId,
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
      yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
        content: detail,
        components: [],
      });

      return {
        messageId: payload.messageId,
        messageConversationId: payload.messageConversationId,
        status: pinned ? (cleanedUp ? "pinned" : "partial") : "failed",
        detail,
      } satisfies RoomOrderButtonResult;
    });

    const loadRequiredRoomOrderContext = Effect.fn("DispatchService.loadRequiredRoomOrderContext")(
      function* (payload: RoomOrderButtonPayload, initialRoomOrder: MessageRoomOrder) {
        yield* requireRoomOrderMatch(payload, initialRoomOrder);
        const trustedWorkspaceId = yield* Option.match(initialRoomOrder.workspaceId, {
          onSome: Effect.succeed,
          onNone: () =>
            failRoomOrderInteraction(
              payload,
              "This room-order message workspace is not registered.",
              "Cannot handle room-order button, message workspace is not registered",
            ),
        });
        const trustedMessageConversationId = yield* Option.match(initialRoomOrder.conversationId, {
          onSome: Effect.succeed,
          onNone: () =>
            failRoomOrderInteraction(
              payload,
              "This room-order message conversation is not registered.",
              "Cannot handle room-order button, message conversation is not registered",
            ),
        });
        const messageHasTentativePrefix = hasTentativeRoomOrderPrefix(payload.messageContent ?? "");
        const effectiveInitialRoomOrder =
          !initialRoomOrder.tentative && messageHasTentativePrefix
            ? yield* messageRoomOrderService.markMessageRoomOrderTentative(payload.messageId).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Failed to repair legacy tentative room-order flag").pipe(
                    Effect.annotateLogs({
                      workspaceId: trustedWorkspaceId,
                      messageId: payload.messageId,
                      conversationId: trustedMessageConversationId,
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
            workspaceId: trustedWorkspaceId,
            messageId: payload.messageId,
            mode: replyMode,
            roomOrder,
            sheetService,
            messageRoomOrderService,
          });

        const updateInteraction = (
          content: string,
          components: ReadonlyArray<SheetMessageComponent> = [],
        ) =>
          botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
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
          trustedWorkspaceId,
          trustedMessageConversationId,
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
            .updateOriginalInteractionResponse(payload.interactionResponseToken, {
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
      messageConversationId: string,
      status: RoomOrderButtonResult["status"],
      detail: string | null,
    ) =>
      ({
        messageId: payload.messageId,
        messageConversationId,
        status,
        detail,
      }) satisfies RoomOrderButtonResult;

    const denyRoomOrderButton = Effect.fn("DispatchService.denyRoomOrderButton")(function* ({
      detail,
      messageConversationId,
      payload,
      updateInteraction,
    }: {
      readonly detail: string;
      readonly messageConversationId: string;
      readonly payload: RoomOrderButtonPayload;
      readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
    }) {
      yield* updateInteraction(detail);
      return roomOrderButtonResult(payload, messageConversationId, "denied", detail);
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
        messageConversationId,
        payload,
        updateClaimId,
        updateInteraction,
      }: {
        readonly claimedRoomOrder: MessageRoomOrder;
        readonly getRoomOrderBusyDetail: (roomOrder: MessageRoomOrder) => string;
        readonly messageConversationId: string;
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
              messageConversationId,
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
      messageConversationId,
      payload,
      updateClaimId,
      updateInteraction,
    }: {
      readonly direction: RoomOrderRankDirection;
      readonly getRoomOrderBusyDetail: (roomOrder: MessageRoomOrder) => string;
      readonly initialRoomOrder: MessageRoomOrder;
      readonly messageConversationId: string;
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
          messageConversationId,
          payload,
          updateInteraction,
        }),
      };
    });

    const publishRoomOrderRankUpdate = Effect.fn("DispatchService.publishRoomOrderRankUpdate")(
      function* ({
        direction,
        interactionResponseType,
        messageConversationId,
        mode,
        payload,
        renderReply,
        updateClaimId,
        updatedRank,
        updateInteraction,
      }: {
        readonly direction: RoomOrderRankDirection;
        readonly interactionResponseType: "reply" | "update";
        readonly messageConversationId: string;
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
            .updateMessage(messageConversationId, payload.messageId, reply)
            .pipe(Effect.catchCause(rollback));
          yield* releaseTentativeUpdateClaim(payload.messageId, updateClaimId);
          yield* acknowledgeRoomOrderButton(
            updateInteraction,
            mode === "tentative" ? "updated tentative room order." : "updated room order.",
          );
          return;
        }

        yield* botClient
          .updateOriginalInteractionResponse(payload.interactionResponseToken, reply)
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
          workspaceId: payload.workspaceId,
          conversationId: payload.messageConversationId,
          messageId: payload.messageId,
          direction,
        });
        const maybeInitialRoomOrder = yield* loadInitialRoomOrder(payload, authorizedRoomOrder);
        const initialRoomOrder = yield* requireInitialRoomOrder(payload, maybeInitialRoomOrder);
        const {
          trustedMessageConversationId,
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
            messageConversationId: trustedMessageConversationId,
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
          messageConversationId: trustedMessageConversationId,
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
          messageConversationId: trustedMessageConversationId,
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
          messageConversationId: trustedMessageConversationId,
          mode,
          payload,
          renderReply,
          updateClaimId,
          updatedRank: rankUpdate.roomOrder,
          updateInteraction,
        });

        return roomOrderButtonResult(payload, trustedMessageConversationId, "updated", null);
      },
    );

    const requireRoomOrderSendPreflight = Effect.fn(
      "DispatchService.requireRoomOrderSendPreflight",
    )(function* ({
      initialRoomOrder,
      mode,
      payload,
      trustedMessageConversationId,
      updateInteraction,
    }: {
      readonly initialRoomOrder: MessageRoomOrder;
      readonly mode: RoomOrderButtonMode;
      readonly payload: RoomOrderSendButtonPayload;
      readonly trustedMessageConversationId: string;
      readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
    }) {
      if (mode === "tentative") {
        return Option.some(
          yield* denyRoomOrderButton({
            detail: "cannot send a tentative room order.",
            messageConversationId: trustedMessageConversationId,
            payload,
            updateInteraction,
          }),
        );
      }
      if (
        Option.isSome(initialRoomOrder.sentMessageId) &&
        Option.isSome(initialRoomOrder.sentConversationId)
      ) {
        const detail = "room order was already sent.";
        yield* updateInteraction(detail);
        return Option.some({
          messageId: initialRoomOrder.sentMessageId.value,
          messageConversationId: initialRoomOrder.sentConversationId.value,
          status: "sent",
          detail,
        } satisfies RoomOrderButtonResult);
      }
      if (Option.isSome(initialRoomOrder.tentativePinnedAt)) {
        return Option.some(
          yield* denyRoomOrderButton({
            detail: "tentative room order is already pinned.",
            messageConversationId: trustedMessageConversationId,
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
        trustedMessageConversationId,
        updateInteraction,
      }: {
        readonly claimId: string;
        readonly claimedRoomOrder: MessageRoomOrder;
        readonly getRoomOrderBusyDetail: (roomOrder: MessageRoomOrder) => string;
        readonly payload: RoomOrderSendButtonPayload;
        readonly trustedMessageConversationId: string;
        readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
      }) {
        if (
          Option.isSome(claimedRoomOrder.sentMessageId) &&
          Option.isSome(claimedRoomOrder.sentConversationId)
        ) {
          const detail = "room order was already sent.";
          yield* updateInteraction(detail);
          return Option.some({
            messageId: claimedRoomOrder.sentMessageId.value,
            messageConversationId: claimedRoomOrder.sentConversationId.value,
            status: "sent",
            detail,
          } satisfies RoomOrderButtonResult);
        }
        if (!Option.contains(claimedRoomOrder.sendClaimId, claimId)) {
          return Option.some(
            yield* denyRoomOrderButton({
              detail: getRoomOrderBusyDetail(claimedRoomOrder),
              messageConversationId: trustedMessageConversationId,
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
      trustedMessageConversationId,
      updateInteraction,
    }: {
      readonly claimId: string;
      readonly claimedRoomOrder: MessageRoomOrder;
      readonly payload: RoomOrderSendButtonPayload;
      readonly renderReply: (
        roomOrder: MessageRoomOrder,
        replyMode: "normal",
      ) => Effect.Effect<MessagePayload, unknown>;
      readonly trustedMessageConversationId: string;
      readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
    }) {
      const reply = yield* renderReply(claimedRoomOrder, "normal").pipe(
        Effect.catchCause((cause) => failRoomOrderSend(payload, claimId, updateInteraction, cause)),
      );
      yield* Effect.logInfo("Sending room-order message").pipe(
        Effect.annotateLogs({
          workspaceId: payload.workspaceId,
          conversationId: trustedMessageConversationId,
          sourceMessageId: payload.messageId,
        }),
      );
      const sentMessage = yield* botClient
        .sendMessage(trustedMessageConversationId, {
          content: reply.content,
        })
        .pipe(
          Effect.catchCause((cause) =>
            failRoomOrderSend(payload, claimId, updateInteraction, cause),
          ),
        );
      yield* Effect.logInfo("Sent room-order message").pipe(
        Effect.annotateLogs({
          workspaceId: payload.workspaceId,
          conversationId: sentMessage.conversation_id,
          sourceMessageId: payload.messageId,
          sentMessageId: sentMessage.id,
        }),
      );
      return sentMessage;
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
      readonly sentMessage: { readonly id: string; readonly conversation_id: string };
      readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
    }) {
      const completedRoomOrder = yield* messageRoomOrderService.completeMessageRoomOrderSend(
        payload.messageId,
        claimId,
        {
          id: sentMessage.id,
          conversationId: sentMessage.conversation_id,
        },
      );
      if (
        Option.isNone(completedRoomOrder.sendClaimId) &&
        Option.contains(completedRoomOrder.sentMessageId, sentMessage.id) &&
        Option.contains(completedRoomOrder.sentConversationId, sentMessage.conversation_id)
      ) {
        yield* Effect.logInfo("Tracked sent room-order message").pipe(
          Effect.annotateLogs({
            conversationId: sentMessage.conversation_id,
            sourceMessageId: payload.messageId,
            sentMessageId: sentMessage.id,
          }),
        );
        return Option.none<RoomOrderButtonResult>();
      }

      const detail = "sent room order, but failed to track it.";
      yield* updateInteraction(detail);
      return Option.some({
        messageId: sentMessage.id,
        messageConversationId: sentMessage.conversation_id,
        status: "partial",
        detail,
      } satisfies RoomOrderButtonResult);
    });

    const pinSentRoomOrder = Effect.fn("DispatchService.pinSentRoomOrder")(function* ({
      sentMessage,
      trustedWorkspaceId,
    }: {
      readonly sentMessage: { readonly id: string; readonly conversation_id: string };
      readonly trustedWorkspaceId: string;
    }) {
      return yield* botClient.createPin(sentMessage.conversation_id, sentMessage.id).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logError("Failed to pin sent room order").pipe(
            Effect.annotateLogs({
              workspaceId: trustedWorkspaceId,
              conversationId: sentMessage.conversation_id,
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
        workspaceId: payload.workspaceId,
        conversationId: payload.messageConversationId,
        messageId: payload.messageId,
      });
      const maybeInitialRoomOrder = yield* loadInitialRoomOrder(payload, authorizedRoomOrder);
      const initialRoomOrder = yield* requireInitialRoomOrder(payload, maybeInitialRoomOrder);
      const {
        trustedWorkspaceId,
        trustedMessageConversationId,
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
        trustedMessageConversationId,
        updateInteraction,
      });
      if (Option.isSome(preflightResult)) {
        yield* Effect.logInfo("Room-order send preflight returned without sending").pipe(
          Effect.annotateLogs({
            workspaceId: trustedWorkspaceId,
            conversationId: trustedMessageConversationId,
            messageId: payload.messageId,
            status: preflightResult.value.status,
            detail: preflightResult.value.detail ?? "",
          }),
        );
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
        trustedMessageConversationId,
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
        trustedMessageConversationId,
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

      const pinned = yield* pinSentRoomOrder({ sentMessage, trustedWorkspaceId });
      yield* Effect.logInfo("Completed room-order send button").pipe(
        Effect.annotateLogs({
          workspaceId: trustedWorkspaceId,
          conversationId: sentMessage.conversation_id,
          sourceMessageId: payload.messageId,
          sentMessageId: sentMessage.id,
          pinned,
        }),
      );

      const detail = pinned
        ? "sent room order and pinned it!"
        : "sent room order, but failed to pin it.";
      yield* acknowledgeRoomOrderButton(updateInteraction, detail);

      return {
        messageId: sentMessage.id,
        messageConversationId: sentMessage.conversation_id,
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
        trustedMessageConversationId,
        updateInteraction,
      }: {
        readonly mode: RoomOrderButtonMode;
        readonly payload: RoomOrderPinTentativeButtonPayload;
        readonly trustedMessageConversationId: string;
        readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
      }) {
        if (mode === "tentative") {
          return Option.none<RoomOrderButtonResult>();
        }

        return Option.some(
          yield* denyRoomOrderButton({
            detail: "cannot pin a non-tentative room order.",
            messageConversationId: trustedMessageConversationId,
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
        trustedMessageConversationId,
        updateInteraction,
      }: {
        readonly getRoomOrderBusyDetail: (roomOrder: MessageRoomOrder) => string;
        readonly pinClaimId: string;
        readonly pinClaimedRoomOrder: MessageRoomOrder;
        readonly payload: RoomOrderPinTentativeButtonPayload;
        readonly trustedMessageConversationId: string;
        readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
      }) {
        if (Option.isSome(pinClaimedRoomOrder.tentativePinnedAt)) {
          return Option.some(
            yield* denyRoomOrderButton({
              detail: "tentative room order is already pinned.",
              messageConversationId: trustedMessageConversationId,
              payload,
              updateInteraction,
            }),
          );
        }
        if (!Option.contains(pinClaimedRoomOrder.tentativePinClaimId, pinClaimId)) {
          return Option.some(
            yield* denyRoomOrderButton({
              detail: getRoomOrderBusyDetail(pinClaimedRoomOrder),
              messageConversationId: trustedMessageConversationId,
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
      trustedWorkspaceId,
      trustedMessageConversationId,
    }: {
      readonly payload: RoomOrderPinTentativeButtonPayload;
      readonly trustedWorkspaceId: string;
      readonly trustedMessageConversationId: string;
    }) {
      return yield* botClient.createPin(trustedMessageConversationId, payload.messageId).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logError("Failed to pin tentative room order").pipe(
            Effect.annotateLogs({
              workspaceId: trustedWorkspaceId,
              conversationId: trustedMessageConversationId,
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
      trustedWorkspaceId,
      trustedMessageConversationId,
      updateInteraction,
    }: {
      readonly pinClaimId: string;
      readonly payload: RoomOrderPinTentativeButtonPayload;
      readonly trustedWorkspaceId: string;
      readonly trustedMessageConversationId: string;
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
                  workspaceId: trustedWorkspaceId,
                  conversationId: trustedMessageConversationId,
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
      trustedWorkspaceId,
      trustedMessageConversationId,
    }: {
      readonly initialRoomOrder: MessageRoomOrder;
      readonly payload: RoomOrderPinTentativeButtonPayload;
      readonly pinnedRoomOrder: MessageRoomOrder | null;
      readonly renderReply: (
        roomOrder: MessageRoomOrder,
        replyMode: "normal",
      ) => Effect.Effect<MessagePayload, unknown>;
      readonly trustedWorkspaceId: string;
      readonly trustedMessageConversationId: string;
    }) {
      return yield* Effect.gen(function* () {
        const latestReply = yield* renderReply(pinnedRoomOrder ?? initialRoomOrder, "normal");

        return yield* botClient
          .updateMessage(trustedMessageConversationId, payload.messageId, {
            content: latestReply.content,
            components: [],
          })
          .pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logError("Failed to clean up pinned tentative room order").pipe(
                Effect.annotateLogs({
                  workspaceId: trustedWorkspaceId,
                  conversationId: trustedMessageConversationId,
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
              workspaceId: trustedWorkspaceId,
              conversationId: trustedMessageConversationId,
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
      trustedWorkspaceId,
      trustedMessageConversationId,
      updateInteraction,
    }: {
      readonly initialRoomOrder: MessageRoomOrder;
      readonly pinClaimId: string;
      readonly payload: RoomOrderPinTentativeButtonPayload;
      readonly renderReply: (
        roomOrder: MessageRoomOrder,
        replyMode: "normal",
      ) => Effect.Effect<MessagePayload, unknown>;
      readonly trustedWorkspaceId: string;
      readonly trustedMessageConversationId: string;
      readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
    }) {
      const pinned = yield* createTentativePin({
        payload,
        trustedWorkspaceId,
        trustedMessageConversationId,
      });
      if (!pinned) {
        yield* messageRoomOrderService
          .releaseMessageRoomOrderTentativePinClaim(payload.messageId, pinClaimId)
          .pipe(Effect.catchCause(() => Effect.void));
        const detail = "tentative room order could not be pinned.";
        yield* updateInteraction(detail);
        return roomOrderButtonResult(payload, trustedMessageConversationId, "failed", detail);
      }

      const maybePinnedRoomOrder = yield* completeTentativePin({
        pinClaimId,
        payload,
        trustedWorkspaceId,
        trustedMessageConversationId,
        updateInteraction,
      });
      if (Option.isNone(maybePinnedRoomOrder)) {
        return roomOrderButtonResult(
          payload,
          trustedMessageConversationId,
          "partial",
          "pinned tentative room order, but failed to track it.",
        );
      }

      const pinnedRoomOrder = maybePinnedRoomOrder.value;
      if (Option.isNone(pinnedRoomOrder.tentativePinnedAt)) {
        const detail = "pinned tentative room order, but failed to track it.";
        yield* updateInteraction(detail);
        return roomOrderButtonResult(payload, trustedMessageConversationId, "partial", detail);
      }

      const cleanedUp = yield* cleanupTentativePin({
        initialRoomOrder,
        payload,
        pinnedRoomOrder,
        renderReply,
        trustedWorkspaceId,
        trustedMessageConversationId,
      });
      const detail = cleanedUp
        ? "pinned tentative room order!"
        : "pinned tentative room order, but failed to clean up the message.";
      yield* acknowledgeRoomOrderButton(updateInteraction, detail);
      return roomOrderButtonResult(
        payload,
        trustedMessageConversationId,
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
        workspaceId: payload.workspaceId,
        conversationId: payload.messageConversationId,
        messageId: payload.messageId,
      });
      const maybeInitialRoomOrder = yield* loadInitialRoomOrder(payload, authorizedRoomOrder);
      if (Option.isNone(maybeInitialRoomOrder)) {
        yield* requireTentativeFallbackPinPayload(payload);
        return yield* handleFallbackTentativePin(payload);
      }
      const initialRoomOrder = maybeInitialRoomOrder.value;
      const {
        trustedWorkspaceId,
        trustedMessageConversationId,
        mode,
        renderReply,
        updateInteraction,
        getRoomOrderBusyDetail,
        requireCurrentRoomOrderMatch,
      } = yield* loadRequiredRoomOrderContext(payload, initialRoomOrder);
      const notTentative = yield* requireTentativePinMode({
        mode,
        payload,
        trustedMessageConversationId,
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
        trustedMessageConversationId,
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
        trustedWorkspaceId,
        trustedMessageConversationId,
        updateInteraction,
      });
    });

    const makeSlotEmbeds = Effect.fn("DispatchService.makeSlotEmbeds")(function* (
      workspaceId: string,
      day: number,
    ) {
      const eventConfig = yield* sheetService.getEventConfig(workspaceId);
      const daySchedule = yield* scheduleService.dayPopulatedFillerSchedules(workspaceId, day);
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
      autoCheckinTest: Effect.fn("DispatchService.autoCheckinTest")(function* (
        payload: AutoCheckinTestDispatchPayload,
        requester: DispatchRequester,
      ) {
        yield* Effect.annotateCurrentSpan({
          workspaceId: payload.workspaceId,
          anchorConversationId: payload.anchorConversationId,
          hour: autoCheckinTestHour,
          "requester.accountId": requester.accountId,
          "requester.userId": requester.userId,
          autoCheckinConcurrency,
        });

        const makeAnchorPayload = (
          description: MessageTextInput,
          fields: ReadonlyArray<{
            readonly name: MessageTextInput;
            readonly value: MessageTextInput;
            readonly inline?: boolean;
          }> = [],
        ) =>
          ({
            content: null,
            embeds: [
              makeAutoCheckinTestEmbed({
                title: "TEST RUN: Auto check-in configuration",
                description,
                fields,
              }),
            ],
            allowedMentions: "none",
          }) satisfies MessagePayload;

        const createAnchor = (messagePayload: MessagePayload) =>
          typeof payload.interactionResponseToken === "string"
            ? botClient.updateOriginalInteractionResponse(
                payload.interactionResponseToken,
                messagePayload,
              )
            : botClient.sendMessage(payload.anchorConversationId, messagePayload);

        const anchorMessage = yield* createAnchor(
          makeAnchorPayload(
            MessageText.lines(
              [
                MessageText.text("Testing first-hour auto check-in for "),
                MessageText.clientTerm("workspace"),
                MessageText.text(` ${payload.workspaceId}.`),
              ],
              [
                MessageText.text("Requested by "),
                MessageText.userMention(requester.accountId),
                MessageText.text("."),
              ],
              [MessageText.text(autoCheckinTestNotice)],
            ),
          ),
        );
        const updateAnchor = (messagePayload: MessagePayload) =>
          typeof payload.interactionResponseToken === "string"
            ? botClient.updateOriginalInteractionResponse(
                payload.interactionResponseToken,
                messagePayload,
              )
            : botClient.updateMessage(
                anchorMessage.conversation_id,
                anchorMessage.id,
                messagePayload,
              );
        const anchorMessageLink = [
          MessageText.messageLink(
            {
              conversation: {
                workspace: {
                  client: payload.client,
                  workspaceId: payload.workspaceId,
                },
                conversationId: anchorMessage.conversation_id,
              },
              messageId: anchorMessage.id,
            },
            "message",
          ),
        ];
        const withAnchorField = (embed: MessageEmbed): MessageEmbed => {
          const fields =
            (
              embed as {
                readonly fields?: ReadonlyArray<{
                  readonly name: MessageTextInput;
                  readonly value: MessageTextInput;
                  readonly inline?: boolean;
                }>;
              }
            ).fields ?? [];

          return {
            ...embed,
            fields: [
              ...fields,
              {
                name: [MessageText.clientTerm("testRun", { casing: "sentence" })],
                value: anchorMessageLink,
              },
            ],
          };
        };
        const referencedMessagePayload = (embed: MessageEmbed) =>
          ({
            content: null,
            embeds: [withAnchorField(embed)],
            allowedMentions: "none",
          }) satisfies MessagePayload;

        const runTestConversation = (
          conversationName: string,
        ): Effect.Effect<AutoCheckinTestConversationResult, never, never> => {
          let runningConversationId: string | null = null;
          let checkinConversationId: string | null = null;

          return Effect.gen(function* () {
            const generated = yield* checkinService.generate({
              client: payload.client,
              dispatchRequestId: `${payload.dispatchRequestId}:${conversationName}`,
              workspaceId: payload.workspaceId,
              conversationName,
              hour: autoCheckinTestHour,
            });
            const generatedMonitorCheckinMessage = MessageText.materializeGeneratedText(
              payload.client,
              payload.workspaceId,
              generated.monitorCheckinMessage,
            );
            const generatedMonitorFailureMessage =
              generated.monitorFailureMessage === null
                ? null
                : MessageText.materializeGeneratedText(
                    payload.client,
                    payload.workspaceId,
                    generated.monitorFailureMessage,
                  );
            const generatedInitialMessage =
              generated.initialMessage === null
                ? null
                : MessageText.materializeGeneratedText(
                    payload.client,
                    payload.workspaceId,
                    generated.initialMessage,
                  );
            runningConversationId = generated.runningConversationId;
            checkinConversationId = generated.checkinConversationId;

            if (generatedInitialMessage === null) {
              const monitorPreviewMessage = yield* botClient.sendMessage(
                generated.runningConversationId,
                referencedMessagePayload(
                  makeAutoCheckinTestEmbed({
                    title: "TEST RUN: Check-in skipped",
                    description: MessageText.lines(
                      generatedMonitorCheckinMessage,
                      ...Option.match(Option.fromNullishOr(generatedMonitorFailureMessage), {
                        onSome: (failure) => [[MessageText.subtle(failure)]],
                        onNone: () => [],
                      }),
                    ),
                    fields: [
                      {
                        name: [MessageText.clientTerm("conversation", { casing: "sentence" })],
                        value: conversationName,
                        inline: true,
                      },
                      {
                        name: [MessageText.clientTerm("runDestination", { casing: "sentence" })],
                        value: conversationMentionValue(
                          payload.client,
                          payload.workspaceId,
                          generated.runningConversationId,
                        ),
                        inline: true,
                      },
                      { name: "Hour", value: globalThis.String(generated.hour), inline: true },
                    ],
                  }),
                ),
              );

              return {
                conversationName,
                runningConversationId: generated.runningConversationId,
                checkinConversationId: generated.checkinConversationId,
                hour: generated.hour,
                status: "skipped",
                checkinPreviewMessageId: null,
                monitorPreviewMessageId: monitorPreviewMessage.id,
                tentativeRoomOrderPreviewMessageId: null,
                error:
                  generatedMonitorFailureMessage === null
                    ? null
                    : MessageText.renderPlainText(generatedMonitorFailureMessage),
              } satisfies AutoCheckinTestConversationResult;
            }

            const checkinPreviewMessage = yield* botClient.sendMessage(
              generated.checkinConversationId,
              referencedMessagePayload(
                makeAutoCheckinTestEmbed({
                  title: "TEST RUN: Check-in message",
                  description: generatedInitialMessage,
                  fields: [
                    {
                      name: [MessageText.clientTerm("conversation", { casing: "sentence" })],
                      value: conversationName,
                      inline: true,
                    },
                    {
                      name: [MessageText.clientTerm("runDestination", { casing: "sentence" })],
                      value: conversationMentionValue(
                        payload.client,
                        payload.workspaceId,
                        generated.runningConversationId,
                      ),
                      inline: true,
                    },
                    {
                      name: [MessageText.clientTerm("checkinDestination", { casing: "sentence" })],
                      value: conversationMentionValue(
                        payload.client,
                        payload.workspaceId,
                        generated.checkinConversationId,
                      ),
                      inline: true,
                    },
                    { name: "Hour", value: globalThis.String(generated.hour), inline: true },
                  ],
                }),
              ),
            );

            const monitorPreviewMessage = yield* botClient.sendMessage(
              generated.runningConversationId,
              referencedMessagePayload(
                makeAutoCheckinTestEmbed({
                  title: "TEST RUN: Monitor auto check-in summary",
                  description: MessageText.lines(
                    generatedMonitorCheckinMessage,
                    ...Option.match(Option.fromNullishOr(generatedMonitorFailureMessage), {
                      onSome: (failure) => [[MessageText.subtle(failure)]],
                      onNone: () => [],
                    }),
                  ),
                  fields: [
                    {
                      name: [MessageText.clientTerm("conversation", { casing: "sentence" })],
                      value: conversationName,
                      inline: true,
                    },
                    {
                      name: [MessageText.clientTerm("runDestination", { casing: "sentence" })],
                      value: conversationMentionValue(
                        payload.client,
                        payload.workspaceId,
                        generated.runningConversationId,
                      ),
                      inline: true,
                    },
                    { name: "Hour", value: globalThis.String(generated.hour), inline: true },
                  ],
                }),
              ),
            );

            const tentativeRoomOrderPreviewMessage = shouldSendTentativeRoomOrder(
              generated.fillCount,
            )
              ? yield* Effect.gen(function* () {
                  const roomOrder = yield* roomOrderService.generate({
                    workspaceId: payload.workspaceId,
                    conversationId: generated.runningConversationId,
                    hour: generated.hour,
                  });
                  const roomOrderContent = MessageText.materializeGeneratedText(
                    payload.client,
                    payload.workspaceId,
                    roomOrder.content,
                  );

                  return yield* botClient.sendMessage(
                    generated.runningConversationId,
                    referencedMessagePayload(
                      makeAutoCheckinTestEmbed({
                        title: "TEST RUN: Tentative room order",
                        description: tentativeRoomOrderContent(roomOrderContent),
                        fields: [
                          {
                            name: [MessageText.clientTerm("conversation", { casing: "sentence" })],
                            value: conversationName,
                            inline: true,
                          },
                          {
                            name: [
                              MessageText.clientTerm("runDestination", { casing: "sentence" }),
                            ],
                            value: conversationMentionValue(
                              payload.client,
                              payload.workspaceId,
                              generated.runningConversationId,
                            ),
                            inline: true,
                          },
                          { name: "Hour", value: globalThis.String(generated.hour), inline: true },
                        ],
                      }),
                    ),
                  );
                })
              : null;

            return {
              conversationName,
              runningConversationId: generated.runningConversationId,
              checkinConversationId: generated.checkinConversationId,
              hour: generated.hour,
              status: "sent",
              checkinPreviewMessageId: checkinPreviewMessage.id,
              monitorPreviewMessageId: monitorPreviewMessage.id,
              tentativeRoomOrderPreviewMessageId: tentativeRoomOrderPreviewMessage?.id ?? null,
              error: null,
            } satisfies AutoCheckinTestConversationResult;
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.succeed({
                conversationName,
                runningConversationId,
                checkinConversationId,
                hour: autoCheckinTestHour,
                status: "failed",
                checkinPreviewMessageId: null,
                monitorPreviewMessageId: null,
                tentativeRoomOrderPreviewMessageId: null,
                error: Cause.pretty(cause),
              } satisfies AutoCheckinTestConversationResult),
            ),
          );
        };

        const conversations = yield* workspaceConfigService.getWorkspaceConversations(
          payload.workspaceId,
          true,
        );
        const conversationNames = uniqueConversationNames(conversations);

        const conversationResults: ReadonlyArray<AutoCheckinTestConversationResult> =
          yield* Effect.forEach(conversationNames, runTestConversation, {
            concurrency: autoCheckinConcurrency,
          });

        const sentCount = conversationResults.filter((result) => result.status === "sent").length;
        const skippedCount = conversationResults.filter(
          (result) => result.status === "skipped",
        ).length;
        const failedResults = conversationResults.filter((result) => result.status === "failed");
        const failedCount = failedResults.length;
        const firstFailure = failedResults[0];
        const summaryParts = [
          `Tested hour ${autoCheckinTestHour} across ${conversationResults.length} configured running conversation(s).`,
          `Sent: ${sentCount}. Skipped: ${skippedCount}. Failed: ${failedCount}.`,
          failedResults.length > 0
            ? `Failed conversations: ${failedResults.map((result) => result.conversationName).join(", ")}`
            : "No conversation failures.",
          ...(firstFailure === undefined
            ? []
            : [
                [
                  `First failure detail for ${firstFailure.conversationName}:`,
                  truncateAutoCheckinTestFailureDetail(firstFailure.error ?? "Unknown error"),
                ].join("\n"),
              ]),
        ];

        yield* updateAnchor(
          makeAnchorPayload(summaryParts.join("\n"), [
            { name: "Hour", value: globalThis.String(autoCheckinTestHour), inline: true },
            {
              name: "Conversations",
              value: globalThis.String(conversationResults.length),
              inline: true,
            },
            { name: "Failed", value: globalThis.String(failedCount), inline: true },
          ]),
        );

        return {
          workspaceId: payload.workspaceId,
          hour: autoCheckinTestHour,
          anchorMessageId: anchorMessage.id,
          anchorMessageConversationId: anchorMessage.conversation_id,
          conversationCount: conversationResults.length,
          sentCount,
          skippedCount,
          failedCount,
          conversations: conversationResults,
        } satisfies AutoCheckinTestDispatchResult;
      }),
      checkin: Effect.fn("DispatchService.checkin")(function* (
        payload: CheckinDispatchPayload,
        requester: DispatchRequester,
      ) {
        yield* Effect.annotateCurrentSpan({
          workspaceId: payload.workspaceId,
          conversationName: payload.conversationName,
          hour: payload.hour,
          "requester.accountId": requester.accountId,
          "requester.userId": requester.userId,
        });
        const createdByUserId = requester.userId;
        const generated = yield* checkinService.generate(payload);
        const monitorCheckinMessage = MessageText.materializeGeneratedText(
          payload.client,
          payload.workspaceId,
          generated.monitorCheckinMessage,
        );
        const initialMessage =
          generated.initialMessage === null
            ? null
            : MessageText.materializeGeneratedText(
                payload.client,
                payload.workspaceId,
                generated.initialMessage,
              );
        const messageSink = makeMessageSink(
          botClient,
          generated.runningConversationId,
          payload.interactionResponseToken,
        );
        const primaryMessage = yield* messageSink.sendPrimary(
          typeof payload.interactionResponseToken === "string"
            ? {
                content: [MessageText.text("Dispatching check-in...")],
                visibility: "ephemeral",
              }
            : {
                content: monitorCheckinMessage,
              },
        );

        let checkinMessage: DeliveredMessage | null = null;
        let tentativeRoomOrderMessage: {
          readonly messageId: string;
          readonly messageConversationId: string;
        } | null = null;

        if (initialMessage !== null) {
          checkinMessage = yield* botClient.sendMessage(generated.checkinConversationId, {
            content: initialMessage,
          });

          yield* messageCheckinService.persistMessageCheckin(checkinMessage.id, {
            data: {
              initialMessage,
              hour: generated.hour,
              runningConversationId: generated.runningConversationId,
              roleId: generated.roleId,
              workspaceId: payload.workspaceId,
              conversationId: generated.checkinConversationId,
              createdByUserId,
            },
            memberIds: generated.fillIds,
          });

          yield* botClient
            .updateMessage(checkinMessage.conversation_id, checkinMessage.id, {
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
            workspaceId: payload.workspaceId,
            runningConversationId: generated.runningConversationId,
            hour: generated.hour,
            fillCount: generated.fillCount,
            createdByUserId,
            client: payload.client,
            botClient,
            roomOrderService,
            messageRoomOrderService,
            logPrefix: "",
          });
        }

        const finalPrimaryMessage =
          typeof payload.interactionResponseToken === "string"
            ? checkinMessage === null
              ? yield* messageSink.updatePrimary(primaryMessage, {
                  content: monitorCheckinMessage,
                  visibility: "ephemeral",
                })
              : yield* messageSink
                  .updatePrimary(primaryMessage, {
                    content: monitorCheckinMessage,
                    visibility: "ephemeral",
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
          runningConversationId: generated.runningConversationId,
          checkinConversationId: generated.checkinConversationId,
          checkinMessageId: checkinMessage?.id ?? null,
          checkinMessageConversationId: checkinMessage?.conversation_id ?? null,
          primaryMessageId: finalPrimaryMessage.id,
          primaryMessageConversationId: finalPrimaryMessage.conversation_id,
          tentativeRoomOrderMessageId: tentativeRoomOrderMessage?.messageId ?? null,
          tentativeRoomOrderMessageConversationId:
            tentativeRoomOrderMessage?.messageConversationId ?? null,
        } satisfies CheckinDispatchResult;
      }),
      roomOrder: Effect.fn("DispatchService.roomOrder")(function* (
        payload: RoomOrderDispatchPayload,
        requester: DispatchRequester,
      ) {
        yield* Effect.annotateCurrentSpan({
          workspaceId: payload.workspaceId,
          conversationId: payload.conversationId,
          hour: payload.hour,
          "requester.accountId": requester.accountId,
          "requester.userId": requester.userId,
        });
        const createdByUserId = requester.userId;
        const generated = yield* roomOrderService.generate(payload);
        const content = MessageText.materializeGeneratedText(
          payload.client,
          payload.workspaceId,
          generated.content,
        );
        const messageSink = makeMessageSink(
          botClient,
          generated.runningConversationId,
          payload.interactionResponseToken,
        );
        const message = yield* messageSink.sendPrimary({
          content,
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
            workspaceId: payload.workspaceId,
            conversationId: message.conversation_id,
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
          messageConversationId: enabledMessage.conversation_id,
          hour: generated.hour,
          runningConversationId: generated.runningConversationId,
          rank: generated.rank,
        } satisfies RoomOrderDispatchResult;
      }),
      kickout: Effect.fn("DispatchService.kickout")(function* (
        payload: KickoutDispatchPayload,
        requester: DispatchRequester,
      ) {
        yield* Effect.annotateCurrentSpan({
          workspaceId: payload.workspaceId,
          conversationId: payload.conversationId,
          conversationName: payload.conversationName,
          hour: payload.hour,
          "requester.accountId": requester.accountId,
          "requester.userId": requester.userId,
        });
        const updateInteraction = (content: MessageTextInput) =>
          typeof payload.interactionResponseToken === "string"
            ? botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
                content: textValue(content),
                allowedMentions: "none",
              })
            : Effect.void;
        const date = yield* DateTime.now;
        const minute = DateTime.getPart(date, "minute");

        if (minute >= 40) {
          yield* updateInteraction("Cannot kick out until next hour starts");
          return {
            workspaceId: payload.workspaceId,
            runningConversationId: payload.conversationId ?? "",
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
              (yield* sheetService.getEventConfig(payload.workspaceId)).startTime,
              pipe(DateTime.addDuration(date, "20 minutes"), DateTime.startOf("hour")),
            ),
            Duration.toHours,
            Math.floor,
            (value) => value + 1,
          );
        const maybeRunningConversation =
          typeof payload.conversationName === "string"
            ? yield* workspaceConfigService.getWorkspaceConversationByName({
                workspaceId: payload.workspaceId,
                conversationName: payload.conversationName,
                running: true,
              })
            : yield* workspaceConfigService.getWorkspaceConversationById({
                workspaceId: payload.workspaceId,
                conversationId: payload.conversationId ?? "",
                running: true,
              });
        const runningConversation = yield* Option.match(maybeRunningConversation, {
          onSome: Effect.succeed,
          onNone: () =>
            updateInteraction("Cannot kick out, running conversation not found").pipe(
              Effect.andThen(
                Effect.fail(
                  markInteractionFailureHandled(
                    makeArgumentError("Cannot kick out, running conversation not found"),
                  ),
                ),
              ),
            ),
        });
        const conversationName = yield* Option.match(runningConversation.name, {
          onSome: Effect.succeed,
          onNone: () =>
            updateInteraction("Cannot kick out, conversation has no name").pipe(
              Effect.andThen(
                Effect.fail(
                  markInteractionFailureHandled(
                    makeArgumentError("Cannot kick out, conversation has no name"),
                  ),
                ),
              ),
            ),
        });
        const runningConversationId = runningConversation.conversationId;
        const roleId = Option.getOrNull(runningConversation.roleId);

        if (roleId === null) {
          yield* updateInteraction("No role configured for this conversation");
          return {
            workspaceId: payload.workspaceId,
            runningConversationId,
            hour,
            roleId: null,
            removedMemberIds: [],
            status: "missingRole",
          } satisfies KickoutDispatchResult;
        }

        const scheduleItem = (yield* scheduleService.conversationPopulatedMonitorSchedules(
          payload.workspaceId,
          conversationName,
        )).find((schedule) => Option.contains(schedule.hour, hour));
        if (scheduleItem === undefined) {
          yield* Effect.logWarning("Skipping kickout because no schedule was found").pipe(
            Effect.annotateLogs({
              workspaceId: payload.workspaceId,
              runningConversationId,
              conversationName,
              hour,
            }),
          );
          yield* updateInteraction(
            "No schedule found for this conversation and hour; no players kicked out",
          );
          return {
            workspaceId: payload.workspaceId,
            runningConversationId,
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
        const members = yield* botClient.getMembersForParent(payload.workspaceId);
        const removedMemberIds = members
          .filter((member) => member.value.roles.includes(roleId))
          .map((member) => member.value.user.id)
          .filter((memberId) => !fillIds.includes(memberId));

        const removalResults = yield* Effect.forEach(removedMemberIds, (memberId) =>
          botClient.removeWorkspaceMemberRole(payload.workspaceId, memberId, roleId).pipe(
            Effect.as({ memberId, removed: true as const }),
            Effect.catchCause((cause) =>
              Effect.logError("Failed to remove kickout role from member").pipe(
                Effect.annotateLogs({
                  workspaceId: payload.workspaceId,
                  runningConversationId,
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
            ? MessageText.parts(
                MessageText.text("Kicked out "),
                ...actualRemovedIds.flatMap((userId, index) =>
                  MessageText.parts(
                    index === 0 ? undefined : MessageText.text(" "),
                    MessageText.userMention(userId),
                  ),
                ),
              )
            : [MessageText.text("No players to kick out")],
        );

        return {
          workspaceId: payload.workspaceId,
          runningConversationId,
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
          workspaceId: payload.workspaceId,
          conversationId: payload.conversationId,
          day: payload.day,
          "requester.accountId": requester.accountId,
          "requester.userId": requester.userId,
        });
        const message = yield* botClient.sendMessage(payload.conversationId, {
          content: [
            MessageText.text(
              `Press the button below to get the current open slots for day ${payload.day}`,
            ),
          ],
          components: [slotActionRow()],
        });

        yield* messageSlotService
          .upsertMessageSlotData(message.id, {
            day: payload.day,
            workspaceId: payload.workspaceId,
            conversationId: payload.conversationId,
            createdByUserId: requester.userId,
          })
          .pipe(
            Effect.catchCause((cause) =>
              botClient.deleteMessage(payload.conversationId, message.id).pipe(
                Effect.catchCause(() => Effect.void),
                Effect.andThen(Effect.failCause(cause)),
              ),
            ),
          );

        yield* botClient
          .updateOriginalInteractionResponse(payload.interactionResponseToken, {
            content: [MessageText.text("Slot button sent!")],
            visibility: "ephemeral",
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Failed to update slot button interaction response").pipe(
                Effect.annotateLogs({
                  workspaceId: payload.workspaceId,
                  conversationId: payload.conversationId,
                  messageId: message.id,
                }),
                Effect.andThen(Effect.logError(cause)),
              ),
            ),
          );

        return {
          messageId: message.id,
          messageConversationId: message.conversation_id,
          day: payload.day,
        } satisfies SlotButtonDispatchResult;
      }),
      slotList: Effect.fn("DispatchService.slotList")(function* (payload: SlotListDispatchPayload) {
        yield* Effect.annotateCurrentSpan({
          workspaceId: payload.workspaceId,
          day: payload.day,
          messageType: payload.messageType,
        });
        const slotEmbeds = yield* makeSlotEmbeds(payload.workspaceId, payload.day);

        yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
          embeds: [...slotEmbeds, makeWebScheduleEmbed()],
        });

        return {
          workspaceId: payload.workspaceId,
          day: payload.day,
          messageType: payload.messageType,
        } satisfies SlotListDispatchResult;
      }),
      conversationListConfig: Effect.fn("DispatchService.conversationListConfig")(function* (
        payload: ConversationListConfigDispatchPayload,
      ) {
        const maybeConfig = yield* workspaceConfigService.getWorkspaceConversationById({
          workspaceId: payload.workspaceId,
          conversationId: payload.conversationId,
        });
        const config = yield* Option.match(maybeConfig, {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(
              makeArgumentError(
                `Cannot list conversation config, conversation ${payload.conversationId} is not configured`,
              ),
            ),
        });

        yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
          embeds: [
            makeEmbed({
              title: [MessageText.text("Config for this "), MessageText.clientTerm("conversation")],
              fields: formatConversationConfigFields({
                client: payload.client,
                workspaceId: payload.workspaceId,
                name: config.name,
                running: config.running,
                roleId: config.roleId,
                checkinConversationId: config.checkinConversationId,
              }),
            }),
          ],
        });

        return {
          workspaceId: payload.workspaceId,
          conversationId: payload.conversationId,
        } satisfies ConversationListConfigDispatchResult;
      }),
      conversationSet: Effect.fn("DispatchService.conversationSet")(function* (
        payload: ConversationSetDispatchPayload,
      ) {
        const config = yield* workspaceConfigService.upsertWorkspaceConversationConfig(
          payload.workspaceId,
          payload.conversationId,
          {
            ...(payload.running === undefined ? {} : { running: payload.running }),
            ...(payload.name === undefined ? {} : { name: payload.name }),
            ...(payload.roleId === undefined ? {} : { roleId: payload.roleId }),
            ...(payload.checkinConversationId === undefined
              ? {}
              : { checkinConversationId: payload.checkinConversationId }),
          },
        );

        yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
          embeds: [
            makeEmbed({
              title: "Success!",
              description: [
                ...conversationMentionValue(
                  payload.client,
                  payload.workspaceId,
                  payload.conversationId,
                ),
                MessageText.text(" configuration updated"),
              ],
              fields: formatConversationConfigFields({
                client: payload.client,
                workspaceId: payload.workspaceId,
                name: config.name,
                running: config.running,
                roleId: config.roleId,
                checkinConversationId: config.checkinConversationId,
              }),
            }),
          ],
        });

        return {
          workspaceId: payload.workspaceId,
          conversationId: payload.conversationId,
        } satisfies ConversationSetDispatchResult;
      }),
      conversationUnset: Effect.fn("DispatchService.conversationUnset")(function* (
        payload: ConversationUnsetDispatchPayload,
      ) {
        const config = yield* workspaceConfigService.upsertWorkspaceConversationConfig(
          payload.workspaceId,
          payload.conversationId,
          {
            ...(payload.running ? { running: null } : {}),
            ...(payload.name ? { name: null } : {}),
            ...(payload.role ? { roleId: null } : {}),
            ...(payload.checkinConversation ? { checkinConversationId: null } : {}),
          },
        );

        yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
          embeds: [
            makeEmbed({
              title: "Success!",
              description: [
                ...conversationMentionValue(
                  payload.client,
                  payload.workspaceId,
                  payload.conversationId,
                ),
                MessageText.text(" configuration updated"),
              ],
              fields: formatConversationConfigFields({
                client: payload.client,
                workspaceId: payload.workspaceId,
                name: config.name,
                running: config.running,
                roleId: config.roleId,
                checkinConversationId: config.checkinConversationId,
              }),
            }),
          ],
        });

        return {
          workspaceId: payload.workspaceId,
          conversationId: payload.conversationId,
        } satisfies ConversationUnsetDispatchResult;
      }),
      workspaceListConfig: Effect.fn("DispatchService.workspaceListConfig")(function* (
        payload: WorkspaceListConfigDispatchPayload,
      ) {
        const workspaceDisplayName = yield* resolveWorkspaceDisplayName(
          botClient,
          payload.workspaceId,
        );
        const maybeWorkspaceConfig = yield* workspaceConfigService.getWorkspaceConfig(
          payload.workspaceId,
        );
        const workspaceConfig = yield* Option.match(maybeWorkspaceConfig, {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(
              makeArgumentError(`Cannot list config for workspace ${payload.workspaceId}`),
            ),
        });
        const monitorRoles = yield* workspaceConfigService.getWorkspaceMonitorRoles(
          payload.workspaceId,
        );
        const sheetId = Option.match(workspaceConfig.sheetId, {
          onSome: escapeMarkdown,
          onNone: () => "None",
        });

        yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
          embeds: [
            makeEmbed({
              title: [MessageText.text("Config for "), ...workspaceDisplayName],
              description: MessageText.lines(
                [MessageText.text(`Sheet id: ${sheetId}`)],
                [
                  MessageText.text(
                    `Auto check-in: ${
                      isAutoCheckinEnabled(workspaceConfig.autoCheckin) ? "Enabled" : "Disabled"
                    }`,
                  ),
                ],
                [
                  MessageText.clientTerm("monitorRole", {
                    form: "plural",
                    casing: "sentence",
                  }),
                  MessageText.text(": "),
                  ...(monitorRoles.length > 0
                    ? MessageText.joinText(
                        monitorRoles.map((role) =>
                          roleMentionValue(payload.client, payload.workspaceId, role.roleId),
                        ),
                        ", ",
                      )
                    : [MessageText.text("None")]),
                ],
              ),
            }),
          ],
        });

        return {
          workspaceId: payload.workspaceId,
          monitorRoleCount: monitorRoles.length,
        } satisfies WorkspaceListConfigDispatchResult;
      }),
      workspaceAddMonitorRole: Effect.fn("DispatchService.workspaceAddMonitorRole")(function* (
        payload: WorkspaceAddMonitorRoleDispatchPayload,
      ) {
        const workspaceDisplayName = yield* resolveWorkspaceDisplayName(
          botClient,
          payload.workspaceId,
        );
        yield* workspaceConfigService.addWorkspaceMonitorRole(payload.workspaceId, payload.roleId);
        yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
          embeds: [
            makeEmbed({
              title: "Success!",
              description: [
                ...roleMentionValue(payload.client, payload.workspaceId, payload.roleId),
                MessageText.text(" is now a "),
                MessageText.clientTerm("monitorRole"),
                MessageText.text(" for "),
                ...workspaceDisplayName,
              ],
            }),
          ],
        });
        return {
          workspaceId: payload.workspaceId,
          roleId: payload.roleId,
        } satisfies WorkspaceAddMonitorRoleDispatchResult;
      }),
      workspaceRemoveMonitorRole: Effect.fn("DispatchService.workspaceRemoveMonitorRole")(
        function* (payload: WorkspaceRemoveMonitorRoleDispatchPayload) {
          const workspaceDisplayName = yield* resolveWorkspaceDisplayName(
            botClient,
            payload.workspaceId,
          );
          yield* workspaceConfigService.removeWorkspaceMonitorRole(
            payload.workspaceId,
            payload.roleId,
          );
          yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
            embeds: [
              makeEmbed({
                title: "Success!",
                description: [
                  ...roleMentionValue(payload.client, payload.workspaceId, payload.roleId),
                  MessageText.text(" is no longer a "),
                  MessageText.clientTerm("monitorRole"),
                  MessageText.text(" for "),
                  ...workspaceDisplayName,
                ],
              }),
            ],
          });
          return {
            workspaceId: payload.workspaceId,
            roleId: payload.roleId,
          } satisfies WorkspaceRemoveMonitorRoleDispatchResult;
        },
      ),
      workspaceSetSheet: Effect.fn("DispatchService.workspaceSetSheet")(function* (
        payload: WorkspaceSetSheetDispatchPayload,
      ) {
        const workspaceDisplayName = yield* resolveWorkspaceDisplayName(
          botClient,
          payload.workspaceId,
        );
        yield* workspaceConfigService.upsertWorkspaceConfig(payload.workspaceId, {
          sheetId: payload.sheetId,
        });
        yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
          embeds: [
            makeEmbed({
              title: "Success!",
              description: [
                MessageText.text("Sheet id for "),
                ...workspaceDisplayName,
                MessageText.text(` is now set to ${escapeMarkdown(payload.sheetId)}`),
              ],
            }),
          ],
        });
        return {
          workspaceId: payload.workspaceId,
          sheetId: payload.sheetId,
        } satisfies WorkspaceSetSheetDispatchResult;
      }),
      workspaceSetAutoCheckin: Effect.fn("DispatchService.workspaceSetAutoCheckin")(function* (
        payload: WorkspaceSetAutoCheckinDispatchPayload,
      ) {
        const workspaceDisplayName = yield* resolveWorkspaceDisplayName(
          botClient,
          payload.workspaceId,
        );
        const workspaceConfig = yield* workspaceConfigService.upsertWorkspaceConfig(
          payload.workspaceId,
          {
            autoCheckin: payload.autoCheckin,
          },
        );
        const autoCheckin = isAutoCheckinEnabled(workspaceConfig.autoCheckin);
        yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
          embeds: [
            makeEmbed({
              title: "Success!",
              description: [
                MessageText.text("Auto check-in for "),
                ...workspaceDisplayName,
                MessageText.text(` is now ${autoCheckin ? "enabled" : "disabled"}.`),
              ],
            }),
          ],
        });
        return {
          workspaceId: payload.workspaceId,
          autoCheckin,
        } satisfies WorkspaceSetAutoCheckinDispatchResult;
      }),
      teamList: Effect.fn("DispatchService.teamList")(function* (payload: TeamListDispatchPayload) {
        const teams = yield* playerService.getTeamsByIds(payload.workspaceId, [
          payload.targetUserId,
        ]);
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

        yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
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
          workspaceId: payload.workspaceId,
          targetUserId: payload.targetUserId,
          teamCount: formattedTeams.length,
        } satisfies TeamListDispatchResult;
      }),
      scheduleList: Effect.fn("DispatchService.scheduleList")(function* (
        payload: ScheduleListDispatchPayload,
      ) {
        const { schedule } = yield* scheduleService.dayPlayerSchedule(
          payload.workspaceId,
          payload.day,
          payload.targetUserId,
        );
        yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
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
          workspaceId: payload.workspaceId,
          day: payload.day,
          targetUserId: payload.targetUserId,
          invisible: schedule.invisible,
        } satisfies ScheduleListDispatchResult;
      }),
      screenshot: Effect.fn("DispatchService.screenshot")(function* (
        payload: ScreenshotDispatchPayload,
      ) {
        const screenshot = yield* screenshotService.getScreenshot(
          payload.workspaceId,
          payload.conversationName,
          payload.day,
        );
        yield* botClient.updateOriginalInteractionResponseWithFiles(
          payload.interactionResponseToken,
          {},
          [
            {
              name: "screenshot.png",
              contentType: "image/png",
              content: screenshot,
            },
          ],
        );

        return {
          workspaceId: payload.workspaceId,
          conversationName: payload.conversationName,
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

          yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
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
              .updateOriginalInteractionResponse(payload.interactionResponseToken, {
                content: "Failed to check service status. Please try again.",
              })
              .pipe(
                Effect.catch(() => Effect.void),
                Effect.andThen(Effect.fail(markInteractionFailureHandled(error))),
              ),
          ),
        );
      }),
      workspaceWelcome: Effect.fn("DispatchService.workspaceWelcome")(function* (
        payload: WorkspaceWelcomeDispatchPayload,
      ) {
        yield* Effect.annotateCurrentSpan({
          workspaceId: payload.workspaceId,
          workspaceName: payload.workspaceName,
          systemConversationId: payload.systemConversationId,
        });

        const messagePayload = {
          embeds: [welcomeEmbed()],
        } satisfies MessagePayload;

        const sentMessage = yield* sendWorkspaceAnnouncementWithWelcomeHeuristic({
          botClient,
          workspaceId: payload.workspaceId,
          systemConversationId: payload.systemConversationId,
          messagePayload,
          logLabel: "workspace welcome message",
        });

        return {
          workspaceId: payload.workspaceId,
          conversationId: sentMessage.conversation_id,
          messageId: sentMessage.id,
        } satisfies WorkspaceWelcomeDispatchResult;
      }),
      updateAnnouncement: Effect.fn("DispatchService.updateAnnouncement")(function* (
        payload: UpdateAnnouncementDispatchPayload,
      ) {
        yield* Effect.annotateCurrentSpan({
          workspaceId: payload.workspaceId,
          workspaceName: payload.workspaceName,
          announcementId: payload.announcement.id,
          systemConversationId: payload.systemConversationId,
        });

        const featureFlags = yield* workspaceConfigService.getWorkspaceFeatureFlags(
          payload.workspaceId,
        );
        if (!featureFlags.some((flag) => flag.flagName === updateAnnouncementsFeatureFlag)) {
          return {
            workspaceId: payload.workspaceId,
            announcementId: payload.announcement.id,
            status: "skipped_not_gated",
            announcementConversationId: null,
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
        const claim = yield* workspaceConfigService.claimWorkspaceUpdateAnnouncementDelivery({
          workspaceId: payload.workspaceId,
          announcementId: payload.announcement.id,
          publishedAt,
          claimToken,
        });
        if (claim.status === "already_delivered" && Option.isSome(claim.delivery)) {
          return {
            workspaceId: payload.workspaceId,
            announcementId: payload.announcement.id,
            status: "skipped_already_delivered",
            announcementConversationId: claim.delivery.value.conversationId,
            announcementMessageId: claim.delivery.value.messageId,
          } satisfies UpdateAnnouncementDispatchResult;
        }

        if (claim.status !== "claimed") {
          return {
            workspaceId: payload.workspaceId,
            announcementId: payload.announcement.id,
            status: "skipped_already_delivered",
            announcementConversationId: null,
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

        const sentMessage = yield* sendWorkspaceAnnouncementWithWelcomeHeuristic({
          botClient,
          workspaceId: payload.workspaceId,
          systemConversationId: payload.systemConversationId,
          messagePayload,
          logLabel: "update announcement",
        }).pipe(
          Effect.catchCause((cause) =>
            workspaceConfigService
              .releaseWorkspaceUpdateAnnouncementDeliveryClaim({
                workspaceId: payload.workspaceId,
                announcementId: payload.announcement.id,
                claimToken,
              })
              .pipe(
                Effect.catchCause(() => Effect.void),
                Effect.andThen(Effect.failCause(cause)),
              ),
          ),
        );

        yield* workspaceConfigService.recordWorkspaceUpdateAnnouncementDelivery({
          workspaceId: payload.workspaceId,
          announcementId: payload.announcement.id,
          publishedAt,
          deliveredAt,
          conversationId: sentMessage.conversation_id,
          messageId: sentMessage.id,
        });

        return {
          workspaceId: payload.workspaceId,
          announcementId: payload.announcement.id,
          status: "sent",
          announcementConversationId: sentMessage.conversation_id,
          announcementMessageId: sentMessage.id,
        } satisfies UpdateAnnouncementDispatchResult;
      }),
      serviceAddWorkspaceFeatureFlag: Effect.fn("DispatchService.serviceAddWorkspaceFeatureFlag")(
        function* (payload: ServiceWorkspaceFeatureFlagDispatchPayload) {
          yield* Effect.annotateCurrentSpan({
            workspaceId: payload.workspaceId,
            flagName: payload.flagName,
            systemConversationId: payload.systemConversationId,
          });

          const flag = yield* workspaceConfigService.addWorkspaceFeatureFlag(
            payload.workspaceId,
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
          const sentMessage = yield* sendWorkspaceAnnouncementWithWelcomeHeuristic({
            botClient,
            workspaceId: payload.workspaceId,
            systemConversationId: payload.systemConversationId,
            messagePayload,
            logLabel: "workspace feature flag enlistment announcement",
          }).pipe(
            Effect.map(Option.some),
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to announce workspace feature flag enlistment").pipe(
                Effect.annotateLogs({
                  workspaceId: payload.workspaceId,
                  flagName: flag.flagName,
                }),
                Effect.andThen(Effect.logDebug(cause)),
                Effect.as(Option.none<DeliveredMessage>()),
              ),
            ),
          );

          return {
            workspaceId: payload.workspaceId,
            flagName: flag.flagName,
            announcementConversationId: Option.match(sentMessage, {
              onSome: (message) => message.conversation_id,
              onNone: () => null,
            }),
            announcementMessageId: Option.match(sentMessage, {
              onSome: (message) => message.id,
              onNone: () => null,
            }),
          } satisfies ServiceWorkspaceFeatureFlagDispatchResult;
        },
      ),
      serviceRemoveWorkspaceFeatureFlag: Effect.fn(
        "DispatchService.serviceRemoveWorkspaceFeatureFlag",
      )(function* (payload: ServiceWorkspaceFeatureFlagDispatchPayload) {
        yield* Effect.annotateCurrentSpan({
          workspaceId: payload.workspaceId,
          flagName: payload.flagName,
          systemConversationId: payload.systemConversationId,
        });

        const flag = yield* workspaceConfigService.removeWorkspaceFeatureFlag(
          payload.workspaceId,
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
        const sentMessage = yield* sendWorkspaceAnnouncementWithWelcomeHeuristic({
          botClient,
          workspaceId: payload.workspaceId,
          systemConversationId: payload.systemConversationId,
          messagePayload,
          logLabel: "workspace feature flag delistment announcement",
        }).pipe(
          Effect.map(Option.some),
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to announce workspace feature flag delistment").pipe(
              Effect.annotateLogs({
                workspaceId: payload.workspaceId,
                flagName: flag.flagName,
              }),
              Effect.andThen(Effect.logDebug(cause)),
              Effect.as(Option.none<DeliveredMessage>()),
            ),
          ),
        );

        return {
          workspaceId: payload.workspaceId,
          flagName: flag.flagName,
          announcementConversationId: Option.match(sentMessage, {
            onSome: (message) => message.conversation_id,
            onNone: () => null,
          }),
          announcementMessageId: Option.match(sentMessage, {
            onSome: (message) => message.id,
            onNone: () => null,
          }),
        } satisfies ServiceWorkspaceFeatureFlagDispatchResult;
      }),
      slotOpenButton: Effect.fn("DispatchService.slotOpenButton")(function* (
        payload: SlotOpenButtonPayload,
        messageSlot: MessageSlot,
      ) {
        yield* Effect.annotateCurrentSpan({
          messageId: payload.messageId,
          day: messageSlot.day,
        });
        const workspaceId = Option.getOrUndefined(messageSlot.workspaceId);
        const messageConversationId = Option.getOrUndefined(messageSlot.conversationId);
        if (workspaceId === undefined) {
          yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
            content: "This slot message is not registered to a server.",
          });
          return yield* Effect.fail(
            markInteractionFailureHandled(
              makeArgumentError("Cannot handle slot button, message workspace is not registered"),
            ),
          );
        }

        if (messageConversationId === undefined) {
          yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
            content: "This slot message conversation is not registered.",
          });
          return yield* Effect.fail(
            markInteractionFailureHandled(
              makeArgumentError(
                "Cannot handle slot button, message conversation is not registered",
              ),
            ),
          );
        }

        const slotEmbeds = yield* makeSlotEmbeds(workspaceId, messageSlot.day);

        yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
          embeds: slotEmbeds,
        });

        return {
          messageId: payload.messageId,
          workspaceId,
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
            .updateOriginalInteractionResponse(payload.interactionResponseToken, {
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
        const messageConversationId = yield* Option.match(messageCheckinData.conversationId, {
          onSome: Effect.succeed,
          onNone: () =>
            failCheckinInteraction(
              "This check-in message conversation is not registered.",
              "Cannot handle check-in button, message conversation is not registered",
            ),
        });
        const workspaceId = yield* Option.match(messageCheckinData.workspaceId, {
          onSome: Effect.succeed,
          onNone: () =>
            failCheckinInteraction(
              "This check-in message workspace is not registered.",
              "Cannot handle check-in button, message workspace is not registered",
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
                .updateOriginalInteractionResponse(payload.interactionResponseToken, {
                  content: "We could not check you in. Please try again.",
                })
                .pipe(Effect.andThen(Effect.fail(markInteractionFailureHandled(error)))),
            ),
          );
        const isFirstCheckin = Option.contains(
          Option.map(checkedInMember.checkinAt, (value) => Number(DateTime.toEpochMillis(value))),
          checkinAt,
        );

        yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
          content: isFirstCheckin
            ? "You have been checked in!"
            : "You have already been checked in!",
        });

        const checkedInMembers = yield* messageCheckinService.getMessageCheckinMembers(
          payload.messageId,
        );
        const content = renderCheckedInContent(messageCheckinData.initialMessage, checkedInMembers);

        yield* botClient
          .updateMessage(messageConversationId, payload.messageId, {
            content,
            components: [checkinActionRow()],
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Failed to update check-in message after button check-in").pipe(
                Effect.annotateLogs({
                  workspaceId,
                  messageId: payload.messageId,
                  messageConversationId,
                  accountId,
                }),
                Effect.andThen(Effect.logError(cause)),
              ),
            ),
          );

        if (isFirstCheckin) {
          yield* botClient
            .sendMessage(messageCheckinData.runningConversationId, {
              content: [MessageText.userMention(accountId), MessageText.text(" has checked in!")],
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Failed to announce button check-in").pipe(
                  Effect.annotateLogs({
                    workspaceId,
                    accountId,
                    conversationId: messageCheckinData.runningConversationId,
                    messageId: payload.messageId,
                  }),
                  Effect.andThen(Effect.logError(cause)),
                ),
              ),
            );
        }

        if (Option.isSome(messageCheckinData.roleId)) {
          const roleId = messageCheckinData.roleId.value;
          // Re-apply the role on repeat clicks to repair missed adapter side effects.
          yield* botClient.addWorkspaceMemberRole(workspaceId, accountId, roleId).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Failed to add check-in role after button check-in").pipe(
                Effect.annotateLogs({
                  workspaceId,
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
          messageConversationId,
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
    Layer.provide(Layer.mergeAll(ClientDeliveryClient.layer, SheetApisClient.layer)),
  );
}
