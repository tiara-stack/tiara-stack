import { describe, expect, it } from "@effect/vitest";
import { Cause, DateTime, Effect, Exit, Option } from "effect";
import { TestClock } from "effect/testing";
import { formatTentativeRoomOrderContent } from "sheet-ingress-api/discordComponents";
import type {
  AutoCheckinTestDispatchPayload,
  ChannelListConfigDispatchPayload,
  ChannelSetDispatchPayload,
  ChannelUnsetDispatchPayload,
  GuildWelcomeDispatchPayload,
  KickoutDispatchPayload,
  ScheduleListDispatchPayload,
  ServiceGuildFeatureFlagDispatchPayload,
  ServerAddMonitorRoleDispatchPayload,
  ServerListConfigDispatchPayload,
  ServerRemoveMonitorRoleDispatchPayload,
  ServerSetAutoCheckinDispatchPayload,
  ServerSetSheetDispatchPayload,
  ScreenshotDispatchPayload,
  ServiceStatusDispatchPayload,
  SlotButtonDispatchPayload,
  SlotOpenButtonPayload,
  TeamListDispatchPayload,
  UpdateAnnouncementDispatchPayload,
} from "sheet-ingress-api/handlers/dispatch/schema";
import {
  GuildChannelConfig,
  GuildConfig,
  GuildFeatureFlag,
  GuildConfigMonitorRole,
  GuildUpdateAnnouncementDelivery,
} from "sheet-ingress-api/schemas/guildConfig";
import { MessageSlot } from "sheet-ingress-api/schemas/messageSlot";
import {
  MessageRoomOrder,
  MessageRoomOrderEntry,
  MessageRoomOrderRange,
} from "sheet-ingress-api/schemas/messageRoomOrder";
import {
  Player,
  PopulatedSchedule,
  PopulatedSchedulePlayer,
  Team,
} from "sheet-ingress-api/schemas/sheet";
import { EventConfig } from "sheet-ingress-api/schemas/sheetConfig";
import { DispatchService, IngressBotClient, SheetApisClient } from "@/services";

const guildWelcomePayload: GuildWelcomeDispatchPayload = {
  dispatchRequestId: "discord-guild-create:guild-1:2026-05-31T00:00:00.000Z",
  guildId: "guild-1",
  guildName: "Guild One",
  joinedAt: "2026-05-31T00:00:00.000Z",
  systemChannelId: "system-channel",
};

const slotButtonPayload: SlotButtonDispatchPayload = {
  dispatchRequestId: "dispatch-slot-button",
  guildId: "guild-1",
  channelId: "channel-1",
  day: 2,
  interactionToken: "interaction-token",
  interactionDeadlineEpochMs: 1_700_000_000_000,
};

const slotOpenButtonPayload: SlotOpenButtonPayload = {
  messageId: "message-1",
  interactionToken: "interaction-token",
  interactionDeadlineEpochMs: 1_700_000_000_000,
};

const serviceStatusPayload: ServiceStatusDispatchPayload = {
  dispatchRequestId: "dispatch-service-status",
  interactionToken: "interaction-token",
  interactionDeadlineEpochMs: 1_700_000_000_000,
};

const serviceGuildFeatureFlagPayload: ServiceGuildFeatureFlagDispatchPayload = {
  dispatchRequestId: "dispatch-service-add-guild-feature-flag",
  guildId: "guild-1",
  flagName: "beta-feature",
  systemChannelId: "system-channel",
};

const updateAnnouncementPayload: UpdateAnnouncementDispatchPayload = {
  dispatchRequestId: "discord-update-announcement:guild-1:update-announcements-2026-06-05",
  guildId: "guild-1",
  guildName: "Guild One",
  joinedAt: "2026-06-04T16:59:59.999Z",
  systemChannelId: "system-channel",
  announcement: {
    id: "update-announcements-2026-06-05",
    publishedAt: "2026-06-04T17:00:00.000Z",
    title: "Update announcements",
    description: "Update announcement description",
    color: 0x5865f2,
  },
};

const screenshotPayload: ScreenshotDispatchPayload = {
  dispatchRequestId: "dispatch-screenshot",
  guildId: "guild-1",
  channelName: "main",
  day: 2,
  interactionToken: "interaction-token",
  interactionDeadlineEpochMs: 1_700_000_000_000,
};

const commandBase = {
  interactionToken: "interaction-token",
  interactionDeadlineEpochMs: 1_700_000_000_000,
};

const autoCheckinTestPayload: AutoCheckinTestDispatchPayload = {
  ...commandBase,
  dispatchRequestId: "dispatch-auto-checkin-test",
  guildId: "guild-1",
  anchorChannelId: "anchor-channel-1",
};

const channelConfigPayload = {
  ...commandBase,
  dispatchRequestId: "dispatch-channel-config",
  guildId: "guild-1",
  channelId: "channel-1",
};

const messageSlot = new MessageSlot({
  messageId: slotOpenButtonPayload.messageId,
  day: 2,
  guildId: Option.some("guild-1"),
  messageChannelId: Option.some("channel-1"),
  createdByUserId: Option.some("discord-user-1"),
  createdAt: Option.none(),
  updatedAt: Option.none(),
  deletedAt: Option.none(),
});

const requester = {
  accountId: "account-1",
  userId: "discord-user-1",
};

const firstEmbedDescription = (payload: unknown): string | null | undefined =>
  (payload as { embeds?: ReadonlyArray<{ description?: string | null }> }).embeds?.[0]?.description;

const firstEmbedFields = (
  payload: unknown,
): ReadonlyArray<{ readonly name: string; readonly value: string; readonly inline?: boolean }> =>
  (
    payload as {
      embeds?: ReadonlyArray<{ fields?: ReadonlyArray<{ name: string; value: string }> }>;
    }
  ).embeds?.[0]?.fields ?? [];

const makeSchedule = (hour: number, fillIds: ReadonlyArray<string>) =>
  new PopulatedSchedule({
    channel: "main",
    day: 1,
    visible: true,
    hour: Option.some(hour),
    hourWindow: Option.none(),
    fills: Array.from({ length: 5 }, (_value, index) =>
      Option.fromNullishOr(
        fillIds[index] === undefined
          ? undefined
          : new PopulatedSchedulePlayer({
              player: new Player({
                index,
                id: fillIds[index],
                name: fillIds[index],
              }),
              enc: false,
            }),
      ),
    ),
    overfills: [],
    standbys: [],
    runners: [],
    monitor: Option.none(),
  });

const unexpected = (name: string) => () => Effect.die(`Unexpected Sheet API call: ${name}`);

const makeSheetApisClient = (services: Record<string, unknown>) =>
  ({
    get: () =>
      new Proxy(services, {
        get(target, group: string) {
          if (group in target) {
            return target[group];
          }

          return new Proxy(
            {},
            {
              get: (_service, method: string) => unexpected(`${group}.${method}`),
            },
          );
        },
      }),
  }) as never;

const makeMessageSlotSheetApisClient = (
  upsertMessageSlotData: (args: unknown) => Effect.Effect<unknown, unknown>,
) =>
  makeSheetApisClient({
    messageSlot: {
      upsertMessageSlotData,
    },
  });

const runSlotButton = (
  botClient: typeof IngressBotClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
) =>
  Effect.gen(function* () {
    const service = yield* DispatchService.make;
    return yield* service.slotButton(slotButtonPayload, requester);
  }).pipe(
    Effect.provideService(IngressBotClient, botClient),
    Effect.provideService(SheetApisClient, sheetApisClient),
  );

const runSlotOpenButton = (
  botClient: typeof IngressBotClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
) =>
  Effect.gen(function* () {
    const service = yield* DispatchService.make;
    return yield* service.slotOpenButton(slotOpenButtonPayload, messageSlot);
  }).pipe(
    Effect.provideService(IngressBotClient, botClient),
    Effect.provideService(SheetApisClient, sheetApisClient),
  );

const runServiceStatus = (
  botClient: typeof IngressBotClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
) =>
  Effect.gen(function* () {
    const service = yield* DispatchService.make;
    return yield* service.serviceStatus(serviceStatusPayload);
  }).pipe(
    Effect.provideService(IngressBotClient, botClient),
    Effect.provideService(SheetApisClient, sheetApisClient),
  );

const runGuildWelcome = (
  botClient: typeof IngressBotClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
) =>
  Effect.gen(function* () {
    const service = yield* DispatchService.make;
    return yield* service.guildWelcome(guildWelcomePayload);
  }).pipe(
    Effect.provideService(IngressBotClient, botClient),
    Effect.provideService(SheetApisClient, sheetApisClient),
  );

const runServiceAddGuildFeatureFlag = (
  botClient: typeof IngressBotClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
  payload: ServiceGuildFeatureFlagDispatchPayload = serviceGuildFeatureFlagPayload,
) =>
  Effect.gen(function* () {
    const service = yield* DispatchService.make;
    return yield* service.serviceAddGuildFeatureFlag(payload);
  }).pipe(
    Effect.provideService(IngressBotClient, botClient),
    Effect.provideService(SheetApisClient, sheetApisClient),
  );

const runServiceRemoveGuildFeatureFlag = (
  botClient: typeof IngressBotClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
  payload: ServiceGuildFeatureFlagDispatchPayload = {
    ...serviceGuildFeatureFlagPayload,
    dispatchRequestId: "dispatch-service-remove-guild-feature-flag",
  },
) =>
  Effect.gen(function* () {
    const service = yield* DispatchService.make;
    return yield* service.serviceRemoveGuildFeatureFlag(payload);
  }).pipe(
    Effect.provideService(IngressBotClient, botClient),
    Effect.provideService(SheetApisClient, sheetApisClient),
  );

const runUpdateAnnouncement = (
  botClient: typeof IngressBotClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
  payload: UpdateAnnouncementDispatchPayload = updateAnnouncementPayload,
) =>
  Effect.gen(function* () {
    const service = yield* DispatchService.make;
    return yield* service.updateAnnouncement(payload);
  }).pipe(
    Effect.provideService(IngressBotClient, botClient),
    Effect.provideService(SheetApisClient, sheetApisClient),
  );

const runScreenshot = (
  botClient: typeof IngressBotClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
) =>
  Effect.gen(function* () {
    const service = yield* DispatchService.make;
    return yield* service.screenshot(screenshotPayload);
  }).pipe(
    Effect.provideService(IngressBotClient, botClient),
    Effect.provideService(SheetApisClient, sheetApisClient),
  );

const runWithDispatchService = <A>(
  botClient: typeof IngressBotClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
  f: (service: typeof DispatchService.Service) => Effect.Effect<A, unknown>,
) =>
  Effect.gen(function* () {
    const service = yield* DispatchService.make;
    return yield* f(service);
  }).pipe(
    Effect.provideService(IngressBotClient, botClient),
    Effect.provideService(SheetApisClient, sheetApisClient),
  );

const makeInteractionUpdateBotClient = (
  updateCalls: Array<{ readonly interactionToken: string; readonly payload: unknown }>,
) =>
  ({
    getGuild: (guildId: string) =>
      Effect.succeed({ id: guildId, name: guildId === "guild-1" ? "Guild One" : guildId }),
    updateOriginalInteractionResponse: (interactionToken: string, payload: unknown) => {
      updateCalls.push({ interactionToken, payload });
      return Effect.succeed({ id: "message-1", channel_id: "channel-1" });
    },
  }) as never;

const makeGuildChannelConfig = (
  overrides: Partial<ConstructorParameters<typeof GuildChannelConfig>[0]> = {},
) =>
  new GuildChannelConfig({
    guildId: "guild-1",
    channelId: "channel-1",
    name: Option.some("main"),
    running: Option.some(true),
    roleId: Option.some("role-1"),
    checkinChannelId: Option.some("checkin-channel-1"),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
    ...overrides,
  });

const makeGuildConfig = (overrides: Partial<ConstructorParameters<typeof GuildConfig>[0]> = {}) =>
  new GuildConfig({
    guildId: "guild-1",
    sheetId: Option.some("sheet-1"),
    autoCheckin: Option.some(true),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
    ...overrides,
  });

const makeGuildFeatureFlag = (
  overrides: Partial<ConstructorParameters<typeof GuildFeatureFlag>[0]> = {},
) =>
  new GuildFeatureFlag({
    guildId: "guild-1",
    flagName: "beta-feature",
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
    ...overrides,
  });

const makeGuildUpdateAnnouncementDelivery = (
  overrides: Partial<ConstructorParameters<typeof GuildUpdateAnnouncementDelivery>[0]> = {},
) =>
  new GuildUpdateAnnouncementDelivery({
    guildId: "guild-1",
    announcementId: updateAnnouncementPayload.announcement.id,
    publishedAt: Option.some(
      DateTime.makeUnsafe(updateAnnouncementPayload.announcement.publishedAt),
    ),
    deliveredAt: Option.some(DateTime.makeUnsafe("2026-06-04T17:01:00.000Z")),
    channelId: "system-channel",
    messageId: "update-message",
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
    ...overrides,
  });

const updateAnnouncementsFeatureFlagName = "update-announcements";

const makeGatedUpdateAnnouncementSheetApisClient = (
  recordCalls: Array<unknown>,
  options: {
    readonly claimCalls?: Array<unknown>;
    readonly releaseCalls?: Array<unknown>;
    readonly claimResult?: {
      readonly status: "claimed" | "already_claimed" | "already_delivered";
      readonly delivery: Option.Option<GuildUpdateAnnouncementDelivery>;
    };
  } = {},
) =>
  makeSheetApisClient({
    guildConfig: {
      getGuildFeatureFlags: () =>
        Effect.succeed([makeGuildFeatureFlag({ flagName: updateAnnouncementsFeatureFlagName })]),
      claimGuildUpdateAnnouncementDelivery: (args: unknown) => {
        options.claimCalls?.push(args);
        return Effect.succeed(
          options.claimResult ?? {
            status: "claimed" as const,
            delivery: Option.some(makeGuildUpdateAnnouncementDelivery()),
          },
        );
      },
      releaseGuildUpdateAnnouncementDeliveryClaim: (args: unknown) => {
        options.releaseCalls?.push(args);
        return Effect.void;
      },
      recordGuildUpdateAnnouncementDelivery: (args: unknown) => {
        recordCalls.push(args);
        return Effect.succeed(makeGuildUpdateAnnouncementDelivery());
      },
    },
  });

const makeChannelEntry = (overrides: {
  readonly id: string;
  readonly type?: number;
  readonly name?: string;
  readonly position?: number;
}) => ({
  parentId: "guild-1",
  resourceId: overrides.id,
  value: {
    id: overrides.id,
    guild_id: "guild-1",
    type: overrides.type ?? 0,
    name: overrides.name ?? overrides.id,
    position: overrides.position ?? 0,
  },
});

const roomOrderButtonPayload = {
  guildId: "guild-1",
  messageId: "room-order-message-1",
  messageChannelId: "channel-1",
  messageContent: null,
  interactionToken: "interaction-token",
  interactionDeadlineEpochMs: 1_700_000_000_000,
};

const makeMessageRoomOrder = (
  overrides: Partial<ConstructorParameters<typeof MessageRoomOrder>[0]> = {},
) =>
  new MessageRoomOrder({
    messageId: roomOrderButtonPayload.messageId,
    previousFills: [],
    fills: ["Akito"],
    hour: 1,
    rank: 2,
    tentative: false,
    monitor: Option.none(),
    guildId: Option.some("guild-1"),
    messageChannelId: Option.some("channel-1"),
    createdByUserId: Option.some("discord-user-1"),
    sendClaimId: Option.none(),
    sendClaimedAt: Option.none(),
    sentMessageId: Option.none(),
    sentMessageChannelId: Option.none(),
    sentAt: Option.none(),
    tentativeUpdateClaimId: Option.none(),
    tentativeUpdateClaimedAt: Option.none(),
    tentativePinClaimId: Option.none(),
    tentativePinClaimedAt: Option.none(),
    tentativePinnedAt: Option.none(),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
    ...overrides,
  });

const roomOrderRange = new MessageRoomOrderRange({ minRank: 1, maxRank: 3 });

const roomOrderEntries = [
  new MessageRoomOrderEntry({
    messageId: roomOrderButtonPayload.messageId,
    rank: 2,
    position: 0,
    team: "Team 1",
    tags: [],
    effectValue: 10,
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
  }),
];

const roomOrderEventConfig = new EventConfig({
  startTime: DateTime.makeUnsafe("2026-03-26T12:00:00.000Z"),
});

const makeRoomOrderUpdateBotClient = (updateCalls: Array<unknown> = []) =>
  ({
    updateOriginalInteractionResponse: (interactionToken: string, payload: unknown) => {
      updateCalls.push({ interactionToken, payload });
      return Effect.succeed({ id: "interaction-message-1", channel_id: "channel-1" });
    },
  }) as never;

const makeRoomOrderRankSheetApisClient = (
  apiCalls: Array<string>,
  initialRoomOrder: MessageRoomOrder,
) =>
  makeSheetApisClient({
    messageRoomOrder: {
      getMessageRoomOrder: () => Effect.succeed(initialRoomOrder),
      claimMessageRoomOrderTentativeUpdate: ({ payload }: { payload: { claimId: string } }) => {
        apiCalls.push("claim");
        return Effect.succeed(
          makeMessageRoomOrder({ tentativeUpdateClaimId: Option.some(payload.claimId) }),
        );
      },
      releaseMessageRoomOrderTentativeUpdateClaim: () => {
        apiCalls.push("release");
        return Effect.succeed({});
      },
      decrementMessageRoomOrderRank: () => {
        apiCalls.push("decrement");
        return Effect.succeed(makeMessageRoomOrder({ rank: 1 }));
      },
      incrementMessageRoomOrderRank: () => {
        apiCalls.push("increment");
        return Effect.succeed(makeMessageRoomOrder({ rank: 3 }));
      },
      getMessageRoomOrderRange: () => Effect.succeed(roomOrderRange),
      getMessageRoomOrderEntry: () => Effect.succeed(roomOrderEntries),
    },
    sheet: {
      getEventConfig: () => Effect.succeed(roomOrderEventConfig),
    },
  });

const makeRoomOrderSendSheetApisClient = (
  apiCalls: Array<string>,
  initialRoomOrder: MessageRoomOrder,
) =>
  makeSheetApisClient({
    messageRoomOrder: {
      getMessageRoomOrder: () => Effect.succeed(initialRoomOrder),
      claimMessageRoomOrderSend: ({ payload }: { payload: { claimId: string } }) => {
        apiCalls.push("claimSend");
        return Effect.succeed(makeMessageRoomOrder({ sendClaimId: Option.some(payload.claimId) }));
      },
      releaseMessageRoomOrderSendClaim: () => {
        apiCalls.push("releaseSend");
        return Effect.succeed({});
      },
      completeMessageRoomOrderSend: () => {
        apiCalls.push("completeSend");
        return Effect.succeed(
          makeMessageRoomOrder({
            sentMessageId: Option.some("sent-message-1"),
            sentMessageChannelId: Option.some("channel-1"),
          }),
        );
      },
      getMessageRoomOrderRange: () => Effect.succeed(roomOrderRange),
      getMessageRoomOrderEntry: () => Effect.succeed(roomOrderEntries),
    },
    sheet: {
      getEventConfig: () => Effect.succeed(roomOrderEventConfig),
    },
  });

describe("DispatchService", () => {
  it("sends first-hour auto check-in test previews without persistent message state", async () => {
    const updateCalls: Array<{ readonly interactionToken: string; readonly payload: unknown }> = [];
    const sendCalls: Array<{ readonly channelId: string; readonly payload: unknown }> = [];
    const checkinGenerateCalls: Array<unknown> = [];
    const roomOrderGenerateCalls: Array<unknown> = [];
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        getGuildChannels: (args: unknown) => {
          expect(args).toEqual({ query: { guildId: "guild-1", running: true } });
          return Effect.succeed([makeGuildChannelConfig()]);
        },
      },
      checkin: {
        generate: (args: unknown) => {
          checkinGenerateCalls.push(args);
          return Effect.succeed({
            hour: 1,
            runningChannelId: "channel-1",
            checkinChannelId: "checkin-channel-1",
            fillCount: 5,
            roleId: "role-1",
            initialMessage: "Check in <@user-1> <@&role-1>",
            monitorCheckinMessage: "Monitor summary <@monitor-1>",
            monitorUserId: "monitor-1",
            monitorFailureMessage: null,
            fillIds: ["user-1", "user-2", "user-3", "user-4", "user-5"],
          });
        },
      },
      roomOrder: {
        generate: (args: unknown) => {
          roomOrderGenerateCalls.push(args);
          return Effect.succeed({
            content: "Room order content <@user-1>",
            runningChannelId: "channel-1",
            range: roomOrderRange,
            rank: 1,
            hour: 1,
            monitor: null,
            previousFills: [],
            fills: ["user-1"],
            entries: [],
          });
        },
      },
      messageCheckin: {
        persistMessageCheckin: () => Effect.die("test run must not persist check-in messages"),
      },
      messageRoomOrder: {
        persistMessageRoomOrder: () => Effect.die("test run must not persist room-order messages"),
      },
    });
    const botClient = {
      updateOriginalInteractionResponse: (interactionToken: string, payload: unknown) => {
        updateCalls.push({ interactionToken, payload });
        return Effect.succeed({ id: "anchor-message", channel_id: "anchor-channel-1" });
      },
      updateMessage: () => Effect.die("test run must update the anchor through the interaction"),
      sendMessage: (channelId: string, payload: unknown) => {
        sendCalls.push({ channelId, payload });
        return Effect.succeed({
          id: `preview-message-${sendCalls.length}`,
          channel_id: channelId,
        });
      },
    } as never;

    const result = await Effect.runPromise(
      runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.autoCheckinTest(autoCheckinTestPayload, requester),
      ),
    );

    expect(result).toMatchObject({
      guildId: "guild-1",
      hour: 1,
      anchorMessageId: "anchor-message",
      anchorMessageChannelId: "anchor-channel-1",
      channelCount: 1,
      sentCount: 1,
      skippedCount: 0,
      failedCount: 0,
    });
    expect(result.channels).toEqual([
      {
        channelName: "main",
        runningChannelId: "channel-1",
        checkinChannelId: "checkin-channel-1",
        hour: 1,
        status: "sent",
        checkinPreviewMessageId: "preview-message-1",
        monitorPreviewMessageId: "preview-message-2",
        tentativeRoomOrderPreviewMessageId: "preview-message-3",
        error: null,
      },
    ]);
    expect(checkinGenerateCalls).toEqual([
      {
        payload: {
          dispatchRequestId: "dispatch-auto-checkin-test:main",
          guildId: "guild-1",
          channelName: "main",
          hour: 1,
        },
      },
    ]);
    expect(roomOrderGenerateCalls).toEqual([
      { payload: { guildId: "guild-1", channelId: "channel-1", hour: 1 } },
    ]);
    expect(updateCalls).toHaveLength(2);
    expect(firstEmbedDescription(updateCalls[0]?.payload)).toContain("Requested by <@account-1>.");
    expect(firstEmbedDescription(updateCalls[0]?.payload)).not.toContain("<@discord-user-1>");
    expect(sendCalls.map((call) => call.channelId)).toEqual([
      "checkin-channel-1",
      "channel-1",
      "channel-1",
    ]);
    for (const call of sendCalls) {
      expect(call.payload).toMatchObject({
        content: null,
        allowed_mentions: { parse: [] },
      });
      expect(call.payload).not.toHaveProperty("message_reference");
      expect(firstEmbedFields(call.payload)).toContainEqual({
        name: "Test run",
        value:
          "[Open summary](https://discord.com/channels/guild-1/anchor-channel-1/anchor-message)",
      });
      expect((call.payload as { embeds?: ReadonlyArray<unknown> }).embeds).toHaveLength(1);
      expect(
        (call.payload as { embeds: ReadonlyArray<{ title?: string; footer?: { text?: string } }> })
          .embeds[0],
      ).toMatchObject({
        title: expect.stringContaining("TEST RUN"),
        footer: {
          text: expect.stringContaining("TEST RUN"),
        },
      });
    }
  });

  it("omits native message references for same-channel auto check-in test previews", async () => {
    const updateCalls: Array<{ readonly interactionToken: string; readonly payload: unknown }> = [];
    const sendCalls: Array<{ readonly channelId: string; readonly payload: unknown }> = [];
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        getGuildChannels: () => Effect.succeed([makeGuildChannelConfig()]),
      },
      checkin: {
        generate: () =>
          Effect.succeed({
            hour: 1,
            runningChannelId: "anchor-channel-1",
            checkinChannelId: "anchor-channel-1",
            fillCount: 0,
            roleId: "role-1",
            initialMessage: null,
            monitorCheckinMessage: "Monitor summary",
            monitorUserId: "monitor-1",
            monitorFailureMessage: null,
            fillIds: [],
          }),
      },
    });
    const botClient = {
      updateOriginalInteractionResponse: (interactionToken: string, payload: unknown) => {
        updateCalls.push({ interactionToken, payload });
        return Effect.succeed({ id: "anchor-message", channel_id: "anchor-channel-1" });
      },
      updateMessage: () => Effect.die("test run must update the anchor through the interaction"),
      sendMessage: (channelId: string, payload: unknown) => {
        sendCalls.push({ channelId, payload });
        return Effect.succeed({ id: "preview-message-1", channel_id: channelId });
      },
    } as never;

    const result = await Effect.runPromise(
      runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.autoCheckinTest(autoCheckinTestPayload, requester),
      ),
    );

    expect(result).toMatchObject({
      channelCount: 1,
      sentCount: 0,
      skippedCount: 1,
      failedCount: 0,
    });
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toMatchObject({
      channelId: "anchor-channel-1",
      payload: {
        content: null,
        allowed_mentions: { parse: [] },
      },
    });
    expect(sendCalls[0]?.payload).not.toHaveProperty("message_reference");
    expect(firstEmbedFields(sendCalls[0]?.payload)).toContainEqual({
      name: "Test run",
      value: "[Open summary](https://discord.com/channels/guild-1/anchor-channel-1/anchor-message)",
    });
  });

  it("surfaces first auto check-in test channel failure details in the summary", async () => {
    const updateCalls: Array<{ readonly interactionToken: string; readonly payload: unknown }> = [];
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        getGuildChannels: () => Effect.succeed([makeGuildChannelConfig()]),
      },
      checkin: {
        generate: () => Effect.fail(new Error("Unable to parse range: 'Day 9'!J3:N23")),
      },
    });
    const botClient = {
      updateOriginalInteractionResponse: (interactionToken: string, payload: unknown) => {
        updateCalls.push({ interactionToken, payload });
        return Effect.succeed({ id: "anchor-message", channel_id: "anchor-channel-1" });
      },
      updateMessage: () => Effect.die("test run must update the anchor through the interaction"),
      sendMessage: () => Effect.die("failed channel must not send preview messages"),
    } as never;

    const result = await Effect.runPromise(
      runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.autoCheckinTest(autoCheckinTestPayload, requester),
      ),
    );

    expect(result).toMatchObject({
      channelCount: 1,
      sentCount: 0,
      skippedCount: 0,
      failedCount: 1,
    });
    expect(result.channels[0]).toMatchObject({
      channelName: "main",
      status: "failed",
    });
    expect(result.channels[0]?.error).toContain("Unable to parse range: 'Day 9'!J3:N23");
    expect(updateCalls).toHaveLength(2);
    expect(firstEmbedDescription(updateCalls[1]?.payload)).toContain("Failed channels: main");
    expect(firstEmbedDescription(updateCalls[1]?.payload)).toContain(
      "First failure detail for main:",
    );
    expect(firstEmbedDescription(updateCalls[1]?.payload)).toContain(
      "Unable to parse range: 'Day 9'!J3:N23",
    );
  });

  it("sends the guild welcome embed to the system channel first", async () => {
    const sendCalls: Array<{ readonly channelId: string; readonly payload: unknown }> = [];
    const botClient = {
      getChannelsForParent: () =>
        Effect.succeed([
          makeChannelEntry({ id: "general", name: "general", position: 1 }),
          makeChannelEntry({ id: "system-channel", name: "welcome", position: 2 }),
        ]),
      sendMessage: (channelId: string, payload: unknown) => {
        sendCalls.push({ channelId, payload });
        return Effect.succeed({ id: "welcome-message", channel_id: channelId });
      },
    } as never;

    const result = await Effect.runPromise(runGuildWelcome(botClient, makeSheetApisClient({})));

    expect(result).toEqual({
      guildId: "guild-1",
      channelId: "system-channel",
      messageId: "welcome-message",
    });
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.channelId).toBe("system-channel");
    expect(sendCalls[0]?.payload).toEqual({
      embeds: [
        {
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
        },
      ],
    });
  });

  it("falls back to general and then sorted sendable channels for guild welcome", async () => {
    const sendCalls: Array<string> = [];
    const botClient = {
      getChannelsForParent: () =>
        Effect.succeed([
          makeChannelEntry({ id: "voice", type: 2, name: "voice", position: 0 }),
          makeChannelEntry({ id: "late", name: "late", position: 20 }),
          makeChannelEntry({ id: "general", name: "General", position: 50 }),
          makeChannelEntry({ id: "early", name: "early", position: 10 }),
        ]),
      sendMessage: (channelId: string) => {
        sendCalls.push(channelId);
        return channelId === "general"
          ? Effect.fail(new Error("cannot send general"))
          : Effect.succeed({ id: `message-${channelId}`, channel_id: channelId });
      },
    } as never;

    const result = await Effect.runPromise(runGuildWelcome(botClient, makeSheetApisClient({})));

    expect(result).toEqual({
      guildId: "guild-1",
      channelId: "early",
      messageId: "message-early",
    });
    expect(sendCalls).toEqual(["general", "early"]);
  });

  it("fails guild welcome when no channel can receive the message", async () => {
    const botClient = {
      getChannelsForParent: () =>
        Effect.succeed([makeChannelEntry({ id: "voice", type: 2, name: "voice", position: 0 })]),
      sendMessage: () => Effect.die("sendMessage should not be called"),
    } as never;

    const exit = await Effect.runPromiseExit(runGuildWelcome(botClient, makeSheetApisClient({})));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(
      Exit.isFailure(exit) &&
        exit.cause.reasons
          .filter(Cause.isFailReason)
          .some(
            (reason) =>
              typeof reason.error === "object" &&
              reason.error !== null &&
              "_tag" in reason.error &&
              reason.error._tag === "ArgumentError",
          ),
    ).toBe(true);
  });

  it("adds a guild feature flag and announces to the system channel first", async () => {
    const sheetApiCalls: Array<unknown> = [];
    const sendCalls: Array<{ readonly channelId: string; readonly payload: unknown }> = [];
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        addGuildFeatureFlag: (args: unknown) => {
          sheetApiCalls.push(args);
          return Effect.succeed(makeGuildFeatureFlag());
        },
      },
    });
    const botClient = {
      getChannelsForParent: () =>
        Effect.succeed([
          makeChannelEntry({ id: "general", name: "general", position: 1 }),
          makeChannelEntry({ id: "system-channel", name: "welcome", position: 2 }),
        ]),
      sendMessage: (channelId: string, payload: unknown) => {
        sendCalls.push({ channelId, payload });
        return Effect.succeed({ id: "feature-message", channel_id: channelId });
      },
    } as never;

    const result = await Effect.runPromise(
      runServiceAddGuildFeatureFlag(botClient, sheetApisClient),
    );

    expect(result).toEqual({
      guildId: "guild-1",
      flagName: "beta-feature",
      announcementChannelId: "system-channel",
      announcementMessageId: "feature-message",
    });
    expect(sheetApiCalls).toEqual([{ payload: { guildId: "guild-1", flagName: "beta-feature" } }]);
    expect(sendCalls).toEqual([
      {
        channelId: "system-channel",
        payload: {
          embeds: [
            {
              title: "Feature flag enabled",
              description: "This server has been enlisted for `beta-feature`.",
              color: 0x57f287,
            },
          ],
        },
      },
    ]);
  });

  it("removes a guild feature flag and falls back to general for the announcement", async () => {
    const sheetApiCalls: Array<unknown> = [];
    const sendCalls: Array<string> = [];
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        removeGuildFeatureFlag: (args: unknown) => {
          sheetApiCalls.push(args);
          return Effect.succeed(makeGuildFeatureFlag());
        },
      },
    });
    const botClient = {
      getChannelsForParent: () =>
        Effect.succeed([
          makeChannelEntry({ id: "general", name: "general", position: 1 }),
          makeChannelEntry({ id: "early", name: "early", position: 0 }),
        ]),
      sendMessage: (channelId: string) => {
        sendCalls.push(channelId);
        return Effect.succeed({ id: "feature-message", channel_id: channelId });
      },
    } as never;

    const result = await Effect.runPromise(
      runServiceRemoveGuildFeatureFlag(botClient, sheetApisClient, {
        ...serviceGuildFeatureFlagPayload,
        dispatchRequestId: "dispatch-service-remove-guild-feature-flag",
        systemChannelId: "missing-system-channel",
      }),
    );

    expect(result).toEqual({
      guildId: "guild-1",
      flagName: "beta-feature",
      announcementChannelId: "general",
      announcementMessageId: "feature-message",
    });
    expect(sheetApiCalls).toEqual([{ payload: { guildId: "guild-1", flagName: "beta-feature" } }]);
    expect(sendCalls).toEqual(["general"]);
  });

  it("keeps guild feature flag mutation success when the announcement cannot be sent", async () => {
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        addGuildFeatureFlag: () => Effect.succeed(makeGuildFeatureFlag()),
      },
    });
    const botClient = {
      getChannelsForParent: () =>
        Effect.succeed([makeChannelEntry({ id: "general", name: "general", position: 1 })]),
      sendMessage: () => Effect.fail(new Error("cannot send")),
    } as never;

    const result = await Effect.runPromise(
      runServiceAddGuildFeatureFlag(botClient, sheetApisClient),
    );

    expect(result).toEqual({
      guildId: "guild-1",
      flagName: "beta-feature",
      announcementChannelId: null,
      announcementMessageId: null,
    });
  });

  it("skips update announcements for guilds without the gate feature flag", async () => {
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        getGuildFeatureFlags: () => Effect.succeed([]),
      },
    });
    const botClient = {} as never;

    const result = await Effect.runPromise(runUpdateAnnouncement(botClient, sheetApisClient));

    expect(result).toEqual({
      guildId: "guild-1",
      announcementId: "update-announcements-2026-06-05",
      status: "skipped_not_gated",
      announcementChannelId: null,
      announcementMessageId: null,
    });
  });

  it("skips update announcements that were already delivered", async () => {
    const sheetApisClient = makeGatedUpdateAnnouncementSheetApisClient([], {
      claimResult: {
        status: "already_delivered",
        delivery: Option.some(makeGuildUpdateAnnouncementDelivery()),
      },
    });
    const botClient = {} as never;

    const result = await Effect.runPromise(runUpdateAnnouncement(botClient, sheetApisClient));

    expect(result).toEqual({
      guildId: "guild-1",
      announcementId: "update-announcements-2026-06-05",
      status: "skipped_already_delivered",
      announcementChannelId: "system-channel",
      announcementMessageId: "update-message",
    });
  });

  it("skips update announcements that are already claimed", async () => {
    const sendCalls: Array<unknown> = [];
    const sheetApisClient = makeGatedUpdateAnnouncementSheetApisClient([], {
      claimResult: {
        status: "already_claimed",
        delivery: Option.none(),
      },
    });
    const botClient = {
      getChannelsForParent: () => Effect.succeed([]),
      sendMessage: (channelId: string, payload: unknown) => {
        sendCalls.push({ channelId, payload });
        return Effect.succeed({ id: "update-message", channel_id: channelId });
      },
    } as never;

    const result = await Effect.runPromise(runUpdateAnnouncement(botClient, sheetApisClient));

    expect(result).toEqual({
      guildId: "guild-1",
      announcementId: "update-announcements-2026-06-05",
      status: "skipped_already_delivered",
      announcementChannelId: null,
      announcementMessageId: null,
    });
    expect(sendCalls).toEqual([]);
  });

  it("sends gated update announcements and records delivery", async () => {
    const claimCalls: Array<unknown> = [];
    const recordCalls: Array<unknown> = [];
    const sendCalls: Array<{ readonly channelId: string; readonly payload: unknown }> = [];
    const sheetApisClient = makeGatedUpdateAnnouncementSheetApisClient(recordCalls, {
      claimCalls,
    });
    const botClient = {
      getChannelsForParent: () =>
        Effect.succeed([
          makeChannelEntry({ id: "general", name: "general", position: 1 }),
          makeChannelEntry({ id: "system-channel", name: "welcome", position: 2 }),
        ]),
      sendMessage: (channelId: string, payload: unknown) => {
        sendCalls.push({ channelId, payload });
        return Effect.succeed({ id: "update-message", channel_id: channelId });
      },
    } as never;

    const result = await Effect.runPromise(runUpdateAnnouncement(botClient, sheetApisClient));

    expect(result).toEqual({
      guildId: "guild-1",
      announcementId: "update-announcements-2026-06-05",
      status: "sent",
      announcementChannelId: "system-channel",
      announcementMessageId: "update-message",
    });
    expect(sendCalls).toEqual([
      {
        channelId: "system-channel",
        payload: {
          embeds: [
            {
              title: "Update announcements",
              description: "Update announcement description",
              color: 0x5865f2,
            },
          ],
        },
      },
    ]);
    expect(claimCalls).toHaveLength(1);
    expect(claimCalls[0]).toMatchObject({
      payload: {
        guildId: "guild-1",
        announcementId: "update-announcements-2026-06-05",
      },
    });
    expect(recordCalls).toHaveLength(1);
    expect(recordCalls[0]).toMatchObject({
      payload: {
        guildId: "guild-1",
        announcementId: "update-announcements-2026-06-05",
        channelId: "system-channel",
        messageId: "update-message",
      },
    });
  });

  it("does not record update announcement delivery when sending fails", async () => {
    const recordCalls: Array<unknown> = [];
    const releaseCalls: Array<unknown> = [];
    const sheetApisClient = makeGatedUpdateAnnouncementSheetApisClient(recordCalls, {
      releaseCalls,
    });
    const botClient = {
      getChannelsForParent: () =>
        Effect.succeed([makeChannelEntry({ id: "system-channel", name: "welcome" })]),
      sendMessage: () => Effect.fail(new Error("cannot send")),
    } as never;

    const exit = await Effect.runPromiseExit(runUpdateAnnouncement(botClient, sheetApisClient));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(recordCalls).toEqual([]);
    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0]).toMatchObject({
      payload: {
        guildId: "guild-1",
        announcementId: "update-announcements-2026-06-05",
      },
    });
  });

  it("persists slot button metadata with the requester Discord user id", async () => {
    const upsertCalls: Array<unknown> = [];
    const botClient = {
      sendMessage: () => Effect.succeed({ id: "message-1", channel_id: "channel-1" }),
      updateOriginalInteractionResponse: () =>
        Effect.succeed({ id: "interaction-message-1", channel_id: "channel-1" }),
    } as never;
    const sheetApisClient = makeMessageSlotSheetApisClient((args) => {
      upsertCalls.push(args);
      return Effect.succeed({});
    });

    const result = await Effect.runPromise(runSlotButton(botClient, sheetApisClient));

    expect(result).toEqual({
      messageId: "message-1",
      messageChannelId: "channel-1",
      day: 2,
    });
    expect(upsertCalls).toEqual([
      {
        payload: {
          messageId: "message-1",
          data: {
            day: 2,
            guildId: "guild-1",
            messageChannelId: "channel-1",
            createdByUserId: "discord-user-1",
          },
        },
      },
    ]);
  });

  it("deletes the slot button message when metadata persistence fails", async () => {
    const deleteCalls: Array<ReadonlyArray<string>> = [];
    const botClient = {
      sendMessage: () => Effect.succeed({ id: "message-1", channel_id: "channel-1" }),
      deleteMessage: (channelId: string, messageId: string) => {
        deleteCalls.push([channelId, messageId]);
        return Effect.succeed({});
      },
    } as never;
    const upsertError = new Error("upsert failed");
    const sheetApisClient = makeMessageSlotSheetApisClient(() => Effect.fail(upsertError));

    const exit = await Effect.runPromiseExit(runSlotButton(botClient, sheetApisClient));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(
      Exit.isFailure(exit) &&
        exit.cause.reasons
          .filter(Cause.isFailReason)
          .some((reason) => reason.error === upsertError),
    ).toBe(true);
    expect(deleteCalls).toEqual([["channel-1", "message-1"]]);
  });

  it("returns slot button success when the final interaction update fails", async () => {
    const upsertCalls: Array<unknown> = [];
    const botClient = {
      sendMessage: () => Effect.succeed({ id: "message-1", channel_id: "channel-1" }),
      updateOriginalInteractionResponse: () => Effect.fail(new Error("interaction update failed")),
    } as never;
    const sheetApisClient = makeMessageSlotSheetApisClient((args) => {
      upsertCalls.push(args);
      return Effect.succeed({});
    });

    const result = await Effect.runPromise(runSlotButton(botClient, sheetApisClient));

    expect(result).toEqual({
      messageId: "message-1",
      messageChannelId: "channel-1",
      day: 2,
    });
    expect(upsertCalls).toHaveLength(1);
  });

  it("renders persisted slot button clicks from the cluster", async () => {
    const updateCalls: Array<unknown> = [];
    const botClient = {
      updateOriginalInteractionResponse: (interactionToken: string, payload: unknown) => {
        updateCalls.push({ interactionToken, payload });
        return Effect.succeed({ id: "interaction-message-1", channel_id: "channel-1" });
      },
    } as never;
    const sheetApisClient = makeSheetApisClient({
      sheet: {
        getEventConfig: () =>
          Effect.succeed(
            new EventConfig({
              startTime: DateTime.makeUnsafe("2026-03-26T12:00:00.000Z"),
            }),
          ),
      },
      schedule: {
        getDayPopulatedSchedules: () =>
          Effect.succeed({ schedules: [makeSchedule(1, ["member-1", "member-2"])] }),
      },
    });

    const result = await Effect.runPromise(runSlotOpenButton(botClient, sheetApisClient));

    expect(result).toEqual({
      messageId: "message-1",
      guildId: "guild-1",
      day: 2,
    });
    expect(updateCalls).toEqual([
      {
        interactionToken: "interaction-token",
        payload: {
          embeds: [
            {
              title: "Day 2 Open Slots",
              description: "**+3 |** **hour 1** <t:1774526400:t>-<t:1774530000:t>",
            },
            {
              title: "Day 2 Filled Slots",
              description: "All Open :3",
            },
          ],
        },
      },
    ]);
  });

  it("updates the interaction with a service status embed", async () => {
    const updateCalls: Array<unknown> = [];
    const checkedAt = DateTime.makeUnsafe("2026-05-23T12:00:00.000Z");
    const botClient = {
      updateOriginalInteractionResponse: (interactionToken: string, payload: unknown) => {
        updateCalls.push({ interactionToken, payload });
        return Effect.succeed({ id: "interaction-message-1", channel_id: "channel-1" });
      },
    } as never;
    const sheetApisClient = makeSheetApisClient({
      status: {
        getServices: () =>
          Effect.succeed({
            overallStatus: "degraded" as const,
            checkedAt,
            services: [
              {
                name: "sheet-apis",
                url: "http://sheet-apis-service:3000/ready",
                status: "ok" as const,
                httpStatus: 200,
                latencyMs: 24,
                checkedAt,
                error: null,
              },
              {
                name: "sheet-web",
                url: "http://sheet-web-service:3000/ready",
                status: "down" as const,
                httpStatus: 503,
                latencyMs: 18,
                checkedAt,
                error: "HTTP 503",
              },
            ],
          }),
      },
    });

    const result = await Effect.runPromise(runServiceStatus(botClient, sheetApisClient));

    expect(result).toEqual({
      overallStatus: "degraded",
      okCount: 1,
      downCount: 1,
    });
    expect(updateCalls).toEqual([
      {
        interactionToken: "interaction-token",
        payload: {
          embeds: [
            {
              title: "Service Status",
              description: "Some services are not ready.",
              color: 0xfee75c,
              fields: [
                {
                  name: "sheet-apis",
                  value: "OK - 200 - 24ms",
                  inline: true,
                },
                {
                  name: "sheet-web",
                  value: "DOWN - 503 - 18ms",
                  inline: true,
                },
              ],
              footer: {
                text: "Checked at 2026-05-23T12:00:00.000Z",
              },
            },
          ],
        },
      },
    ]);
  });

  it("handles previous room-order buttons through the decrement path", async () => {
    const updateCalls: Array<unknown> = [];
    const apiCalls: Array<string> = [];
    const initialRoomOrder = makeMessageRoomOrder();
    const botClient = makeRoomOrderUpdateBotClient(updateCalls);
    const sheetApisClient = makeRoomOrderRankSheetApisClient(apiCalls, initialRoomOrder);

    const result = await Effect.runPromise(
      runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.roomOrderPreviousButton(roomOrderButtonPayload, initialRoomOrder),
      ),
    );

    expect(result).toEqual({
      messageId: roomOrderButtonPayload.messageId,
      messageChannelId: roomOrderButtonPayload.messageChannelId,
      status: "updated",
      detail: null,
    });
    expect(apiCalls).toEqual(["claim", "release", "decrement", "release"]);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({ interactionToken: "interaction-token" });
  });

  it("handles next room-order buttons through the increment path", async () => {
    const apiCalls: Array<string> = [];
    const initialRoomOrder = makeMessageRoomOrder();
    const botClient = makeRoomOrderUpdateBotClient();
    const sheetApisClient = makeRoomOrderRankSheetApisClient(apiCalls, initialRoomOrder);

    const result = await Effect.runPromise(
      runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.roomOrderNextButton(roomOrderButtonPayload, initialRoomOrder),
      ),
    );

    expect(result.status).toBe("updated");
    expect(apiCalls).toEqual(["claim", "release", "increment", "release"]);
  });

  it("handles send room-order buttons through the send claim path", async () => {
    const apiCalls: Array<string> = [];
    const botCalls: Array<string> = [];
    const initialRoomOrder = makeMessageRoomOrder();
    const botClient = {
      updateOriginalInteractionResponse: () => {
        botCalls.push("interaction");
        return Effect.succeed({ id: "interaction-message-1", channel_id: "channel-1" });
      },
      sendMessage: () => {
        botCalls.push("send");
        return Effect.succeed({ id: "sent-message-1", channel_id: "channel-1" });
      },
      createPin: () => {
        botCalls.push("pin");
        return Effect.succeed({});
      },
    } as never;
    const sheetApisClient = makeRoomOrderSendSheetApisClient(apiCalls, initialRoomOrder);

    const result = await Effect.runPromise(
      runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.roomOrderSendButton(roomOrderButtonPayload, initialRoomOrder),
      ),
    );

    expect(result).toEqual({
      messageId: "sent-message-1",
      messageChannelId: "channel-1",
      status: "pinned",
      detail: "sent room order and pinned it!",
    });
    expect(apiCalls).toEqual(["claimSend", "releaseSend", "completeSend"]);
    expect(botCalls).toEqual(["send", "pin", "interaction"]);
  });

  it("does not pin registered non-tentative room-order messages", async () => {
    const botCalls: Array<string> = [];
    const initialRoomOrder = makeMessageRoomOrder({ tentative: false });
    const botClient = {
      updateOriginalInteractionResponse: () => {
        botCalls.push("interaction");
        return Effect.succeed({ id: "interaction-message-1", channel_id: "channel-1" });
      },
      createPin: () => {
        botCalls.push("pin");
        return Effect.succeed({});
      },
    } as never;
    const sheetApisClient = makeSheetApisClient({
      messageRoomOrder: {
        getMessageRoomOrder: () => Effect.succeed(initialRoomOrder),
      },
      guildConfig: {
        getGuildChannelById: () => Effect.succeed(makeGuildChannelConfig()),
      },
    });

    const result = await Effect.runPromise(
      runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.roomOrderPinTentativeButton(roomOrderButtonPayload, initialRoomOrder),
      ),
    );

    expect(result).toEqual({
      messageId: roomOrderButtonPayload.messageId,
      messageChannelId: roomOrderButtonPayload.messageChannelId,
      status: "denied",
      detail: "cannot pin a non-tentative room order.",
    });
    expect(botCalls).toEqual(["interaction"]);
  });

  it("keeps the fallback pin path for legacy tentative room-order messages", async () => {
    const botCalls: Array<string> = [];
    const botClient = {
      createPin: () => {
        botCalls.push("pin");
        return Effect.succeed({});
      },
      updateMessage: () => {
        botCalls.push("cleanup");
        return Effect.succeed({ id: "room-order-message-1", channel_id: "channel-1" });
      },
      updateOriginalInteractionResponse: () => {
        botCalls.push("interaction");
        return Effect.succeed({ id: "interaction-message-1", channel_id: "channel-1" });
      },
    } as never;
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        getGuildChannelById: () => Effect.succeed(makeGuildChannelConfig()),
      },
    });

    const result = await Effect.runPromise(
      runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.roomOrderPinTentativeButton(
          {
            ...roomOrderButtonPayload,
            messageContent: formatTentativeRoomOrderContent("Hour 1"),
          },
          null,
        ),
      ),
    );

    expect(result).toEqual({
      messageId: "room-order-message-1",
      messageChannelId: "channel-1",
      status: "pinned",
      detail: "pinned tentative room order!",
    });
    expect(botCalls).toEqual(["pin", "cleanup", "interaction"]);
  });

  it("rejects legacy pin payloads without the tentative marker", async () => {
    const botCalls: Array<string> = [];
    const botClient = {
      createPin: () => {
        botCalls.push("pin");
        return Effect.succeed({});
      },
      updateOriginalInteractionResponse: () => {
        botCalls.push("interaction");
        return Effect.succeed({ id: "interaction-message-1", channel_id: "channel-1" });
      },
    } as never;
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        getGuildChannelById: () => Effect.succeed(makeGuildChannelConfig()),
      },
    });

    const exit = await Effect.runPromiseExit(
      runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.roomOrderPinTentativeButton(roomOrderButtonPayload, null),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(botCalls).toEqual(["interaction"]);
  });

  it("updates the interaction before failing when kickout cannot find a running channel", async () => {
    const updateCalls: Array<unknown> = [];
    const botClient = {
      updateOriginalInteractionResponse: (interactionToken: string, payload: unknown) => {
        updateCalls.push({ interactionToken, payload });
        return Effect.succeed({ id: "interaction-message-1", channel_id: "channel-1" });
      },
    } as never;
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        getGuildChannelById: () => Effect.fail({ _tag: "ArgumentError", message: "missing" }),
      },
    });

    const exit = await Effect.runPromiseExit(
      runKickout(
        {
          dispatchRequestId: "dispatch-kickout",
          guildId: "guild-1",
          channelId: "channel-1",
          hour: 1,
          interactionToken: "interaction-token",
        },
        botClient,
        sheetApisClient,
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(updateCalls).toEqual([
      {
        interactionToken: "interaction-token",
        payload: {
          content: "Cannot kick out, running channel not found",
          allowed_mentions: { parse: [] },
        },
      },
    ]);
  });

  it("returns tooEarly and skips sheet lookups when kickout runs too late in the hour", async () => {
    const updateCalls: Array<unknown> = [];
    const sheetApiCalls: Array<string> = [];
    const botClient = {
      updateOriginalInteractionResponse: (interactionToken: string, payload: unknown) => {
        updateCalls.push({ interactionToken, payload });
        return Effect.succeed({ id: "interaction-message-1", channel_id: "channel-1" });
      },
    } as never;
    const sheetApisClient = makeSheetApisClient(
      new Proxy(
        {},
        {
          get: (_target, group: string) =>
            new Proxy(
              {},
              {
                get: (_service, method: string) => {
                  sheetApiCalls.push(`${group}.${method}`);
                  return unexpected(`${group}.${method}`);
                },
              },
            ),
        },
      ),
    );

    const result = await Effect.runPromise(
      runKickout(
        {
          dispatchRequestId: "dispatch-kickout",
          guildId: "guild-1",
          channelId: "channel-1",
          hour: 1,
          interactionToken: "interaction-token",
        },
        botClient,
        sheetApisClient,
        Date.parse("2026-05-13T00:40:00.000Z"),
      ),
    );

    expect(result).toEqual({
      guildId: "guild-1",
      runningChannelId: "channel-1",
      hour: 1,
      roleId: null,
      removedMemberIds: [],
      status: "tooEarly",
    });
    expect(updateCalls).toEqual([
      {
        interactionToken: "interaction-token",
        payload: {
          content: "Cannot kick out until next hour starts",
          allowed_mentions: { parse: [] },
        },
      },
    ]);
    expect(sheetApiCalls).toEqual([]);
  });

  it("updates the interaction before failing when kickout channel has no name", async () => {
    const updateCalls: Array<unknown> = [];
    const botClient = {
      updateOriginalInteractionResponse: (interactionToken: string, payload: unknown) => {
        updateCalls.push({ interactionToken, payload });
        return Effect.succeed({ id: "interaction-message-1", channel_id: "channel-1" });
      },
    } as never;
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        getGuildChannelById: () =>
          Effect.succeed({
            guildId: "guild-1",
            channelId: "channel-1",
            name: Option.none(),
            roleId: Option.some("role-1"),
            running: Option.some(true),
          }),
      },
    });

    const exit = await Effect.runPromiseExit(
      runKickout(
        {
          dispatchRequestId: "dispatch-kickout",
          guildId: "guild-1",
          channelId: "channel-1",
          hour: 1,
          interactionToken: "interaction-token",
        },
        botClient,
        sheetApisClient,
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(updateCalls).toEqual([
      {
        interactionToken: "interaction-token",
        payload: {
          content: "Cannot kick out, channel has no name",
          allowed_mentions: { parse: [] },
        },
      },
    ]);
  });

  it("does not remove roles when kickout has no schedule for the channel hour", async () => {
    const updateCalls: Array<unknown> = [];
    const removeCalls: Array<ReadonlyArray<string>> = [];
    const botClient = {
      updateOriginalInteractionResponse: (interactionToken: string, payload: unknown) => {
        updateCalls.push({ interactionToken, payload });
        return Effect.succeed({ id: "interaction-message-1", channel_id: "channel-1" });
      },
      getMembersForParent: () => Effect.die("members should not be loaded without a schedule"),
      removeGuildMemberRole: (guildId: string, memberId: string, roleId: string) => {
        removeCalls.push([guildId, memberId, roleId]);
        return Effect.succeed({});
      },
    } as never;
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        getGuildChannelById: () =>
          Effect.succeed({
            guildId: "guild-1",
            channelId: "channel-1",
            name: Option.some("main"),
            roleId: Option.some("role-1"),
            running: Option.some(true),
          }),
      },
      schedule: {
        getChannelPopulatedSchedules: () => Effect.succeed({ schedules: [] }),
      },
    });

    const result = await Effect.runPromise(
      runKickout(
        {
          dispatchRequestId: "dispatch-kickout",
          guildId: "guild-1",
          channelId: "channel-1",
          hour: 1,
          interactionToken: "interaction-token",
        },
        botClient,
        sheetApisClient,
      ),
    );

    expect(result).toEqual({
      guildId: "guild-1",
      runningChannelId: "channel-1",
      hour: 1,
      roleId: "role-1",
      removedMemberIds: [],
      status: "empty",
    });
    expect(updateCalls).toEqual([
      {
        interactionToken: "interaction-token",
        payload: {
          content: "No schedule found for this channel and hour; no players kicked out",
          allowed_mentions: { parse: [] },
        },
      },
    ]);
    expect(removeCalls).toEqual([]);
  });

  it("continues kickout removals and updates the interaction when one role removal fails", async () => {
    const updateCalls: Array<unknown> = [];
    const removeCalls: Array<ReadonlyArray<string>> = [];
    const botClient = {
      updateOriginalInteractionResponse: (interactionToken: string, payload: unknown) => {
        updateCalls.push({ interactionToken, payload });
        return Effect.succeed({ id: "interaction-message-1", channel_id: "channel-1" });
      },
      getMembersForParent: () =>
        Effect.succeed([
          {
            parentId: "guild-1",
            resourceId: "member-1",
            value: { user: { id: "member-1" }, roles: ["role-1"] },
          },
          {
            parentId: "guild-1",
            resourceId: "member-2",
            value: { user: { id: "member-2" }, roles: ["role-1"] },
          },
          {
            parentId: "guild-1",
            resourceId: "member-3",
            value: { user: { id: "member-3" }, roles: ["role-1"] },
          },
        ]),
      removeGuildMemberRole: (guildId: string, memberId: string, roleId: string) => {
        removeCalls.push([guildId, memberId, roleId]);
        return memberId === "member-2"
          ? Effect.fail(new Error("Discord role removal failed"))
          : Effect.succeed({});
      },
    } as never;
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        getGuildChannelById: () =>
          Effect.succeed({
            guildId: "guild-1",
            channelId: "channel-1",
            name: Option.some("main"),
            roleId: Option.some("role-1"),
            running: Option.some(true),
          }),
      },
      schedule: {
        getChannelPopulatedSchedules: () =>
          Effect.succeed({ schedules: [makeSchedule(1, ["member-1"])] }),
      },
    });

    const result = await Effect.runPromise(
      runKickout(
        {
          dispatchRequestId: "dispatch-kickout",
          guildId: "guild-1",
          channelId: "channel-1",
          hour: 1,
          interactionToken: "interaction-token",
        },
        botClient,
        sheetApisClient,
      ),
    );

    expect(result).toEqual({
      guildId: "guild-1",
      runningChannelId: "channel-1",
      hour: 1,
      roleId: "role-1",
      removedMemberIds: ["member-3"],
      status: "removed",
    });
    expect(removeCalls).toEqual([
      ["guild-1", "member-2", "role-1"],
      ["guild-1", "member-3", "role-1"],
    ]);
    expect(updateCalls).toEqual([
      {
        interactionToken: "interaction-token",
        payload: {
          content: "Kicked out <@member-3>",
          allowed_mentions: { parse: [] },
        },
      },
    ]);
  });

  it("lists channel config with formatted fields", async () => {
    const updateCalls: Array<{ readonly interactionToken: string; readonly payload: unknown }> = [];
    const sheetApiCalls: Array<unknown> = [];
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        getGuildChannelById: (args: unknown) => {
          sheetApiCalls.push(args);
          return Effect.succeed(makeGuildChannelConfig());
        },
      },
    });

    const result = await Effect.runPromise(
      runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.channelListConfig({
            ...channelConfigPayload,
            dispatchRequestId: "dispatch-channel-list-config",
          } satisfies ChannelListConfigDispatchPayload),
      ),
    );

    expect(result).toEqual({ guildId: "guild-1", channelId: "channel-1" });
    expect(sheetApiCalls).toEqual([{ query: { guildId: "guild-1", channelId: "channel-1" } }]);
    expect(updateCalls).toEqual([
      {
        interactionToken: "interaction-token",
        payload: {
          embeds: [
            {
              title: "Config for this channel",
              fields: [
                { name: "Name", value: "main" },
                { name: "Running channel", value: "Yes" },
                { name: "Role", value: "<@&role-1>" },
                { name: "Checkin channel", value: "<#checkin-channel-1>" },
              ],
            },
          ],
        },
      },
    ]);
  });

  it("updates channel config and returns the channel result", async () => {
    const updateCalls: Array<{ readonly interactionToken: string; readonly payload: unknown }> = [];
    const sheetApiCalls: Array<unknown> = [];
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        upsertGuildChannelConfig: (args: unknown) => {
          sheetApiCalls.push(args);
          return Effect.succeed(makeGuildChannelConfig({ name: Option.some("side") }));
        },
      },
    });

    const result = await Effect.runPromise(
      runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.channelSet({
            ...channelConfigPayload,
            dispatchRequestId: "dispatch-channel-set",
            running: false,
            name: "side",
            roleId: "role-2",
            checkinChannelId: "checkin-channel-2",
          } satisfies ChannelSetDispatchPayload),
      ),
    );

    expect(result).toEqual({ guildId: "guild-1", channelId: "channel-1" });
    expect(sheetApiCalls).toEqual([
      {
        payload: {
          guildId: "guild-1",
          channelId: "channel-1",
          config: {
            running: false,
            name: "side",
            roleId: "role-2",
            checkinChannelId: "checkin-channel-2",
          },
        },
      },
    ]);
    expect(updateCalls[0]?.payload).toMatchObject({
      embeds: [
        {
          title: "Success!",
          description: "<#channel-1> configuration updated",
          fields: expect.arrayContaining([{ name: "Name", value: "side" }]),
        },
      ],
    });
  });

  it("unsets channel config fields", async () => {
    const updateCalls: Array<{ readonly interactionToken: string; readonly payload: unknown }> = [];
    const sheetApiCalls: Array<unknown> = [];
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        upsertGuildChannelConfig: (args: unknown) => {
          sheetApiCalls.push(args);
          return Effect.succeed(
            makeGuildChannelConfig({
              name: Option.none(),
              running: Option.none(),
              roleId: Option.none(),
              checkinChannelId: Option.none(),
            }),
          );
        },
      },
    });

    const result = await Effect.runPromise(
      runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.channelUnset({
            ...channelConfigPayload,
            dispatchRequestId: "dispatch-channel-unset",
            running: true,
            name: true,
            role: true,
            checkinChannel: true,
          } satisfies ChannelUnsetDispatchPayload),
      ),
    );

    expect(result).toEqual({ guildId: "guild-1", channelId: "channel-1" });
    expect(sheetApiCalls).toEqual([
      {
        payload: {
          guildId: "guild-1",
          channelId: "channel-1",
          config: {
            running: null,
            name: null,
            roleId: null,
            checkinChannelId: null,
          },
        },
      },
    ]);
    expect(updateCalls[0]?.payload).toMatchObject({
      embeds: [{ fields: expect.arrayContaining([{ name: "Name", value: "None!" }]) }],
    });
  });

  it("lists server config with monitor role mentions", async () => {
    const updateCalls: Array<{ readonly interactionToken: string; readonly payload: unknown }> = [];
    const sheetApiCalls: Array<unknown> = [];
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        getGuildConfig: (args: unknown) => {
          sheetApiCalls.push(["getGuildConfig", args]);
          return Effect.succeed(makeGuildConfig());
        },
        getGuildMonitorRoles: (args: unknown) => {
          sheetApiCalls.push(["getGuildMonitorRoles", args]);
          return Effect.succeed([
            new GuildConfigMonitorRole({
              guildId: "guild-1",
              roleId: "role-1",
              createdAt: Option.none(),
              updatedAt: Option.none(),
              deletedAt: Option.none(),
            }),
          ]);
        },
      },
    });

    const result = await Effect.runPromise(
      runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.serverListConfig({
            ...commandBase,
            dispatchRequestId: "dispatch-server-list-config",
            guildId: "guild-1",
          } satisfies ServerListConfigDispatchPayload),
      ),
    );

    expect(result).toEqual({ guildId: "guild-1", monitorRoleCount: 1 });
    expect(sheetApiCalls).toEqual([
      ["getGuildConfig", { query: { guildId: "guild-1" } }],
      ["getGuildMonitorRoles", { query: { guildId: "guild-1" } }],
    ]);
    expect(updateCalls[0]?.payload).toMatchObject({
      embeds: [
        {
          title: "Config for Guild One",
          description: "Sheet id: sheet-1\nAuto check-in: Enabled\nMonitor roles: <@&role-1>",
        },
      ],
    });
  });

  it("adds a server monitor role", async () => {
    const updateCalls: Array<{ readonly interactionToken: string; readonly payload: unknown }> = [];
    const sheetApiCalls: Array<unknown> = [];
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        addGuildMonitorRole: (args: unknown) => {
          sheetApiCalls.push(args);
          return Effect.succeed({});
        },
      },
    });

    const result = await Effect.runPromise(
      runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.serverAddMonitorRole({
            ...commandBase,
            dispatchRequestId: "dispatch-server-add-monitor-role",
            guildId: "guild-1",
            roleId: "role-1",
          } satisfies ServerAddMonitorRoleDispatchPayload),
      ),
    );

    expect(result).toEqual({ guildId: "guild-1", roleId: "role-1" });
    expect(sheetApiCalls).toEqual([{ payload: { guildId: "guild-1", roleId: "role-1" } }]);
    expect(updateCalls[0]?.payload).toMatchObject({
      embeds: [{ description: "<@&role-1> is now a monitor role for Guild One" }],
    });
  });

  it("removes a server monitor role", async () => {
    const updateCalls: Array<{ readonly interactionToken: string; readonly payload: unknown }> = [];
    const sheetApiCalls: Array<unknown> = [];
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        removeGuildMonitorRole: (args: unknown) => {
          sheetApiCalls.push(args);
          return Effect.succeed({});
        },
      },
    });

    const result = await Effect.runPromise(
      runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.serverRemoveMonitorRole({
            ...commandBase,
            dispatchRequestId: "dispatch-server-remove-monitor-role",
            guildId: "guild-1",
            roleId: "role-1",
          } satisfies ServerRemoveMonitorRoleDispatchPayload),
      ),
    );

    expect(result).toEqual({ guildId: "guild-1", roleId: "role-1" });
    expect(sheetApiCalls).toEqual([{ payload: { guildId: "guild-1", roleId: "role-1" } }]);
    expect(updateCalls[0]?.payload).toMatchObject({
      embeds: [{ description: "<@&role-1> is no longer a monitor role for Guild One" }],
    });
  });

  it("sets the server sheet id", async () => {
    const updateCalls: Array<{ readonly interactionToken: string; readonly payload: unknown }> = [];
    const sheetApiCalls: Array<unknown> = [];
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        upsertGuildConfig: (args: unknown) => {
          sheetApiCalls.push(args);
          return Effect.succeed(makeGuildConfig({ sheetId: Option.some("sheet-2") }));
        },
      },
    });

    const result = await Effect.runPromise(
      runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.serverSetSheet({
            ...commandBase,
            dispatchRequestId: "dispatch-server-set-sheet",
            guildId: "guild-1",
            sheetId: "sheet-2",
          } satisfies ServerSetSheetDispatchPayload),
      ),
    );

    expect(result).toEqual({ guildId: "guild-1", sheetId: "sheet-2" });
    expect(sheetApiCalls).toEqual([
      { payload: { guildId: "guild-1", config: { sheetId: "sheet-2" } } },
    ]);
    expect(updateCalls[0]?.payload).toMatchObject({
      embeds: [{ description: "Sheet id for Guild One is now set to sheet-2" }],
    });
  });

  it("sets server auto check-in", async () => {
    const updateCalls: Array<{ readonly interactionToken: string; readonly payload: unknown }> = [];
    const sheetApiCalls: Array<unknown> = [];
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        upsertGuildConfig: (args: unknown) => {
          sheetApiCalls.push(args);
          return Effect.succeed(makeGuildConfig({ autoCheckin: Option.some(false) }));
        },
      },
    });

    const result = await Effect.runPromise(
      runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.serverSetAutoCheckin({
            ...commandBase,
            dispatchRequestId: "dispatch-server-set-auto-checkin",
            guildId: "guild-1",
            autoCheckin: false,
          } satisfies ServerSetAutoCheckinDispatchPayload),
      ),
    );

    expect(result).toEqual({ guildId: "guild-1", autoCheckin: false });
    expect(sheetApiCalls).toEqual([
      { payload: { guildId: "guild-1", config: { autoCheckin: false } } },
    ]);
    expect(updateCalls[0]?.payload).toMatchObject({
      embeds: [{ description: "Auto check-in for Guild One is now disabled." }],
    });
  });

  it("formats a user's team list", async () => {
    const updateCalls: Array<{ readonly interactionToken: string; readonly payload: unknown }> = [];
    const sheetApiCalls: Array<unknown> = [];
    const sheetApisClient = makeSheetApisClient({
      player: {
        getTeamsByIds: (args: unknown) => {
          sheetApiCalls.push(args);
          return Effect.succeed([
            [
              new Team({
                type: "player",
                playerId: Option.some("user-1"),
                playerName: Option.some("Alice"),
                teamName: Option.some("Cool Team"),
                tags: ["tag1"],
                lead: 100,
                backline: 200,
                talent: Option.some(50),
              }),
            ],
          ]);
        },
      },
    });

    const result = await Effect.runPromise(
      runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.teamList({
            ...commandBase,
            dispatchRequestId: "dispatch-team-list",
            guildId: "guild-1",
            targetUserId: "user-1",
            targetUsername: "Alice",
          } satisfies TeamListDispatchPayload),
      ),
    );

    expect(result).toEqual({ guildId: "guild-1", targetUserId: "user-1", teamCount: 1 });
    expect(sheetApiCalls).toEqual([{ query: { guildId: "guild-1", ids: ["user-1"] } }]);
    expect(updateCalls[0]?.payload).toMatchObject({
      embeds: [
        {
          title: "Alice's Teams",
          fields: [
            {
              name: "Cool Team",
              value: "Tags: tag1\nISV: 100/200/50k (+120%)",
            },
          ],
        },
      ],
    });
  });

  it("formats a user's schedule list", async () => {
    const updateCalls: Array<{ readonly interactionToken: string; readonly payload: unknown }> = [];
    const sheetApiCalls: Array<unknown> = [];
    const sheetApisClient = makeSheetApisClient({
      schedule: {
        getDayPlayerSchedule: (args: unknown) => {
          sheetApiCalls.push(args);
          return Effect.succeed({
            schedule: {
              invisible: false,
              fillHours: [1, 2, 4],
              overfillHours: [5],
              standbyHours: [],
            },
          });
        },
      },
    });

    const result = await Effect.runPromise(
      runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.scheduleList({
            ...commandBase,
            dispatchRequestId: "dispatch-schedule-list",
            guildId: "guild-1",
            day: 2,
            targetUserId: "user-1",
            targetUsername: "Alice",
          } satisfies ScheduleListDispatchPayload),
      ),
    );

    expect(result).toEqual({
      guildId: "guild-1",
      day: 2,
      targetUserId: "user-1",
      invisible: false,
    });
    expect(sheetApiCalls).toEqual([
      { query: { guildId: "guild-1", day: 2, accountId: "user-1", view: "filler" } },
    ]);
    expect(updateCalls[0]?.payload).toMatchObject({
      embeds: [
        {
          title: "Alice's Schedule for Day 2",
          fields: [
            { name: "Fill", value: "1-2, 4" },
            { name: "Overfill", value: "5" },
            { name: "Standby", value: "None" },
          ],
        },
        {
          description:
            "📅 **Preview**: View your schedule online at <https://schedule.theerapakg.moe/>",
        },
      ],
    });
  });

  it("updates screenshot responses with a png file payload", async () => {
    const screenshot = new Uint8Array([1, 2, 3, 4]);
    const fileCalls: Array<{
      readonly interactionToken: string;
      readonly payload: unknown;
      readonly files: unknown;
    }> = [];
    const botClient = {
      updateOriginalInteractionResponseWithFiles: (
        interactionToken: string,
        payload: unknown,
        files: unknown,
      ) => {
        fileCalls.push({ interactionToken, payload, files });
        return Effect.succeed({ id: "message-1", channel_id: "channel-1" });
      },
    } as never;
    const sheetApisClient = makeSheetApisClient({
      screenshot: {
        getScreenshot: ({ query }: { readonly query: unknown }) => {
          expect(query).toEqual({ guildId: "guild-1", channel: "main", day: 2 });
          return Effect.succeed(screenshot);
        },
      },
    });

    const result = await Effect.runPromise(runScreenshot(botClient, sheetApisClient));

    expect(result).toEqual({
      guildId: "guild-1",
      channelName: "main",
      day: 2,
      byteLength: 4,
    });
    expect(fileCalls).toEqual([
      {
        interactionToken: "interaction-token",
        payload: {
          attachments: [
            {
              id: "0",
              description: "Day 2's schedule screenshot",
              filename: "screenshot.png",
            },
          ],
        },
        files: [
          {
            name: "screenshot.png",
            contentType: "image/png",
            content: screenshot,
          },
        ],
      },
    ]);
  });
});

const runKickout = (
  payload: KickoutDispatchPayload,
  botClient: typeof IngressBotClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
  clockTime = Date.parse("2026-05-13T00:00:00.000Z"),
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(clockTime);
      const service = yield* DispatchService.make;
      return yield* service.kickout(payload, requester);
    }).pipe(
      Effect.provideService(IngressBotClient, botClient),
      Effect.provideService(SheetApisClient, sheetApisClient),
      Effect.provide(TestClock.layer()),
    ),
  );
