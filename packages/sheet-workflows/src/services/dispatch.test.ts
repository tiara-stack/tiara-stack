// fallow-ignore-file code-duplication
import { describe, expect, it } from "@effect/vitest";
import { Cause, DateTime, Effect, Exit, Option } from "effect";
import { TestClock } from "effect/testing";
import { formatTentativeRoomOrderContent } from "sheet-ingress-api/clientActions";
import type {
  AutoCheckinTestDispatchPayload,
  ConversationListConfigDispatchPayload,
  ConversationSetDispatchPayload,
  ConversationUnsetDispatchPayload,
  WorkspaceWelcomeDispatchPayload,
  KickoutDispatchPayload,
  ScheduleListDispatchPayload,
  ServiceWorkspaceFeatureFlagDispatchPayload,
  WorkspaceAddMonitorRoleDispatchPayload,
  WorkspaceListConfigDispatchPayload,
  WorkspaceRemoveMonitorRoleDispatchPayload,
  WorkspaceSetAutoCheckinDispatchPayload,
  WorkspaceSetSheetDispatchPayload,
  ScreenshotDispatchPayload,
  ServiceStatusDispatchPayload,
  SlotButtonDispatchPayload,
  SlotOpenButtonPayload,
  TeamListDispatchPayload,
  UpdateAnnouncementDispatchPayload,
} from "sheet-ingress-api/handlers/dispatch/schema";
import {
  WorkspaceConversationConfig,
  WorkspaceConfig,
  WorkspaceFeatureFlag,
  WorkspaceMonitorRole,
  WorkspaceUpdateAnnouncementDelivery,
} from "sheet-ingress-api/schemas/workspaceConfig";
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
import { DispatchService, ClientDeliveryClient, SheetApisClient } from "@/services";
import {
  makeSheetApisClient as makeBaseSheetApisClient,
  normalizePayloadText,
  renderTextForTest,
  text,
} from "./testHelpers";

const discordClient = { platform: "discord", clientId: "discord-main" } as const;

const makeSheetApisClient = (
  services: Record<string, unknown>,
  prefix = "Unexpected Sheet API call",
) => makeBaseSheetApisClient(services, prefix);

const workspaceWelcomePayload: WorkspaceWelcomeDispatchPayload = {
  client: discordClient,
  dispatchRequestId: "discord-workspace-create:workspace-1:2026-05-31T00:00:00.000Z",
  workspaceId: "workspace-1",
  workspaceName: "Workspace One",
  joinedAt: "2026-05-31T00:00:00.000Z",
  systemConversationId: "system-conversation",
};

const slotButtonPayload: SlotButtonDispatchPayload = {
  client: discordClient,
  dispatchRequestId: "dispatch-slot-button",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  day: 2,
  interactionResponseToken: "interaction-token",
  interactionResponseDeadlineEpochMs: 1_700_000_000_000,
};

const slotOpenButtonPayload: SlotOpenButtonPayload = {
  client: discordClient,
  messageId: "message-1",
  interactionResponseToken: "interaction-token",
  interactionResponseDeadlineEpochMs: 1_700_000_000_000,
};

const serviceStatusPayload: ServiceStatusDispatchPayload = {
  client: discordClient,
  dispatchRequestId: "dispatch-service-status",
  interactionResponseToken: "interaction-token",
  interactionResponseDeadlineEpochMs: 1_700_000_000_000,
};

const serviceWorkspaceFeatureFlagPayload: ServiceWorkspaceFeatureFlagDispatchPayload = {
  client: discordClient,
  dispatchRequestId: "dispatch-service-add-workspace-feature-flag",
  workspaceId: "workspace-1",
  flagName: "beta-feature",
  systemConversationId: "system-conversation",
};

const updateAnnouncementPayload: UpdateAnnouncementDispatchPayload = {
  client: discordClient,
  dispatchRequestId: "discord-update-announcement:workspace-1:update-announcements-2026-06-05",
  workspaceId: "workspace-1",
  workspaceName: "Workspace One",
  joinedAt: "2026-06-04T16:59:59.999Z",
  systemConversationId: "system-conversation",
  announcement: {
    id: "update-announcements-2026-06-05",
    publishedAt: "2026-06-04T17:00:00.000Z",
    title: "Update announcements",
    description: "Update announcement description",
    color: 0x5865f2,
  },
};

const screenshotPayload: ScreenshotDispatchPayload = {
  client: discordClient,
  dispatchRequestId: "dispatch-screenshot",
  workspaceId: "workspace-1",
  conversationName: "main",
  day: 2,
  interactionResponseToken: "interaction-token",
  interactionResponseDeadlineEpochMs: 1_700_000_000_000,
};

const commandBase = {
  client: discordClient,
  interactionResponseToken: "interaction-token",
  interactionResponseDeadlineEpochMs: 1_700_000_000_000,
};

const autoCheckinTestPayload: AutoCheckinTestDispatchPayload = {
  ...commandBase,
  dispatchRequestId: "dispatch-auto-checkin-test",
  workspaceId: "workspace-1",
  anchorConversationId: "anchor-conversation-1",
};

const conversationConfigPayload = {
  ...commandBase,
  dispatchRequestId: "dispatch-conversation-config",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
};

const messageSlot = new MessageSlot({
  clientPlatform: "discord",
  clientId: "discord-main",
  messageId: slotOpenButtonPayload.messageId,
  day: 2,
  workspaceId: Option.some("workspace-1"),
  conversationId: Option.some("conversation-1"),
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
  renderTextForTest(
    (payload as { embeds?: ReadonlyArray<{ description?: unknown }> }).embeds?.[0]?.description,
  );

const firstEmbedFields = (
  payload: unknown,
): ReadonlyArray<{ readonly name: string; readonly value: string; readonly inline?: boolean }> =>
  (
    payload as {
      embeds?: ReadonlyArray<{ fields?: ReadonlyArray<{ name: unknown; value: unknown }> }>;
    }
  ).embeds?.[0]?.fields?.map((field) => ({
    ...field,
    name: renderTextForTest(field.name) ?? "",
    value: renderTextForTest(field.value) ?? "",
  })) ?? [];

const firstRawEmbedFields = (
  payload: unknown,
): ReadonlyArray<{ readonly name: unknown; readonly value: unknown; readonly inline?: boolean }> =>
  (
    payload as {
      embeds?: ReadonlyArray<{ fields?: ReadonlyArray<{ name: unknown; value: unknown }> }>;
    }
  ).embeds?.[0]?.fields ?? [];

const expectTestRunAnchorLink = (payload: unknown) => {
  const testRunField = firstRawEmbedFields(payload).find(
    (field) => renderTextForTest(field.name) === "Test run",
  );

  expect(testRunField?.value).toEqual([
    expect.objectContaining({
      type: "messageLink",
      label: "message",
      message: expect.objectContaining({
        messageId: "anchor-message",
        conversation: expect.objectContaining({
          conversationId: "anchor-conversation-1",
        }),
      }),
    }),
  ]);
};

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

const makeMessageSlotSheetApisClient = (
  upsertMessageSlotData: (args: unknown) => Effect.Effect<unknown, unknown>,
) =>
  makeSheetApisClient(
    {
      messageSlot: {
        upsertMessageSlotData,
      },
    },
    "Unexpected Sheet API call",
  );

const runSlotButton = (
  botClient: typeof ClientDeliveryClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
) =>
  Effect.gen(function* () {
    const service = yield* DispatchService.make;
    return yield* service.slotButton(slotButtonPayload, requester);
  }).pipe(
    Effect.provideService(ClientDeliveryClient, botClient),
    Effect.provideService(SheetApisClient, sheetApisClient),
  );

const runSlotOpenButton = (
  botClient: typeof ClientDeliveryClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
) =>
  Effect.gen(function* () {
    const service = yield* DispatchService.make;
    return yield* service.slotOpenButton(slotOpenButtonPayload, messageSlot);
  }).pipe(
    Effect.provideService(ClientDeliveryClient, botClient),
    Effect.provideService(SheetApisClient, sheetApisClient),
  );

const runServiceStatus = (
  botClient: typeof ClientDeliveryClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
) =>
  Effect.gen(function* () {
    const service = yield* DispatchService.make;
    return yield* service.serviceStatus(serviceStatusPayload);
  }).pipe(
    Effect.provideService(ClientDeliveryClient, botClient),
    Effect.provideService(SheetApisClient, sheetApisClient),
  );

const runWorkspaceWelcome = (
  botClient: typeof ClientDeliveryClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
) =>
  Effect.gen(function* () {
    const service = yield* DispatchService.make;
    return yield* service.workspaceWelcome(workspaceWelcomePayload);
  }).pipe(
    Effect.provideService(ClientDeliveryClient, botClient),
    Effect.provideService(SheetApisClient, sheetApisClient),
  );

const runServiceAddWorkspaceFeatureFlag = (
  botClient: typeof ClientDeliveryClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
  payload: ServiceWorkspaceFeatureFlagDispatchPayload = serviceWorkspaceFeatureFlagPayload,
) =>
  Effect.gen(function* () {
    const service = yield* DispatchService.make;
    return yield* service.serviceAddWorkspaceFeatureFlag(payload);
  }).pipe(
    Effect.provideService(ClientDeliveryClient, botClient),
    Effect.provideService(SheetApisClient, sheetApisClient),
  );

const runServiceRemoveWorkspaceFeatureFlag = (
  botClient: typeof ClientDeliveryClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
  payload: ServiceWorkspaceFeatureFlagDispatchPayload = {
    ...serviceWorkspaceFeatureFlagPayload,
    dispatchRequestId: "dispatch-service-remove-workspace-feature-flag",
  },
) =>
  Effect.gen(function* () {
    const service = yield* DispatchService.make;
    return yield* service.serviceRemoveWorkspaceFeatureFlag(payload);
  }).pipe(
    Effect.provideService(ClientDeliveryClient, botClient),
    Effect.provideService(SheetApisClient, sheetApisClient),
  );

const runUpdateAnnouncement = (
  botClient: typeof ClientDeliveryClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
  payload: UpdateAnnouncementDispatchPayload = updateAnnouncementPayload,
) =>
  Effect.gen(function* () {
    const service = yield* DispatchService.make;
    return yield* service.updateAnnouncement(payload);
  }).pipe(
    Effect.provideService(ClientDeliveryClient, botClient),
    Effect.provideService(SheetApisClient, sheetApisClient),
  );

const runScreenshot = (
  botClient: typeof ClientDeliveryClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
) =>
  Effect.gen(function* () {
    const service = yield* DispatchService.make;
    return yield* service.screenshot(screenshotPayload);
  }).pipe(
    Effect.provideService(ClientDeliveryClient, botClient),
    Effect.provideService(SheetApisClient, sheetApisClient),
  );

const runWithDispatchService = <A>(
  botClient: typeof ClientDeliveryClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
  f: (service: typeof DispatchService.Service) => Effect.Effect<A, unknown>,
) =>
  Effect.gen(function* () {
    const service = yield* DispatchService.make;
    return yield* f(service);
  }).pipe(
    Effect.provideService(ClientDeliveryClient, botClient),
    Effect.provideService(SheetApisClient, sheetApisClient),
  );

const makeInteractionUpdateBotClient = (updateCalls: Array<unknown>) =>
  ({
    getWorkspace: (workspaceId: string) =>
      Effect.succeed({
        id: workspaceId,
        name: workspaceId === "workspace-1" ? "Workspace One" : workspaceId,
      }),
    updateOriginalInteractionResponse: (interactionResponseToken: string, payload: unknown) => {
      updateCalls.push({ interactionResponseToken, payload: normalizePayloadText(payload) });
      return Effect.succeed({ id: "message-1", conversation_id: "conversation-1" });
    },
  }) as never;

const makeKickoutPayload = (
  overrides: Partial<KickoutDispatchPayload> = {},
): KickoutDispatchPayload => ({
  client: discordClient,
  dispatchRequestId: "dispatch-kickout",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  hour: 1,
  interactionResponseToken: "interaction-token",
  ...overrides,
});

const expectInteractionUpdateContent = (updateCalls: ReadonlyArray<unknown>, content: string) => {
  expect(updateCalls).toEqual([
    {
      interactionResponseToken: "interaction-token",
      payload: {
        content,
        allowedMentions: "none",
      },
    },
  ]);
};

const makeWorkspaceConversationConfig = (
  overrides: Partial<ConstructorParameters<typeof WorkspaceConversationConfig>[0]> = {},
) =>
  new WorkspaceConversationConfig({
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    name: Option.some("main"),
    running: Option.some(true),
    roleId: Option.some("role-1"),
    checkinConversationId: Option.some("checkin-conversation-1"),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
    ...overrides,
  });

const makeWorkspaceConfig = (
  overrides: Partial<ConstructorParameters<typeof WorkspaceConfig>[0]> = {},
) =>
  new WorkspaceConfig({
    workspaceId: "workspace-1",
    sheetId: Option.some("sheet-1"),
    autoCheckin: Option.some(true),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
    ...overrides,
  });

const makeWorkspaceFeatureFlag = (
  overrides: Partial<ConstructorParameters<typeof WorkspaceFeatureFlag>[0]> = {},
) =>
  new WorkspaceFeatureFlag({
    workspaceId: "workspace-1",
    flagName: "beta-feature",
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
    ...overrides,
  });

const makeWorkspaceUpdateAnnouncementDelivery = (
  overrides: Partial<ConstructorParameters<typeof WorkspaceUpdateAnnouncementDelivery>[0]> = {},
) =>
  new WorkspaceUpdateAnnouncementDelivery({
    workspaceId: "workspace-1",
    announcementId: updateAnnouncementPayload.announcement.id,
    publishedAt: Option.some(
      DateTime.makeUnsafe(updateAnnouncementPayload.announcement.publishedAt),
    ),
    deliveredAt: Option.some(DateTime.makeUnsafe("2026-06-04T17:01:00.000Z")),
    conversationId: "system-conversation",
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
      readonly delivery: Option.Option<WorkspaceUpdateAnnouncementDelivery>;
    };
  } = {},
) =>
  makeSheetApisClient({
    workspaceConfig: {
      getWorkspaceFeatureFlags: () =>
        Effect.succeed([
          makeWorkspaceFeatureFlag({ flagName: updateAnnouncementsFeatureFlagName }),
        ]),
      claimWorkspaceUpdateAnnouncementDelivery: (args: unknown) => {
        options.claimCalls?.push(args);
        return Effect.succeed(
          options.claimResult ?? {
            status: "claimed" as const,
            delivery: Option.some(makeWorkspaceUpdateAnnouncementDelivery()),
          },
        );
      },
      releaseWorkspaceUpdateAnnouncementDeliveryClaim: (args: unknown) => {
        options.releaseCalls?.push(args);
        return Effect.void;
      },
      recordWorkspaceUpdateAnnouncementDelivery: (args: unknown) => {
        recordCalls.push(args);
        return Effect.succeed(makeWorkspaceUpdateAnnouncementDelivery());
      },
    },
  });

const makeConversationEntry = (overrides: {
  readonly id: string;
  readonly type?: number;
  readonly name?: string;
  readonly position?: number;
}) => ({
  parentId: "workspace-1",
  resourceId: overrides.id,
  value: {
    id: overrides.id,
    workspace_id: "workspace-1",
    type: overrides.type ?? 0,
    name: overrides.name ?? overrides.id,
    position: overrides.position ?? 0,
  },
});

const roomOrderButtonPayload = {
  client: discordClient,
  workspaceId: "workspace-1",
  messageId: "room-order-message-1",
  messageConversationId: "conversation-1",
  messageContent: null,
  interactionResponseToken: "interaction-token",
  interactionResponseDeadlineEpochMs: 1_700_000_000_000,
};

const makeMessageRoomOrder = (
  overrides: Partial<ConstructorParameters<typeof MessageRoomOrder>[0]> = {},
) =>
  new MessageRoomOrder({
    clientPlatform: "discord",
    clientId: "discord-main",
    messageId: roomOrderButtonPayload.messageId,
    previousFills: [],
    fills: ["Akito"],
    hour: 1,
    rank: 2,
    tentative: false,
    monitor: Option.none(),
    workspaceId: Option.some("workspace-1"),
    conversationId: Option.some("conversation-1"),
    createdByUserId: Option.some("discord-user-1"),
    sendClaimId: Option.none(),
    sendClaimedAt: Option.none(),
    sentMessageId: Option.none(),
    sentConversationId: Option.none(),
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
    clientPlatform: "discord",
    clientId: "discord-main",
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
  makeInteractionUpdateBotClient(updateCalls);

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
            sentConversationId: Option.some("conversation-1"),
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
  it.live("sends first-hour auto check-in test previews without persistent message state", () =>
    Effect.gen(function* () {
      const updateCalls: Array<{
        readonly interactionResponseToken: string;
        readonly payload: unknown;
      }> = [];
      const sendCalls: Array<{
        readonly conversationId: string;
        readonly payload: unknown;
        readonly rawPayload: unknown;
      }> = [];
      const checkinGenerateCalls: Array<unknown> = [];
      const roomOrderGenerateCalls: Array<unknown> = [];
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceConversations: (args: unknown) => {
            expect(args).toEqual({ query: { workspaceId: "workspace-1", running: true } });
            return Effect.succeed([makeWorkspaceConversationConfig()]);
          },
        },
        checkin: {
          generate: (args: unknown) => {
            checkinGenerateCalls.push(args);
            return Effect.succeed({
              hour: 1,
              runningConversationId: "conversation-1",
              checkinConversationId: "checkin-conversation-1",
              fillCount: 5,
              roleId: "role-1",
              initialMessage: text("Check in user-1"),
              monitorCheckinMessage: text("Monitor summary monitor-1"),
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
              content: text("Room order content user-1"),
              runningConversationId: "conversation-1",
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
          persistMessageRoomOrder: () =>
            Effect.die("test run must not persist room-order messages"),
        },
      });
      const botClient = {
        updateOriginalInteractionResponse: (interactionResponseToken: string, payload: unknown) => {
          updateCalls.push({ interactionResponseToken, payload: normalizePayloadText(payload) });
          return Effect.succeed({ id: "anchor-message", conversation_id: "anchor-conversation-1" });
        },
        updateMessage: () => Effect.die("test run must update the anchor through the interaction"),
        sendMessage: (conversationId: string, payload: unknown) => {
          sendCalls.push({
            conversationId,
            payload: normalizePayloadText(payload),
            rawPayload: payload,
          });
          return Effect.succeed({
            id: `preview-message-${sendCalls.length}`,
            conversation_id: conversationId,
          });
        },
      } as never;

      const result = yield* runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.autoCheckinTest(autoCheckinTestPayload, requester),
      );

      expect(result).toMatchObject({
        workspaceId: "workspace-1",
        hour: 1,
        anchorMessageId: "anchor-message",
        anchorMessageConversationId: "anchor-conversation-1",
        conversationCount: 1,
        sentCount: 1,
        skippedCount: 0,
        failedCount: 0,
      });
      expect(result.conversations).toEqual([
        {
          conversationName: "main",
          runningConversationId: "conversation-1",
          checkinConversationId: "checkin-conversation-1",
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
            workspaceId: "workspace-1",
            conversationName: "main",
            hour: 1,
          },
        },
      ]);
      expect(roomOrderGenerateCalls).toEqual([
        { payload: { workspaceId: "workspace-1", conversationId: "conversation-1", hour: 1 } },
      ]);
      expect(updateCalls).toHaveLength(2);
      expect(firstEmbedDescription(updateCalls[0]?.payload)).toContain("Requested by @account-1.");
      expect(firstEmbedDescription(updateCalls[0]?.payload)).not.toContain("@discord-user-1");
      expect(sendCalls.map((call) => call.conversationId)).toEqual([
        "checkin-conversation-1",
        "conversation-1",
        "conversation-1",
      ]);
      for (const call of sendCalls) {
        expect(call.payload).toMatchObject({
          content: null,
          allowedMentions: "none",
        });
        expect(call.payload).not.toHaveProperty("message_reference");
        expect(firstEmbedFields(call.payload)).toContainEqual({
          name: "Test run",
          value: "message",
        });
        expectTestRunAnchorLink(call.rawPayload);
        expect((call.payload as { embeds?: ReadonlyArray<unknown> }).embeds).toHaveLength(1);
        expect(
          (
            call.payload as {
              embeds: ReadonlyArray<{ title?: string; footer?: { text?: string } }>;
            }
          ).embeds[0],
        ).toMatchObject({
          title: expect.stringContaining("TEST RUN"),
          footer: {
            text: expect.stringContaining("TEST RUN"),
          },
        });
      }
    }),
  );

  it.live("omits native message references for same-conversation auto check-in test previews", () =>
    Effect.gen(function* () {
      const updateCalls: Array<{
        readonly interactionResponseToken: string;
        readonly payload: unknown;
      }> = [];
      const sendCalls: Array<{
        readonly conversationId: string;
        readonly payload: unknown;
        readonly rawPayload: unknown;
      }> = [];
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceConversations: () => Effect.succeed([makeWorkspaceConversationConfig()]),
        },
        checkin: {
          generate: () =>
            Effect.succeed({
              hour: 1,
              runningConversationId: "anchor-conversation-1",
              checkinConversationId: "anchor-conversation-1",
              fillCount: 0,
              roleId: "role-1",
              initialMessage: null,
              monitorCheckinMessage: text("Monitor summary"),
              monitorUserId: "monitor-1",
              monitorFailureMessage: null,
              fillIds: [],
            }),
        },
      });
      const botClient = {
        updateOriginalInteractionResponse: (interactionResponseToken: string, payload: unknown) => {
          updateCalls.push({ interactionResponseToken, payload: normalizePayloadText(payload) });
          return Effect.succeed({ id: "anchor-message", conversation_id: "anchor-conversation-1" });
        },
        updateMessage: () => Effect.die("test run must update the anchor through the interaction"),
        sendMessage: (conversationId: string, payload: unknown) => {
          sendCalls.push({
            conversationId,
            payload: normalizePayloadText(payload),
            rawPayload: payload,
          });
          return Effect.succeed({ id: "preview-message-1", conversation_id: conversationId });
        },
      } as never;

      const result = yield* runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.autoCheckinTest(autoCheckinTestPayload, requester),
      );

      expect(result).toMatchObject({
        conversationCount: 1,
        sentCount: 0,
        skippedCount: 1,
        failedCount: 0,
      });
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]).toMatchObject({
        conversationId: "anchor-conversation-1",
        payload: {
          content: null,
          allowedMentions: "none",
        },
      });
      expect(sendCalls[0]?.payload).not.toHaveProperty("message_reference");
      expect(firstEmbedFields(sendCalls[0]?.payload)).toContainEqual({
        name: "Test run",
        value: "message",
      });
      expectTestRunAnchorLink(sendCalls[0]?.rawPayload);
    }),
  );

  it.live("surfaces first auto check-in test conversation failure details in the summary", () =>
    Effect.gen(function* () {
      const updateCalls: Array<{
        readonly interactionResponseToken: string;
        readonly payload: unknown;
      }> = [];
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceConversations: () => Effect.succeed([makeWorkspaceConversationConfig()]),
        },
        checkin: {
          generate: () => Effect.fail(new Error("Unable to parse range: 'Day 9'!J3:N23")),
        },
      });
      const botClient = {
        updateOriginalInteractionResponse: (interactionResponseToken: string, payload: unknown) => {
          updateCalls.push({ interactionResponseToken, payload: normalizePayloadText(payload) });
          return Effect.succeed({ id: "anchor-message", conversation_id: "anchor-conversation-1" });
        },
        updateMessage: () => Effect.die("test run must update the anchor through the interaction"),
        sendMessage: () => Effect.die("failed conversation must not send preview messages"),
      } as never;

      const result = yield* runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.autoCheckinTest(autoCheckinTestPayload, requester),
      );

      expect(result).toMatchObject({
        conversationCount: 1,
        sentCount: 0,
        skippedCount: 0,
        failedCount: 1,
      });
      expect(result.conversations[0]).toMatchObject({
        conversationName: "main",
        status: "failed",
      });
      expect(result.conversations[0]?.error).toContain("Unable to parse range: 'Day 9'!J3:N23");
      expect(updateCalls).toHaveLength(2);
      expect(firstEmbedDescription(updateCalls[1]?.payload)).toContain(
        "Failed conversations: main",
      );
      expect(firstEmbedDescription(updateCalls[1]?.payload)).toContain(
        "First failure detail for main:",
      );
      expect(firstEmbedDescription(updateCalls[1]?.payload)).toContain(
        "Unable to parse range: 'Day 9'!J3:N23",
      );
    }),
  );

  it.live("sends the workspace welcome embed to the system conversation first", () =>
    Effect.gen(function* () {
      const sendCalls: Array<{ readonly conversationId: string; readonly payload: unknown }> = [];
      const botClient = {
        getConversationsForParent: () =>
          Effect.succeed([
            makeConversationEntry({ id: "general", name: "general", position: 1 }),
            makeConversationEntry({ id: "system-conversation", name: "welcome", position: 2 }),
          ]),
        sendMessage: (conversationId: string, payload: unknown) => {
          sendCalls.push({ conversationId, payload: normalizePayloadText(payload) });
          return Effect.succeed({ id: "welcome-message", conversation_id: conversationId });
        },
      } as never;

      const result = yield* runWorkspaceWelcome(botClient, makeSheetApisClient({}));

      expect(result).toEqual({
        workspaceId: "workspace-1",
        conversationId: "system-conversation",
        messageId: "welcome-message",
      });
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]?.conversationId).toBe("system-conversation");
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
                  "This bot needs a compatible Google Sheet adapter before it can do useful work. For now, message @394295776655966219 (Theerie) to get one.",
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
          },
        ],
      });
    }),
  );

  it.live(
    "falls back to general and then sorted sendable conversations for workspace welcome",
    () =>
      Effect.gen(function* () {
        const sendCalls: Array<string> = [];
        const botClient = {
          getConversationsForParent: () =>
            Effect.succeed([
              makeConversationEntry({ id: "voice", type: 2, name: "voice", position: 0 }),
              makeConversationEntry({ id: "late", name: "late", position: 20 }),
              makeConversationEntry({ id: "general", name: "General", position: 50 }),
              makeConversationEntry({ id: "early", name: "early", position: 10 }),
            ]),
          sendMessage: (conversationId: string) => {
            sendCalls.push(conversationId);
            return conversationId === "general"
              ? Effect.fail(new Error("cannot send general"))
              : Effect.succeed({
                  id: `message-${conversationId}`,
                  conversation_id: conversationId,
                });
          },
        } as never;

        const result = yield* runWorkspaceWelcome(botClient, makeSheetApisClient({}));

        expect(result).toEqual({
          workspaceId: "workspace-1",
          conversationId: "early",
          messageId: "message-early",
        });
        expect(sendCalls).toEqual(["general", "early"]);
      }),
  );

  it.live("fails workspace welcome when no conversation can receive the message", () =>
    Effect.gen(function* () {
      const botClient = {
        getConversationsForParent: () =>
          Effect.succeed([
            makeConversationEntry({ id: "voice", type: 2, name: "voice", position: 0 }),
          ]),
        sendMessage: () => Effect.die("sendMessage should not be called"),
      } as never;

      const exit = yield* Effect.exit(runWorkspaceWelcome(botClient, makeSheetApisClient({})));

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
    }),
  );

  it.live("adds a workspace feature flag and announces to the system conversation first", () =>
    Effect.gen(function* () {
      const sheetApiCalls: Array<unknown> = [];
      const sendCalls: Array<{ readonly conversationId: string; readonly payload: unknown }> = [];
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          addWorkspaceFeatureFlag: (args: unknown) => {
            sheetApiCalls.push(args);
            return Effect.succeed(makeWorkspaceFeatureFlag());
          },
        },
      });
      const botClient = {
        getConversationsForParent: () =>
          Effect.succeed([
            makeConversationEntry({ id: "general", name: "general", position: 1 }),
            makeConversationEntry({ id: "system-conversation", name: "welcome", position: 2 }),
          ]),
        sendMessage: (conversationId: string, payload: unknown) => {
          sendCalls.push({ conversationId, payload: normalizePayloadText(payload) });
          return Effect.succeed({ id: "feature-message", conversation_id: conversationId });
        },
      } as never;

      const result = yield* runServiceAddWorkspaceFeatureFlag(botClient, sheetApisClient);

      expect(result).toEqual({
        workspaceId: "workspace-1",
        flagName: "beta-feature",
        announcementConversationId: "system-conversation",
        announcementMessageId: "feature-message",
      });
      expect(sheetApiCalls).toEqual([
        { payload: { workspaceId: "workspace-1", flagName: "beta-feature" } },
      ]);
      expect(sendCalls).toEqual([
        {
          conversationId: "system-conversation",
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
    }),
  );

  it.live("removes a workspace feature flag and falls back to general for the announcement", () =>
    Effect.gen(function* () {
      const sheetApiCalls: Array<unknown> = [];
      const sendCalls: Array<string> = [];
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          removeWorkspaceFeatureFlag: (args: unknown) => {
            sheetApiCalls.push(args);
            return Effect.succeed(makeWorkspaceFeatureFlag());
          },
        },
      });
      const botClient = {
        getConversationsForParent: () =>
          Effect.succeed([
            makeConversationEntry({ id: "general", name: "general", position: 1 }),
            makeConversationEntry({ id: "early", name: "early", position: 0 }),
          ]),
        sendMessage: (conversationId: string) => {
          sendCalls.push(conversationId);
          return Effect.succeed({ id: "feature-message", conversation_id: conversationId });
        },
      } as never;

      const result = yield* runServiceRemoveWorkspaceFeatureFlag(botClient, sheetApisClient, {
        ...serviceWorkspaceFeatureFlagPayload,
        dispatchRequestId: "dispatch-service-remove-workspace-feature-flag",
        systemConversationId: "missing-system-conversation",
      });

      expect(result).toEqual({
        workspaceId: "workspace-1",
        flagName: "beta-feature",
        announcementConversationId: "general",
        announcementMessageId: "feature-message",
      });
      expect(sheetApiCalls).toEqual([
        { payload: { workspaceId: "workspace-1", flagName: "beta-feature" } },
      ]);
      expect(sendCalls).toEqual(["general"]);
    }),
  );

  it.live(
    "keeps workspace feature flag mutation success when the announcement cannot be sent",
    () =>
      Effect.gen(function* () {
        const sheetApisClient = makeSheetApisClient({
          workspaceConfig: {
            addWorkspaceFeatureFlag: () => Effect.succeed(makeWorkspaceFeatureFlag()),
          },
        });
        const botClient = {
          getConversationsForParent: () =>
            Effect.succeed([
              makeConversationEntry({ id: "general", name: "general", position: 1 }),
            ]),
          sendMessage: () => Effect.fail(new Error("cannot send")),
        } as never;

        const result = yield* runServiceAddWorkspaceFeatureFlag(botClient, sheetApisClient);

        expect(result).toEqual({
          workspaceId: "workspace-1",
          flagName: "beta-feature",
          announcementConversationId: null,
          announcementMessageId: null,
        });
      }),
  );

  it.live("skips update announcements for workspaces without the gate feature flag", () =>
    Effect.gen(function* () {
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceFeatureFlags: () => Effect.succeed([]),
        },
      });
      const botClient = {} as never;

      const result = yield* runUpdateAnnouncement(botClient, sheetApisClient);

      expect(result).toEqual({
        workspaceId: "workspace-1",
        announcementId: "update-announcements-2026-06-05",
        status: "skipped_not_gated",
        announcementConversationId: null,
        announcementMessageId: null,
      });
    }),
  );

  it.live("skips update announcements that were already delivered", () =>
    Effect.gen(function* () {
      const sheetApisClient = makeGatedUpdateAnnouncementSheetApisClient([], {
        claimResult: {
          status: "already_delivered",
          delivery: Option.some(makeWorkspaceUpdateAnnouncementDelivery()),
        },
      });
      const botClient = {} as never;

      const result = yield* runUpdateAnnouncement(botClient, sheetApisClient);

      expect(result).toEqual({
        workspaceId: "workspace-1",
        announcementId: "update-announcements-2026-06-05",
        status: "skipped_already_delivered",
        announcementConversationId: "system-conversation",
        announcementMessageId: "update-message",
      });
    }),
  );

  it.live("skips update announcements that are already claimed", () =>
    Effect.gen(function* () {
      const sendCalls: Array<unknown> = [];
      const sheetApisClient = makeGatedUpdateAnnouncementSheetApisClient([], {
        claimResult: {
          status: "already_claimed",
          delivery: Option.none(),
        },
      });
      const botClient = {
        getConversationsForParent: () => Effect.succeed([]),
        sendMessage: (conversationId: string, payload: unknown) => {
          sendCalls.push({ conversationId, payload: normalizePayloadText(payload) });
          return Effect.succeed({ id: "update-message", conversation_id: conversationId });
        },
      } as never;

      const result = yield* runUpdateAnnouncement(botClient, sheetApisClient);

      expect(result).toEqual({
        workspaceId: "workspace-1",
        announcementId: "update-announcements-2026-06-05",
        status: "skipped_already_delivered",
        announcementConversationId: null,
        announcementMessageId: null,
      });
      expect(sendCalls).toEqual([]);
    }),
  );

  it.live("sends gated update announcements and records delivery", () =>
    Effect.gen(function* () {
      const claimCalls: Array<unknown> = [];
      const recordCalls: Array<unknown> = [];
      const sendCalls: Array<{ readonly conversationId: string; readonly payload: unknown }> = [];
      const sheetApisClient = makeGatedUpdateAnnouncementSheetApisClient(recordCalls, {
        claimCalls,
      });
      const botClient = {
        getConversationsForParent: () =>
          Effect.succeed([
            makeConversationEntry({ id: "general", name: "general", position: 1 }),
            makeConversationEntry({ id: "system-conversation", name: "welcome", position: 2 }),
          ]),
        sendMessage: (conversationId: string, payload: unknown) => {
          sendCalls.push({ conversationId, payload: normalizePayloadText(payload) });
          return Effect.succeed({ id: "update-message", conversation_id: conversationId });
        },
      } as never;

      const result = yield* runUpdateAnnouncement(botClient, sheetApisClient);

      expect(result).toEqual({
        workspaceId: "workspace-1",
        announcementId: "update-announcements-2026-06-05",
        status: "sent",
        announcementConversationId: "system-conversation",
        announcementMessageId: "update-message",
      });
      expect(sendCalls).toEqual([
        {
          conversationId: "system-conversation",
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
          workspaceId: "workspace-1",
          announcementId: "update-announcements-2026-06-05",
        },
      });
      expect(recordCalls).toHaveLength(1);
      expect(recordCalls[0]).toMatchObject({
        payload: {
          workspaceId: "workspace-1",
          announcementId: "update-announcements-2026-06-05",
          conversationId: "system-conversation",
          messageId: "update-message",
        },
      });
    }),
  );

  it.live("does not record update announcement delivery when sending fails", () =>
    Effect.gen(function* () {
      const recordCalls: Array<unknown> = [];
      const releaseCalls: Array<unknown> = [];
      const sheetApisClient = makeGatedUpdateAnnouncementSheetApisClient(recordCalls, {
        releaseCalls,
      });
      const botClient = {
        getConversationsForParent: () =>
          Effect.succeed([makeConversationEntry({ id: "system-conversation", name: "welcome" })]),
        sendMessage: () => Effect.fail(new Error("cannot send")),
      } as never;

      const exit = yield* Effect.exit(runUpdateAnnouncement(botClient, sheetApisClient));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(recordCalls).toEqual([]);
      expect(releaseCalls).toHaveLength(1);
      expect(releaseCalls[0]).toMatchObject({
        payload: {
          workspaceId: "workspace-1",
          announcementId: "update-announcements-2026-06-05",
        },
      });
    }),
  );

  it.live("persists slot button metadata with the requester Discord user id", () =>
    Effect.gen(function* () {
      const upsertCalls: Array<unknown> = [];
      const botClient = {
        sendMessage: () => Effect.succeed({ id: "message-1", conversation_id: "conversation-1" }),
        updateOriginalInteractionResponse: () =>
          Effect.succeed({ id: "interaction-message-1", conversation_id: "conversation-1" }),
      } as never;
      const sheetApisClient = makeMessageSlotSheetApisClient((args) => {
        upsertCalls.push(args);
        return Effect.succeed({});
      });

      const result = yield* runSlotButton(botClient, sheetApisClient);

      expect(result).toEqual({
        messageId: "message-1",
        messageConversationId: "conversation-1",
        day: 2,
      });
      expect(upsertCalls).toEqual([
        {
          payload: {
            clientPlatform: "discord",
            clientId: "discord-main",
            messageId: "message-1",
            data: {
              day: 2,
              workspaceId: "workspace-1",
              conversationId: "conversation-1",
              createdByUserId: "discord-user-1",
            },
          },
        },
      ]);
    }),
  );

  it.live("deletes the slot button message when metadata persistence fails", () =>
    Effect.gen(function* () {
      const deleteCalls: Array<ReadonlyArray<string>> = [];
      const botClient = {
        sendMessage: () => Effect.succeed({ id: "message-1", conversation_id: "conversation-1" }),
        deleteMessage: (conversationId: string, messageId: string) => {
          deleteCalls.push([conversationId, messageId]);
          return Effect.succeed({});
        },
      } as never;
      const upsertError = new Error("upsert failed");
      const sheetApisClient = makeMessageSlotSheetApisClient(() => Effect.fail(upsertError));

      const exit = yield* Effect.exit(runSlotButton(botClient, sheetApisClient));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons
            .filter(Cause.isFailReason)
            .some((reason) => reason.error === upsertError),
      ).toBe(true);
      expect(deleteCalls).toEqual([["conversation-1", "message-1"]]);
    }),
  );

  it.live("returns slot button success when the final interaction update fails", () =>
    Effect.gen(function* () {
      const upsertCalls: Array<unknown> = [];
      const botClient = {
        sendMessage: () => Effect.succeed({ id: "message-1", conversation_id: "conversation-1" }),
        updateOriginalInteractionResponse: () =>
          Effect.fail(new Error("interaction update failed")),
      } as never;
      const sheetApisClient = makeMessageSlotSheetApisClient((args) => {
        upsertCalls.push(args);
        return Effect.succeed({});
      });

      const result = yield* runSlotButton(botClient, sheetApisClient);

      expect(result).toEqual({
        messageId: "message-1",
        messageConversationId: "conversation-1",
        day: 2,
      });
      expect(upsertCalls).toHaveLength(1);
    }),
  );

  it.live("renders persisted slot button clicks from the cluster", () =>
    Effect.gen(function* () {
      const updateCalls: Array<unknown> = [];
      const botClient = makeInteractionUpdateBotClient(updateCalls);
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

      const result = yield* runSlotOpenButton(botClient, sheetApisClient);

      expect(result).toEqual({
        messageId: "message-1",
        workspaceId: "workspace-1",
        day: 2,
      });
      expect(updateCalls).toEqual([
        {
          interactionResponseToken: "interaction-token",
          payload: {
            embeds: [
              {
                title: "Day 2 Open Slots",
                description:
                  "**+3 |** **hour 1** 2026-03-26T12:00:00.000Z-2026-03-26T13:00:00.000Z",
              },
              {
                title: "Day 2 Filled Slots",
                description: "All Open :3",
              },
            ],
          },
        },
      ]);
    }),
  );

  it.live("updates the interaction with a service status embed", () =>
    Effect.gen(function* () {
      const updateCalls: Array<unknown> = [];
      const checkedAt = DateTime.makeUnsafe("2026-05-23T12:00:00.000Z");
      const botClient = makeInteractionUpdateBotClient(updateCalls);
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

      const result = yield* runServiceStatus(botClient, sheetApisClient);

      expect(result).toEqual({
        overallStatus: "degraded",
        okCount: 1,
        downCount: 1,
      });
      expect(updateCalls).toEqual([
        {
          interactionResponseToken: "interaction-token",
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
    }),
  );

  it.live("handles previous room-order buttons through the decrement path", () =>
    Effect.gen(function* () {
      const updateCalls: Array<unknown> = [];
      const apiCalls: Array<string> = [];
      const initialRoomOrder = makeMessageRoomOrder();
      const botClient = makeRoomOrderUpdateBotClient(updateCalls);
      const sheetApisClient = makeRoomOrderRankSheetApisClient(apiCalls, initialRoomOrder);

      const result = yield* runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.roomOrderPreviousButton(roomOrderButtonPayload, initialRoomOrder),
      );

      expect(result).toEqual({
        messageId: roomOrderButtonPayload.messageId,
        messageConversationId: roomOrderButtonPayload.messageConversationId,
        status: "updated",
        detail: null,
      });
      expect(apiCalls).toEqual(["claim", "decrement", "release"]);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]).toMatchObject({ interactionResponseToken: "interaction-token" });
    }),
  );

  it.live("handles next room-order buttons through the increment path", () =>
    Effect.gen(function* () {
      const apiCalls: Array<string> = [];
      const initialRoomOrder = makeMessageRoomOrder();
      const botClient = makeRoomOrderUpdateBotClient();
      const sheetApisClient = makeRoomOrderRankSheetApisClient(apiCalls, initialRoomOrder);

      const result = yield* runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.roomOrderNextButton(roomOrderButtonPayload, initialRoomOrder),
      );

      expect(result.status).toBe("updated");
      expect(apiCalls).toEqual(["claim", "increment", "release"]);
    }),
  );

  it.live("handles send room-order buttons through the send claim path", () =>
    Effect.gen(function* () {
      const apiCalls: Array<string> = [];
      const botCalls: Array<string> = [];
      const initialRoomOrder = makeMessageRoomOrder();
      const botClient = {
        updateOriginalInteractionResponse: () => {
          botCalls.push("interaction");
          return Effect.succeed({ id: "interaction-message-1", conversation_id: "conversation-1" });
        },
        sendMessage: () => {
          botCalls.push("send");
          return Effect.succeed({ id: "sent-message-1", conversation_id: "conversation-1" });
        },
        createPin: () => {
          botCalls.push("pin");
          return Effect.succeed({});
        },
      } as never;
      const sheetApisClient = makeRoomOrderSendSheetApisClient(apiCalls, initialRoomOrder);

      const result = yield* runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.roomOrderSendButton(roomOrderButtonPayload, initialRoomOrder),
      );

      expect(result).toEqual({
        messageId: "sent-message-1",
        messageConversationId: "conversation-1",
        status: "pinned",
        detail: "sent room order and pinned it!",
      });
      expect(apiCalls).toEqual(["claimSend", "completeSend"]);
      expect(botCalls).toEqual(["send", "pin", "interaction"]);
    }),
  );

  it.live("does not pin registered non-tentative room-order messages", () =>
    Effect.gen(function* () {
      const botCalls: Array<string> = [];
      const initialRoomOrder = makeMessageRoomOrder({ tentative: false });
      const botClient = {
        updateOriginalInteractionResponse: () => {
          botCalls.push("interaction");
          return Effect.succeed({ id: "interaction-message-1", conversation_id: "conversation-1" });
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
        workspaceConfig: {
          getWorkspaceConversationById: () => Effect.succeed(makeWorkspaceConversationConfig()),
        },
      });

      const result = yield* runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.roomOrderPinTentativeButton(roomOrderButtonPayload, initialRoomOrder),
      );

      expect(result).toEqual({
        messageId: roomOrderButtonPayload.messageId,
        messageConversationId: roomOrderButtonPayload.messageConversationId,
        status: "denied",
        detail: "cannot pin a non-tentative room order.",
      });
      expect(botCalls).toEqual(["interaction"]);
    }),
  );

  it.live("keeps the fallback pin path for legacy tentative room-order messages", () =>
    Effect.gen(function* () {
      const botCalls: Array<string> = [];
      const botClient = {
        createPin: () => {
          botCalls.push("pin");
          return Effect.succeed({});
        },
        updateMessage: () => {
          botCalls.push("cleanup");
          return Effect.succeed({ id: "room-order-message-1", conversation_id: "conversation-1" });
        },
        updateOriginalInteractionResponse: () => {
          botCalls.push("interaction");
          return Effect.succeed({ id: "interaction-message-1", conversation_id: "conversation-1" });
        },
      } as never;
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceConversationById: () => Effect.succeed(makeWorkspaceConversationConfig()),
        },
      });

      const result = yield* runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.roomOrderPinTentativeButton(
          {
            ...roomOrderButtonPayload,
            messageContent: formatTentativeRoomOrderContent("Hour 1"),
          },
          null,
        ),
      );

      expect(result).toEqual({
        messageId: "room-order-message-1",
        messageConversationId: "conversation-1",
        status: "pinned",
        detail: "pinned tentative room order!",
      });
      expect(botCalls).toEqual(["pin", "cleanup", "interaction"]);
    }),
  );

  it.live("rejects legacy pin payloads without the tentative marker", () =>
    Effect.gen(function* () {
      const botCalls: Array<string> = [];
      const botClient = {
        createPin: () => {
          botCalls.push("pin");
          return Effect.succeed({});
        },
        updateOriginalInteractionResponse: () => {
          botCalls.push("interaction");
          return Effect.succeed({ id: "interaction-message-1", conversation_id: "conversation-1" });
        },
      } as never;
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceConversationById: () => Effect.succeed(makeWorkspaceConversationConfig()),
        },
      });

      const exit = yield* Effect.exit(
        runWithDispatchService(botClient, sheetApisClient, (service) =>
          service.roomOrderPinTentativeButton(roomOrderButtonPayload, null),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(botCalls).toEqual(["interaction"]);
    }),
  );

  it.live(
    "updates the interaction before failing when kickout cannot find a running conversation",
    () =>
      Effect.gen(function* () {
        const updateCalls: Array<unknown> = [];
        const botClient = makeInteractionUpdateBotClient(updateCalls);
        const sheetApisClient = makeSheetApisClient({
          workspaceConfig: {
            getWorkspaceConversationById: () =>
              Effect.fail({ _tag: "ArgumentError", message: "missing" }),
          },
        });

        const exit = yield* Effect.exit(
          runKickout(makeKickoutPayload(), botClient, sheetApisClient),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        expectInteractionUpdateContent(
          updateCalls,
          "Cannot kick out, running conversation not found",
        );
      }),
  );

  it.live("returns tooEarly and skips sheet lookups when kickout runs too late in the hour", () =>
    Effect.gen(function* () {
      const updateCalls: Array<unknown> = [];
      const sheetApiCalls: Array<string> = [];
      const botClient = makeInteractionUpdateBotClient(updateCalls);
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
                    return () => Effect.die(`Unexpected Sheet API call: ${group}.${method}`);
                  },
                },
              ),
          },
        ),
      );

      const result = yield* runKickout(
        makeKickoutPayload(),
        botClient,
        sheetApisClient,
        Date.parse("2026-05-13T00:40:00.000Z"),
      );

      expect(result).toEqual({
        workspaceId: "workspace-1",
        runningConversationId: "conversation-1",
        hour: 1,
        roleId: null,
        removedMemberIds: [],
        status: "tooEarly",
      });
      expectInteractionUpdateContent(updateCalls, "Cannot kick out until next hour starts");
      expect(sheetApiCalls).toEqual([]);
    }),
  );

  it.live("updates the interaction before failing when kickout conversation has no name", () =>
    Effect.gen(function* () {
      const updateCalls: Array<unknown> = [];
      const botClient = makeInteractionUpdateBotClient(updateCalls);
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceConversationById: () =>
            Effect.succeed({
              workspaceId: "workspace-1",
              conversationId: "conversation-1",
              name: Option.none(),
              roleId: Option.some("role-1"),
              running: Option.some(true),
            }),
        },
      });

      const exit = yield* Effect.exit(runKickout(makeKickoutPayload(), botClient, sheetApisClient));

      expect(Exit.isFailure(exit)).toBe(true);
      expectInteractionUpdateContent(updateCalls, "Cannot kick out, conversation has no name");
    }),
  );

  it.live("does not remove roles when kickout has no schedule for the conversation hour", () =>
    Effect.gen(function* () {
      const updateCalls: Array<unknown> = [];
      const removeCalls: Array<ReadonlyArray<string>> = [];
      const botClient = {
        ...(makeInteractionUpdateBotClient(updateCalls) as Record<string, unknown>),
        getMembersForParent: () => Effect.die("members should not be loaded without a schedule"),
        removeWorkspaceMemberRole: (workspaceId: string, memberId: string, roleId: string) => {
          removeCalls.push([workspaceId, memberId, roleId]);
          return Effect.succeed({});
        },
      } as never;
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceConversationById: () =>
            Effect.succeed({
              workspaceId: "workspace-1",
              conversationId: "conversation-1",
              name: Option.some("main"),
              roleId: Option.some("role-1"),
              running: Option.some(true),
            }),
        },
        schedule: {
          getConversationPopulatedSchedules: () => Effect.succeed({ schedules: [] }),
        },
      });

      const result = yield* runKickout(makeKickoutPayload(), botClient, sheetApisClient);

      expect(result).toEqual({
        workspaceId: "workspace-1",
        runningConversationId: "conversation-1",
        hour: 1,
        roleId: "role-1",
        removedMemberIds: [],
        status: "empty",
      });
      expectInteractionUpdateContent(
        updateCalls,
        "No schedule found for this conversation and hour; no players kicked out",
      );
      expect(removeCalls).toEqual([]);
    }),
  );

  it.live(
    "continues kickout removals and updates the interaction when one role removal fails",
    () =>
      Effect.gen(function* () {
        const updateCalls: Array<unknown> = [];
        const removeCalls: Array<ReadonlyArray<string>> = [];
        const botClient = {
          ...(makeInteractionUpdateBotClient(updateCalls) as Record<string, unknown>),
          getMembersForParent: () =>
            Effect.succeed([
              {
                parentId: "workspace-1",
                resourceId: "member-1",
                value: { user: { id: "member-1" }, roles: ["role-1"] },
              },
              {
                parentId: "workspace-1",
                resourceId: "member-2",
                value: { user: { id: "member-2" }, roles: ["role-1"] },
              },
              {
                parentId: "workspace-1",
                resourceId: "member-3",
                value: { user: { id: "member-3" }, roles: ["role-1"] },
              },
            ]),
          removeWorkspaceMemberRole: (workspaceId: string, memberId: string, roleId: string) => {
            removeCalls.push([workspaceId, memberId, roleId]);
            return memberId === "member-2"
              ? Effect.fail(new Error("Discord role removal failed"))
              : Effect.succeed({});
          },
        } as never;
        const sheetApisClient = makeSheetApisClient({
          workspaceConfig: {
            getWorkspaceConversationById: () =>
              Effect.succeed({
                workspaceId: "workspace-1",
                conversationId: "conversation-1",
                name: Option.some("main"),
                roleId: Option.some("role-1"),
                running: Option.some(true),
              }),
          },
          schedule: {
            getConversationPopulatedSchedules: () =>
              Effect.succeed({ schedules: [makeSchedule(1, ["member-1"])] }),
          },
        });

        const result = yield* runKickout(makeKickoutPayload(), botClient, sheetApisClient);

        expect(result).toEqual({
          workspaceId: "workspace-1",
          runningConversationId: "conversation-1",
          hour: 1,
          roleId: "role-1",
          removedMemberIds: ["member-3"],
          status: "removed",
        });
        expect(removeCalls).toEqual([
          ["workspace-1", "member-2", "role-1"],
          ["workspace-1", "member-3", "role-1"],
        ]);
        expectInteractionUpdateContent(updateCalls, "Kicked out @member-3");
      }),
  );

  it.live("lists conversation config with formatted fields", () =>
    Effect.gen(function* () {
      const updateCalls: Array<{
        readonly interactionResponseToken: string;
        readonly payload: unknown;
      }> = [];
      const sheetApiCalls: Array<unknown> = [];
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceConversationById: (args: unknown) => {
            sheetApiCalls.push(args);
            return Effect.succeed(makeWorkspaceConversationConfig());
          },
        },
      });

      const result = yield* runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.conversationListConfig({
            ...conversationConfigPayload,
            dispatchRequestId: "dispatch-conversation-list-config",
          } satisfies ConversationListConfigDispatchPayload),
      );

      expect(result).toEqual({ workspaceId: "workspace-1", conversationId: "conversation-1" });
      expect(sheetApiCalls).toEqual([
        { query: { workspaceId: "workspace-1", conversationId: "conversation-1" } },
      ]);
      expect(updateCalls).toEqual([
        {
          interactionResponseToken: "interaction-token",
          payload: {
            embeds: [
              {
                title: "Config for this conversation",
                fields: [
                  { name: "Name", value: "main" },
                  { name: "Run destination", value: "Yes" },
                  { name: "Monitor role", value: "@role:role-1" },
                  { name: "Check-in destination", value: "#checkin-conversation-1" },
                ],
              },
            ],
          },
        },
      ]);
    }),
  );

  it.live("updates conversation config and returns the conversation result", () =>
    Effect.gen(function* () {
      const updateCalls: Array<{
        readonly interactionResponseToken: string;
        readonly payload: unknown;
      }> = [];
      const sheetApiCalls: Array<unknown> = [];
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          upsertWorkspaceConversationConfig: (args: unknown) => {
            sheetApiCalls.push(args);
            return Effect.succeed(makeWorkspaceConversationConfig({ name: Option.some("side") }));
          },
        },
      });

      const result = yield* runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.conversationSet({
            ...conversationConfigPayload,
            dispatchRequestId: "dispatch-conversation-set",
            running: false,
            name: "side",
            roleId: "role-2",
            checkinConversationId: "checkin-conversation-2",
          } satisfies ConversationSetDispatchPayload),
      );

      expect(result).toEqual({ workspaceId: "workspace-1", conversationId: "conversation-1" });
      expect(sheetApiCalls).toEqual([
        {
          payload: {
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            config: {
              running: false,
              name: "side",
              roleId: "role-2",
              checkinConversationId: "checkin-conversation-2",
            },
          },
        },
      ]);
      expect(updateCalls[0]?.payload).toMatchObject({
        embeds: [
          {
            title: "Success!",
            description: "#conversation-1 configuration updated",
            fields: expect.arrayContaining([{ name: "Name", value: "side" }]),
          },
        ],
      });
    }),
  );

  it.live("unsets conversation config fields", () =>
    Effect.gen(function* () {
      const updateCalls: Array<{
        readonly interactionResponseToken: string;
        readonly payload: unknown;
      }> = [];
      const sheetApiCalls: Array<unknown> = [];
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          upsertWorkspaceConversationConfig: (args: unknown) => {
            sheetApiCalls.push(args);
            return Effect.succeed(
              makeWorkspaceConversationConfig({
                name: Option.none(),
                running: Option.none(),
                roleId: Option.none(),
                checkinConversationId: Option.none(),
              }),
            );
          },
        },
      });

      const result = yield* runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.conversationUnset({
            ...conversationConfigPayload,
            dispatchRequestId: "dispatch-conversation-unset",
            running: true,
            name: true,
            role: true,
            checkinConversation: true,
          } satisfies ConversationUnsetDispatchPayload),
      );

      expect(result).toEqual({ workspaceId: "workspace-1", conversationId: "conversation-1" });
      expect(sheetApiCalls).toEqual([
        {
          payload: {
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            config: {
              running: null,
              name: null,
              roleId: null,
              checkinConversationId: null,
            },
          },
        },
      ]);
      expect(updateCalls[0]?.payload).toMatchObject({
        embeds: [{ fields: expect.arrayContaining([{ name: "Name", value: "None!" }]) }],
      });
    }),
  );

  it.live("lists server config with monitor role mentions", () =>
    Effect.gen(function* () {
      const updateCalls: Array<{
        readonly interactionResponseToken: string;
        readonly payload: unknown;
      }> = [];
      const sheetApiCalls: Array<unknown> = [];
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceConfig: (args: unknown) => {
            sheetApiCalls.push(["getWorkspaceConfig", args]);
            return Effect.succeed(makeWorkspaceConfig());
          },
          getWorkspaceMonitorRoles: (args: unknown) => {
            sheetApiCalls.push(["getWorkspaceMonitorRoles", args]);
            return Effect.succeed([
              new WorkspaceMonitorRole({
                workspaceId: "workspace-1",
                roleId: "role-1",
                createdAt: Option.none(),
                updatedAt: Option.none(),
                deletedAt: Option.none(),
              }),
            ]);
          },
        },
      });

      const result = yield* runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.workspaceListConfig({
            ...commandBase,
            dispatchRequestId: "dispatch-server-list-config",
            workspaceId: "workspace-1",
          } satisfies WorkspaceListConfigDispatchPayload),
      );

      expect(result).toEqual({ workspaceId: "workspace-1", monitorRoleCount: 1 });
      expect(sheetApiCalls).toEqual([
        ["getWorkspaceConfig", { query: { workspaceId: "workspace-1" } }],
        ["getWorkspaceMonitorRoles", { query: { workspaceId: "workspace-1" } }],
      ]);
      expect(updateCalls[0]?.payload).toMatchObject({
        embeds: [
          {
            title: "Config for Workspace One",
            description: "Sheet id: sheet-1\nAuto check-in: Enabled\nMonitor role: @role:role-1",
          },
        ],
      });
    }),
  );

  it.live("adds a server monitor role", () =>
    Effect.gen(function* () {
      const updateCalls: Array<{
        readonly interactionResponseToken: string;
        readonly payload: unknown;
      }> = [];
      const sheetApiCalls: Array<unknown> = [];
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          addWorkspaceMonitorRole: (args: unknown) => {
            sheetApiCalls.push(args);
            return Effect.succeed({});
          },
        },
      });

      const result = yield* runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.workspaceAddMonitorRole({
            ...commandBase,
            dispatchRequestId: "dispatch-server-add-monitor-role",
            workspaceId: "workspace-1",
            roleId: "role-1",
          } satisfies WorkspaceAddMonitorRoleDispatchPayload),
      );

      expect(result).toEqual({ workspaceId: "workspace-1", roleId: "role-1" });
      expect(sheetApiCalls).toEqual([
        { payload: { workspaceId: "workspace-1", roleId: "role-1" } },
      ]);
      expect(updateCalls[0]?.payload).toMatchObject({
        embeds: [{ description: "@role:role-1 is now a monitor role for Workspace One" }],
      });
    }),
  );

  it.live("removes a server monitor role", () =>
    Effect.gen(function* () {
      const updateCalls: Array<{
        readonly interactionResponseToken: string;
        readonly payload: unknown;
      }> = [];
      const sheetApiCalls: Array<unknown> = [];
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          removeWorkspaceMonitorRole: (args: unknown) => {
            sheetApiCalls.push(args);
            return Effect.succeed({});
          },
        },
      });

      const result = yield* runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.workspaceRemoveMonitorRole({
            ...commandBase,
            dispatchRequestId: "dispatch-server-remove-monitor-role",
            workspaceId: "workspace-1",
            roleId: "role-1",
          } satisfies WorkspaceRemoveMonitorRoleDispatchPayload),
      );

      expect(result).toEqual({ workspaceId: "workspace-1", roleId: "role-1" });
      expect(sheetApiCalls).toEqual([
        { payload: { workspaceId: "workspace-1", roleId: "role-1" } },
      ]);
      expect(updateCalls[0]?.payload).toMatchObject({
        embeds: [{ description: "@role:role-1 is no longer a monitor role for Workspace One" }],
      });
    }),
  );

  it.live("sets the server sheet id", () =>
    Effect.gen(function* () {
      const updateCalls: Array<{
        readonly interactionResponseToken: string;
        readonly payload: unknown;
      }> = [];
      const sheetApiCalls: Array<unknown> = [];
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          upsertWorkspaceConfig: (args: unknown) => {
            sheetApiCalls.push(args);
            return Effect.succeed(makeWorkspaceConfig({ sheetId: Option.some("sheet-2") }));
          },
        },
      });

      const result = yield* runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.workspaceSetSheet({
            ...commandBase,
            dispatchRequestId: "dispatch-server-set-sheet",
            workspaceId: "workspace-1",
            sheetId: "sheet-2",
          } satisfies WorkspaceSetSheetDispatchPayload),
      );

      expect(result).toEqual({ workspaceId: "workspace-1", sheetId: "sheet-2" });
      expect(sheetApiCalls).toEqual([
        { payload: { workspaceId: "workspace-1", config: { sheetId: "sheet-2" } } },
      ]);
      expect(updateCalls[0]?.payload).toMatchObject({
        embeds: [{ description: "Sheet id for Workspace One is now set to sheet-2" }],
      });
    }),
  );

  it.live("sets server auto check-in", () =>
    Effect.gen(function* () {
      const updateCalls: Array<{
        readonly interactionResponseToken: string;
        readonly payload: unknown;
      }> = [];
      const sheetApiCalls: Array<unknown> = [];
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          upsertWorkspaceConfig: (args: unknown) => {
            sheetApiCalls.push(args);
            return Effect.succeed(makeWorkspaceConfig({ autoCheckin: Option.some(false) }));
          },
        },
      });

      const result = yield* runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.workspaceSetAutoCheckin({
            ...commandBase,
            dispatchRequestId: "dispatch-server-set-auto-checkin",
            workspaceId: "workspace-1",
            autoCheckin: false,
          } satisfies WorkspaceSetAutoCheckinDispatchPayload),
      );

      expect(result).toEqual({ workspaceId: "workspace-1", autoCheckin: false });
      expect(sheetApiCalls).toEqual([
        { payload: { workspaceId: "workspace-1", config: { autoCheckin: false } } },
      ]);
      expect(updateCalls[0]?.payload).toMatchObject({
        embeds: [{ description: "Auto check-in for Workspace One is now disabled." }],
      });
    }),
  );

  it.live("formats a user's team list", () =>
    Effect.gen(function* () {
      const updateCalls: Array<{
        readonly interactionResponseToken: string;
        readonly payload: unknown;
      }> = [];
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

      const result = yield* runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.teamList({
            ...commandBase,
            dispatchRequestId: "dispatch-team-list",
            workspaceId: "workspace-1",
            targetUserId: "user-1",
            targetUsername: "Alice",
          } satisfies TeamListDispatchPayload),
      );

      expect(result).toEqual({ workspaceId: "workspace-1", targetUserId: "user-1", teamCount: 1 });
      expect(sheetApiCalls).toEqual([{ query: { workspaceId: "workspace-1", ids: ["user-1"] } }]);
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
    }),
  );

  it.live("formats a user's schedule list", () =>
    Effect.gen(function* () {
      const updateCalls: Array<{
        readonly interactionResponseToken: string;
        readonly payload: unknown;
      }> = [];
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

      const result = yield* runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.scheduleList({
            ...commandBase,
            dispatchRequestId: "dispatch-schedule-list",
            workspaceId: "workspace-1",
            day: 2,
            targetUserId: "user-1",
            targetUsername: "Alice",
          } satisfies ScheduleListDispatchPayload),
      );

      expect(result).toEqual({
        workspaceId: "workspace-1",
        day: 2,
        targetUserId: "user-1",
        invisible: false,
      });
      expect(sheetApiCalls).toEqual([
        { query: { workspaceId: "workspace-1", day: 2, accountId: "user-1", view: "filler" } },
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
              "📅 Preview: View your schedule online at https://schedule.theerapakg.moe/",
          },
        ],
      });
    }),
  );

  it.live("updates screenshot responses with a png file payload", () =>
    Effect.gen(function* () {
      const screenshot = new Uint8Array([1, 2, 3, 4]);
      const fileCalls: Array<{
        readonly interactionResponseToken: string;
        readonly payload: unknown;
        readonly files: unknown;
      }> = [];
      const botClient = {
        updateOriginalInteractionResponseWithFiles: (
          interactionResponseToken: string,
          payload: unknown,
          files: unknown,
        ) => {
          fileCalls.push({ interactionResponseToken, payload, files });
          return Effect.succeed({ id: "message-1", conversation_id: "conversation-1" });
        },
      } as never;
      const sheetApisClient = makeSheetApisClient({
        screenshot: {
          getScreenshot: ({ query }: { readonly query: unknown }) => {
            expect(query).toEqual({ workspaceId: "workspace-1", conversationName: "main", day: 2 });
            return Effect.succeed(screenshot);
          },
        },
      });

      const result = yield* runScreenshot(botClient, sheetApisClient);

      expect(result).toEqual({
        workspaceId: "workspace-1",
        conversationName: "main",
        day: 2,
        byteLength: 4,
      });
      expect(fileCalls).toEqual([
        {
          interactionResponseToken: "interaction-token",
          payload: {},
          files: [
            {
              name: "screenshot.png",
              contentType: "image/png",
              content: screenshot,
            },
          ],
        },
      ]);
    }),
  );
});

const runKickout = (
  payload: KickoutDispatchPayload,
  botClient: typeof ClientDeliveryClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
  clockTime = Date.parse("2026-05-13T00:00:00.000Z"),
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(clockTime);
      const service = yield* DispatchService.make;
      return yield* service.kickout(payload, requester);
    }).pipe(
      Effect.provideService(ClientDeliveryClient, botClient),
      Effect.provideService(SheetApisClient, sheetApisClient),
      Effect.provide(TestClock.layer()),
    ),
  );
