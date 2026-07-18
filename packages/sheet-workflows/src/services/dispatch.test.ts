// fallow-ignore-file code-duplication
import { describe, expect, it } from "@effect/vitest";
import { Cause, DateTime, Duration, Effect, Exit, Fiber, Option, Predicate, Schema } from "effect";
import { TestClock } from "effect/testing";
import { formatTentativeRoomOrderContent } from "sheet-ingress-api/clientActions";
import { DiscordBotNotFoundError } from "sheet-ingress-api/handlers/clientDelivery/api";
import type {
  AutoCheckinTestDispatchPayload,
  CheckinHandleButtonPayload,
  CheckinDispatchPayload,
  ConversationListConfigDispatchPayload,
  ConversationSetDispatchPayload,
  ConversationUnsetDispatchPayload,
  WorkspaceWelcomeDispatchPayload,
  KickoutDispatchPayload,
  RoomOrderDispatchPayload,
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
  TeamSubmissionConfirmButtonDispatchPayload,
  TeamSubmissionDispatchPayload,
  TeamListDispatchPayload,
  UpdateAnnouncementDispatchPayload,
} from "sheet-ingress-api/handlers/dispatch/schema";
import { UpdateAnnouncementDispatchError } from "sheet-ingress-api/handlers/dispatch/schema";
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
import { makeArgumentError } from "typhoon-core/error";
import { DispatchService, ClientDeliveryClient, SheetApisClient } from "@/services";
import {
  isInteractionFailureHandled,
  unwrapInteractionFailure,
} from "@/handlers/shared/interactionFailure";
import * as Data from "effect/Data";
import { makeMessageSink } from "./dispatch/clients/messageDelivery";
import { makeDeliveryNonce } from "./dispatch/pure/deliveryNonce";
import { boundEmbedDescription, escapeMarkdown } from "sheet-message-content/rendering";

class SheetWorkflowsServicesDispatchTestError extends Data.TaggedError(
  "SheetWorkflowsServicesDispatchTestError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
import {
  makeClientDeliveryMock,
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

const checkinButtonPayload: CheckinHandleButtonPayload = {
  client: discordClient,
  messageId: "checkin-message-1",
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

const teamSubmissionPayload: TeamSubmissionDispatchPayload = {
  client: discordClient,
  dispatchRequestId: "dispatch-team-submission",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  messageId: "source-message-1",
  authorId: "discord-user-1",
  authorDisplayName: "Alice",
  content: "full fill: Cool Team",
  editedAt: null,
};

const teamSubmissionButtonPayload: TeamSubmissionConfirmButtonDispatchPayload = {
  client: discordClient,
  dispatchRequestId: "dispatch-team-submission-button",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  messageId: "source-message-1",
  confirmationMessageId: "confirmation-message-1",
  interactionResponseToken: "interaction-token",
  interactionResponseDeadlineEpochMs: 1_700_000_000_000,
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

const roomOrderPayload: RoomOrderDispatchPayload = {
  ...commandBase,
  dispatchRequestId: "dispatch-room-order",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  hour: 1,
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
  accountId: "discord-user-1",
  userId: "auth-user-1",
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

const runRoomOrder = (
  botClient: typeof ClientDeliveryClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
) =>
  Effect.gen(function* () {
    const service = yield* DispatchService.make;
    return yield* service.roomOrder(roomOrderPayload, requester);
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

const makeInteractionUpdateBotClient = (
  updateCalls: Array<unknown>,
  overrides: Partial<typeof ClientDeliveryClient.Service> = {},
) =>
  makeClientDeliveryMock({
    getWorkspace: (workspaceId: string) =>
      Effect.succeed({
        id: workspaceId,
        name: workspaceId === "workspace-1" ? "Workspace One" : workspaceId,
      }),
    updateOriginalInteractionResponse: (interactionResponseToken: string, payload: unknown) => {
      updateCalls.push({ interactionResponseToken, payload: normalizePayloadText(payload) });
      return Effect.succeed({ id: "message-1", conversation_id: "conversation-1" });
    },
    ...overrides,
  });

const makeTeamSubmissionUpsertResult = () => ({
  sourceMessage: {
    conversation: {
      workspace: { client: discordClient, workspaceId: "workspace-1" },
      conversationId: "conversation-1",
    },
    messageId: "source-message-1",
  },
  confirmationMessage: Option.none(),
  parsedTeams: [
    {
      stableKey: "fullFill:1",
      playerName: "Alice",
      teamName: "Cool Team",
      teamType: "fullFill" as const,
      notes: [],
      teamConfigName: "main",
      oshi: { candidate: null, value: null, status: "none" as const },
    },
  ],
  rowMappings: [
    {
      stableKey: "fullFill:1",
      playerNameRange: "Teams!A2",
      teamNameRange: "Teams!B2",
      oshiRange: null,
      rowIndex: 2,
    },
  ],
  rollbackSnapshot: [
    {
      stableKey: "fullFill:1",
      range: "Teams!A2:B2",
      values: [["", ""]],
    },
  ],
  skippedTeams: [],
  confirmationText: "Registered teams from Alice",
  status: "registered" as const,
});

const makeConfirmedTeamSubmissionResult = () => ({
  ...makeTeamSubmissionUpsertResult(),
  confirmationMessage: Option.some({
    conversation: {
      workspace: { client: discordClient, workspaceId: "workspace-1" },
      conversationId: "conversation-1",
    },
    messageId: "confirmation-message-1",
  }),
});

const makeTeamSubmissionDeliveryClient = (
  calls: Array<unknown>,
  options: {
    readonly failAddMessageReaction?: boolean;
    readonly failInteractionUpdate?: boolean;
    readonly failSendMessage?: boolean;
    readonly failUpdateMessage?: boolean;
    readonly updateMessageError?: unknown;
    readonly sentMessageId?: string;
  } = {},
) => {
  const client = {
    forClient: () => client,
    sendMessage: (conversationId: string, payload: unknown) => {
      calls.push({ method: "sendMessage", conversationId, payload: normalizePayloadText(payload) });
      if (options.failSendMessage) {
        return Effect.fail(
          new SheetWorkflowsServicesDispatchTestError({
            message: "message delivery failed",
          }),
        );
      }
      return Effect.succeed({
        id: options.sentMessageId ?? "confirmation-message-1",
        conversation_id: conversationId,
      });
    },
    updateMessage: (conversationId: string, messageId: string, payload: unknown) => {
      calls.push({
        method: "updateMessage",
        conversationId,
        messageId,
        payload: normalizePayloadText(payload),
      });
      if (options.updateMessageError !== undefined) {
        return Effect.fail(options.updateMessageError);
      }
      if (options.failUpdateMessage) {
        return Effect.fail(
          new SheetWorkflowsServicesDispatchTestError({
            message: "message update failed",
          }),
        );
      }
      return Effect.succeed({ id: messageId, conversation_id: conversationId });
    },
    deleteMessage: (conversationId: string, messageId: string) => {
      calls.push({ method: "deleteMessage", conversationId, messageId });
      return Effect.void;
    },
    addMessageReaction: (conversationId: string, messageId: string, emoji: unknown) => {
      calls.push({ method: "addMessageReaction", conversationId, messageId, emoji });
      if (options.failAddMessageReaction) {
        return Effect.fail(
          new SheetWorkflowsServicesDispatchTestError({
            message: "reaction failed",
          }),
        );
      }
      return Effect.void;
    },
    removeMessageReaction: (conversationId: string, messageId: string, emoji: unknown) => {
      calls.push({ method: "removeMessageReaction", conversationId, messageId, emoji });
      return Effect.void;
    },
    updateOriginalInteractionResponse: (interactionResponseToken: string, payload: unknown) => {
      calls.push({
        method: "updateOriginalInteractionResponse",
        interactionResponseToken,
        payload: normalizePayloadText(payload),
      });
      if (options.failInteractionUpdate) {
        return Effect.fail(
          new SheetWorkflowsServicesDispatchTestError({
            message: "interaction update failed",
          }),
        );
      }
      return Effect.succeed({ id: "interaction-message-1", conversation_id: "conversation-1" });
    },
  };
  return client as never;
};

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

// These failure-path tests stop before Discord delivery, but keep the expected
// delivery surface explicit so accidental sends fail loudly.
const unusedUpdateAnnouncementBotClient = makeClientDeliveryMock({
  getConversationsForParent: () => Effect.die("feature flag failure should not read conversations"),
  sendMessage: () => Effect.die("feature flag failure should not send messages"),
});

const updateAnnouncementSuccessBotClient = makeClientDeliveryMock({
  getConversationsForParent: () =>
    Effect.succeed([makeConversationEntry({ id: "system-conversation", name: "welcome" })]),
  sendMessage: () =>
    Effect.succeed({ id: "update-message", conversation_id: "system-conversation" }),
});

const makeGatedUpdateAnnouncementSheetApisClient = (
  recordCalls: Array<unknown>,
  options: {
    readonly claimCalls?: Array<unknown>;
    readonly releaseCalls?: Array<unknown>;
    readonly releaseEffect?: Effect.Effect<void, unknown>;
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
        return options.releaseEffect ?? Effect.void;
      },
      recordWorkspaceUpdateAnnouncementDelivery: (args: unknown) => {
        recordCalls.push(args);
        return Effect.succeed(makeWorkspaceUpdateAnnouncementDelivery());
      },
    },
  });

const expectSerializableUpdateAnnouncementFailure = (
  exit: Exit.Exit<unknown, unknown>,
  message: string,
  causeSnippet: string,
) =>
  Effect.gen(function* () {
    expect(Exit.isFailure(exit)).toBe(true);
    const failures = Exit.isFailure(exit)
      ? exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
      : [];
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      _tag: "UnknownError",
      message,
    });
    expect(Predicate.isString((failures[0] as { readonly cause?: unknown }).cause)).toBe(true);

    const encoded = yield* Schema.encodeUnknownEffect(UpdateAnnouncementDispatchError)(failures[0]);
    expect(encoded).toMatchObject({
      _tag: "UnknownError",
      message,
      cause: expect.stringContaining(causeSnippet),
    });
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

const makeRoomOrderUpdateBotClient = (
  updateCalls: Array<unknown> = [],
  overrides: Partial<typeof ClientDeliveryClient.Service> = {},
) => makeInteractionUpdateBotClient(updateCalls, overrides);

const makeRoomOrderRankSheetApisClient = (
  apiCalls: Array<string>,
  initialRoomOrder: MessageRoomOrder,
  claimedRank = initialRoomOrder.rank,
  expectedRankCalls: Array<number> = [],
  options: {
    readonly getMessageRoomOrderEntry?: () => Effect.Effect<
      ReadonlyArray<MessageRoomOrderEntry>,
      unknown
    >;
    readonly incrementMessageRoomOrderRank?: (payload: {
      readonly expectedRank: number;
      readonly tentativeUpdateClaimId: string;
    }) => Effect.Effect<MessageRoomOrder, unknown>;
  } = {},
) =>
  makeSheetApisClient({
    messageRoomOrder: {
      getMessageRoomOrder: () => Effect.succeed(initialRoomOrder),
      claimMessageRoomOrderTentativeUpdate: ({ payload }: { payload: { claimId: string } }) => {
        apiCalls.push("claim");
        return Effect.succeed(
          makeMessageRoomOrder({
            rank: claimedRank,
            tentativeUpdateClaimId: Option.some(payload.claimId),
          }),
        );
      },
      releaseMessageRoomOrderTentativeUpdateClaim: () => {
        apiCalls.push("release");
        return Effect.succeed({});
      },
      decrementMessageRoomOrderRank: ({
        payload,
      }: {
        payload: { expectedRank: number; tentativeUpdateClaimId: string };
      }) => {
        apiCalls.push("decrement");
        expectedRankCalls.push(payload.expectedRank);
        return Effect.succeed(
          makeMessageRoomOrder({
            rank: payload.expectedRank - 1,
            tentativeUpdateClaimId: Option.some(payload.tentativeUpdateClaimId),
          }),
        );
      },
      incrementMessageRoomOrderRank: ({
        payload,
      }: {
        payload: { expectedRank: number; tentativeUpdateClaimId: string };
      }) => {
        apiCalls.push("increment");
        expectedRankCalls.push(payload.expectedRank);
        return (
          options.incrementMessageRoomOrderRank?.(payload) ??
          Effect.succeed(
            makeMessageRoomOrder({
              rank: payload.expectedRank + 1,
              tentativeUpdateClaimId: Option.some(payload.tentativeUpdateClaimId),
            }),
          )
        );
      },
      getMessageRoomOrderRange: () => Effect.succeed(roomOrderRange),
      getMessageRoomOrderEntry:
        options.getMessageRoomOrderEntry ?? (() => Effect.succeed(roomOrderEntries)),
    },
    sheet: {
      getEventConfig: () => Effect.succeed(roomOrderEventConfig),
    },
  });

const makeRoomOrderSendSheetApisClient = (
  apiCalls: Array<string>,
  initialRoomOrder: MessageRoomOrder,
  claimIds: Array<string> = [],
  completeMessageRoomOrderSend: () => Effect.Effect<MessageRoomOrder, unknown> = () =>
    Effect.succeed(
      makeMessageRoomOrder({
        sentMessageId: Option.some("sent-message-1"),
        sentConversationId: Option.some("conversation-1"),
      }),
    ),
) =>
  makeSheetApisClient({
    messageRoomOrder: {
      getMessageRoomOrder: () => Effect.succeed(initialRoomOrder),
      claimMessageRoomOrderSend: ({ payload }: { payload: { claimId: string } }) => {
        apiCalls.push("claimSend");
        claimIds.push(payload.claimId);
        return Effect.succeed(makeMessageRoomOrder({ sendClaimId: Option.some(payload.claimId) }));
      },
      releaseMessageRoomOrderSendClaim: () => {
        apiCalls.push("releaseSend");
        return Effect.succeed({});
      },
      completeMessageRoomOrderSend: () => {
        apiCalls.push("completeSend");
        return completeMessageRoomOrderSend();
      },
      getMessageRoomOrderRange: () => Effect.succeed(roomOrderRange),
      getMessageRoomOrderEntry: () => Effect.succeed(roomOrderEntries),
    },
    sheet: {
      getEventConfig: () => Effect.succeed(roomOrderEventConfig),
    },
  });

describe("DispatchService", () => {
  it("escapes masked-link Markdown punctuation", () => {
    expect(escapeMarkdown("# [label](https://example.com) - + ! <tag>")).toBe(
      "\\# \\[label\\]\\(https://example.com\\) \\- \\+ \\! \\<tag\\>",
    );
  });

  it("bounds embed descriptions with a readable overflow summary", () => {
    const overflowSummary = "\n… Summary truncated.";
    const description = boundEmbedDescription("x".repeat(5_000), overflowSummary);

    expect(description).toHaveLength(4_096);
    expect(description.endsWith(overflowSummary)).toBe(true);
    expect(boundEmbedDescription("x".repeat(5_000), "s".repeat(5_000))).toHaveLength(4_096);
  });

  it("bounds delivery nonces deterministically", () => {
    const source = "dispatch:workspace:conversation:message-kind";

    expect(makeDeliveryNonce("short-nonce")).toBe("short-nonce");
    expect(makeDeliveryNonce(source)).toHaveLength(25);
    expect(makeDeliveryNonce(source)).toBe(makeDeliveryNonce(source));
  });

  it.effect("uses conversation delivery for empty interaction tokens", () =>
    Effect.gen(function* () {
      const sendCalls: Array<unknown> = [];
      const botClient = makeClientDeliveryMock({
        sendMessage: (conversationId: string, payload: unknown) => {
          sendCalls.push({ conversationId, payload });
          return Effect.succeed({ id: "message-1", conversation_id: conversationId });
        },
        updateOriginalInteractionResponse: () =>
          Effect.die("empty interaction tokens must not use interaction delivery"),
      });

      const result = yield* makeMessageSink(botClient, "conversation-1", "").sendPrimary({
        content: "message",
      });

      expect(result).toEqual({ id: "message-1", conversation_id: "conversation-1" });
      expect(sendCalls).toEqual([
        { conversationId: "conversation-1", payload: { content: "message" } },
      ]);
    }),
  );

  it.effect("fails the persisted room order when enabling its controls fails", () =>
    Effect.gen(function* () {
      const updateCalls: Array<unknown> = [];
      const botClient = makeClientDeliveryMock({
        updateOriginalInteractionResponse: (_token: string, payload: unknown) =>
          Effect.suspend(() => {
            updateCalls.push(payload);
            return updateCalls.length === 1
              ? Effect.succeed({ id: "room-order-message", conversation_id: "conversation-1" })
              : Effect.fail(
                  new SheetWorkflowsServicesDispatchTestError({ message: "update failed" }),
                );
          }),
      });
      const sheetApisClient = makeSheetApisClient({
        roomOrder: {
          generate: () =>
            Effect.succeed({
              content: text("Room order"),
              runningConversationId: "conversation-1",
              range: roomOrderRange,
              rank: 1,
              hour: 1,
              monitor: null,
              previousFills: [],
              fills: ["user-1"],
              entries: [],
            }),
        },
        messageRoomOrder: {
          persistMessageRoomOrder: () => Effect.void,
        },
      });

      const fiber = yield* Effect.forkChild(runRoomOrder(botClient, sheetApisClient));
      yield* TestClock.adjust(Duration.seconds(1));
      const exit = yield* Effect.exit(Fiber.join(fiber));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(updateCalls).toHaveLength(4);
    }),
  );

  it.effect("returns auto-checkin test results when the summary update fails", () =>
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
      const botClient = makeClientDeliveryMock({
        updateOriginalInteractionResponse: (interactionResponseToken: string, payload: unknown) => {
          updateCalls.push({ interactionResponseToken, payload: normalizePayloadText(payload) });
          return updateCalls.length === 1
            ? Effect.succeed({
                id: "anchor-message",
                conversation_id: "anchor-conversation-1",
              })
            : Effect.fail(
                new SheetWorkflowsServicesDispatchTestError({
                  message: "summary update failed",
                }),
              );
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
      });

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
      expect(firstEmbedDescription(updateCalls[0]?.payload)).toContain(
        "Requested by @discord-user-1.",
      );
      expect(firstEmbedDescription(updateCalls[0]?.payload)).not.toContain("@auth-user-1");
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

  it.effect("replaces a public monitor message when check-in delivery fails", () =>
    Effect.gen(function* () {
      const updateCalls: Array<{
        readonly messageId: string;
        readonly payload: unknown;
      }> = [];
      const sheetApisClient = makeSheetApisClient({
        checkin: {
          generate: () =>
            Effect.succeed({
              hour: 1,
              runningConversationId: "running-conversation",
              checkinConversationId: "checkin-conversation",
              fillCount: 0,
              roleId: null,
              initialMessage: text("Check in"),
              monitorCheckinMessage: text("Check-in opened"),
              monitorUserId: null,
              monitorFailureMessage: null,
              fillIds: [],
            }),
        },
        messageCheckin: {
          persistMessageCheckin: () => Effect.succeed({}),
          getMessageCheckinData: () => Effect.succeed(Option.none()),
          removeMessageCheckin: () => Effect.void,
        },
      });
      const botClient = makeClientDeliveryMock({
        sendMessage: (conversationId) =>
          Effect.succeed({
            id:
              conversationId === "running-conversation"
                ? "primary-monitor-message"
                : "checkin-message",
            conversation_id: conversationId,
          }),
        updateMessage: (_conversationId, messageId, updatePayload) => {
          return Effect.suspend(() => {
            updateCalls.push({ messageId, payload: normalizePayloadText(updatePayload) });
            return messageId === "checkin-message"
              ? Effect.fail(
                  new SheetWorkflowsServicesDispatchTestError({
                    message: "check-in enablement failed",
                  }),
                )
              : Effect.succeed({ id: messageId, conversation_id: "running-conversation" });
          });
        },
        deleteMessage: () => Effect.void,
      });
      const checkinPayload: CheckinDispatchPayload = {
        client: discordClient,
        dispatchRequestId: "dispatch-checkin-failure",
        workspaceId: "workspace-1",
      };

      const fiber = yield* Effect.forkChild(
        runWithDispatchService(botClient, sheetApisClient, (service) =>
          service.checkin(checkinPayload, requester),
        ).pipe(Effect.exit),
      );
      yield* TestClock.adjust(Duration.seconds(1));
      const exit = yield* Fiber.join(fiber);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(updateCalls.filter(({ messageId }) => messageId === "checkin-message")).toHaveLength(
        3,
      );
      expect(updateCalls).toContainEqual({
        messageId: "primary-monitor-message",
        payload: { content: "Check-in delivery failed. Please try again." },
      });
    }),
  );

  it.effect(
    "omits native message references for same-conversation auto check-in test previews",
    () =>
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
        const botClient = makeClientDeliveryMock({
          updateOriginalInteractionResponse: (
            interactionResponseToken: string,
            payload: unknown,
          ) => {
            updateCalls.push({ interactionResponseToken, payload: normalizePayloadText(payload) });
            return Effect.succeed({
              id: "anchor-message",
              conversation_id: "anchor-conversation-1",
            });
          },
          updateMessage: () =>
            Effect.die("test run must update the anchor through the interaction"),
          sendMessage: (conversationId: string, payload: unknown) => {
            sendCalls.push({
              conversationId,
              payload: normalizePayloadText(payload),
              rawPayload: payload,
            });
            return Effect.succeed({ id: "preview-message-1", conversation_id: conversationId });
          },
        });

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

  it.effect("sanitizes auto check-in test conversation failure details in the summary", () =>
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
          generate: () =>
            Effect.fail(
              new SheetWorkflowsServicesDispatchTestError({
                message: "Unable to parse range: 'Day 9'!J3:N23",
              }),
            ),
        },
      });
      const botClient = makeClientDeliveryMock({
        updateOriginalInteractionResponse: (interactionResponseToken: string, payload: unknown) => {
          updateCalls.push({ interactionResponseToken, payload: normalizePayloadText(payload) });
          return Effect.succeed({ id: "anchor-message", conversation_id: "anchor-conversation-1" });
        },
        updateMessage: () => Effect.die("test run must update the anchor through the interaction"),
        sendMessage: () => Effect.die("failed conversation must not send preview messages"),
      });

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
      expect(result.conversations[0]?.error).toBe("Test run failed; see server logs.");
      expect(updateCalls).toHaveLength(2);
      expect(firstEmbedDescription(updateCalls[1]?.payload)).toContain(
        "Failed conversations: main",
      );
      expect(firstEmbedDescription(updateCalls[1]?.payload)).toContain(
        "First failure detail for main:",
      );
      expect(firstEmbedDescription(updateCalls[1]?.payload)).toContain(
        "Test run failed; see server logs.",
      );
    }),
  );

  it.effect("sends the workspace welcome embed to the system conversation first", () =>
    Effect.gen(function* () {
      const sendCalls: Array<{ readonly conversationId: string; readonly payload: unknown }> = [];
      const botClient = makeClientDeliveryMock({
        getConversationsForParent: () =>
          Effect.succeed([
            makeConversationEntry({ id: "general", name: "general", position: 1 }),
            makeConversationEntry({ id: "system-conversation", name: "welcome", position: 2 }),
          ]),
        sendMessage: (conversationId: string, payload: unknown) => {
          sendCalls.push({ conversationId, payload: normalizePayloadText(payload) });
          return Effect.succeed({ id: "welcome-message", conversation_id: conversationId });
        },
      });

      const result = yield* runWorkspaceWelcome(botClient, makeSheetApisClient({}));

      expect(result).toEqual({
        workspaceId: "workspace-1",
        conversationId: "system-conversation",
        messageId: "welcome-message",
      });
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]?.conversationId).toBe("system-conversation");
      expect(sendCalls[0]?.payload).toEqual({
        nonce: makeDeliveryNonce(workspaceWelcomePayload.dispatchRequestId),
        enforceNonce: true,
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

  it.effect("stops workspace welcome fallback after an ambiguous send failure", () =>
    Effect.gen(function* () {
      const sendCalls: Array<string> = [];
      const botClient = makeClientDeliveryMock({
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
            ? Effect.fail(
                new SheetWorkflowsServicesDispatchTestError({ message: "cannot send general" }),
              )
            : Effect.succeed({
                id: `message-${conversationId}`,
                conversation_id: conversationId,
              });
        },
      });

      const exit = yield* Effect.exit(runWorkspaceWelcome(botClient, makeSheetApisClient({})));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(sendCalls).toEqual(["general"]);
    }),
  );

  it.effect("fails workspace welcome when no conversation can receive the message", () =>
    Effect.gen(function* () {
      const botClient = makeClientDeliveryMock({
        getConversationsForParent: () =>
          Effect.succeed([
            makeConversationEntry({ id: "voice", type: 2, name: "voice", position: 0 }),
          ]),
        sendMessage: () => Effect.die("sendMessage should not be called"),
      });

      const exit = yield* Effect.exit(runWorkspaceWelcome(botClient, makeSheetApisClient({})));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons
            .filter(Cause.isFailReason)
            .some(
              (reason) =>
                Predicate.isObject(reason.error) &&
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
      const botClient = makeClientDeliveryMock({
        getConversationsForParent: () =>
          Effect.succeed([
            makeConversationEntry({ id: "general", name: "general", position: 1 }),
            makeConversationEntry({ id: "system-conversation", name: "welcome", position: 2 }),
          ]),
        sendMessage: (conversationId: string, payload: unknown) => {
          sendCalls.push({ conversationId, payload: normalizePayloadText(payload) });
          return Effect.succeed({ id: "feature-message", conversation_id: conversationId });
        },
      });

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
            nonce: makeDeliveryNonce("dispatch-service-add-workspace-feature-flag"),
            enforceNonce: true,
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
          sendMessage: () =>
            Effect.fail(new SheetWorkflowsServicesDispatchTestError({ message: "cannot send" })),
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
        status: "skipped_already_claimed",
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
            nonce: makeDeliveryNonce(
              "discord-update-announcement:workspace-1:update-announcements-2026-06-05",
            ),
            enforceNonce: true,
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
        sendMessage: () =>
          Effect.fail(new SheetWorkflowsServicesDispatchTestError({ message: "cannot send" })),
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

  it.effect("preserves update announcement feature-flag failures", () =>
    Effect.gen(function* () {
      const featureFlagError = new SheetWorkflowsServicesDispatchTestError({
        message: "feature flags unavailable",
        cause: { endpoint: "workspaceConfig.getWorkspaceFeatureFlags" },
      });
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceFeatureFlags: () => Effect.fail(featureFlagError),
        },
      });

      const exit = yield* Effect.exit(
        runUpdateAnnouncement(unusedUpdateAnnouncementBotClient, sheetApisClient),
      );

      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
      expect(Option.isSome(failure) && failure.value).toBe(featureFlagError);
    }),
  );

  it.effect("preserves update announcement claim failures", () =>
    Effect.gen(function* () {
      const claimError = new SheetWorkflowsServicesDispatchTestError({
        message: "claim failed",
        cause: { endpoint: "claimWorkspaceUpdateAnnouncementDelivery" },
      });
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceFeatureFlags: () =>
            Effect.succeed([
              makeWorkspaceFeatureFlag({ flagName: updateAnnouncementsFeatureFlagName }),
            ]),
          claimWorkspaceUpdateAnnouncementDelivery: () => Effect.fail(claimError),
        },
      });

      const exit = yield* Effect.exit(
        runUpdateAnnouncement(unusedUpdateAnnouncementBotClient, sheetApisClient),
      );

      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
      expect(Option.isSome(failure) && failure.value).toBe(claimError);
    }),
  );

  it.effect("serializes update announcement send failures", () =>
    Effect.gen(function* () {
      const releaseCalls: Array<unknown> = [];
      const sheetApisClient = makeGatedUpdateAnnouncementSheetApisClient([], {
        releaseCalls,
      });
      const botClient = makeClientDeliveryMock({
        getConversationsForParent: () =>
          Effect.succeed([makeConversationEntry({ id: "system-conversation", name: "welcome" })]),
        sendMessage: () =>
          Effect.fail(
            new SheetWorkflowsServicesDispatchTestError({
              message: "send failed",
              cause: { endpoint: "clientDelivery.sendMessage" },
            }),
          ),
      });

      const exit = yield* Effect.exit(runUpdateAnnouncement(botClient, sheetApisClient));

      yield* expectSerializableUpdateAnnouncementFailure(
        exit,
        "Failed to send update announcement",
        "Cannot send update announcement",
      );
      expect(releaseCalls).toHaveLength(1);
    }),
  );

  it.effect("preserves update announcement send failures when claim release fails", () =>
    Effect.gen(function* () {
      const releaseCalls: Array<unknown> = [];
      const sheetApisClient = makeGatedUpdateAnnouncementSheetApisClient([], {
        releaseCalls,
        releaseEffect: Effect.fail(
          new SheetWorkflowsServicesDispatchTestError({ message: "release failed" }),
        ),
      });
      const botClient = makeClientDeliveryMock({
        getConversationsForParent: () =>
          Effect.succeed([makeConversationEntry({ id: "system-conversation", name: "welcome" })]),
        sendMessage: () =>
          Effect.fail(
            new SheetWorkflowsServicesDispatchTestError({
              message: "send failed",
              cause: { endpoint: "clientDelivery.sendMessage" },
            }),
          ),
      });

      const fiber = yield* Effect.forkChild(
        Effect.exit(runUpdateAnnouncement(botClient, sheetApisClient)),
      );
      yield* TestClock.adjust(Duration.seconds(1));
      const exit = yield* Fiber.join(fiber);

      yield* expectSerializableUpdateAnnouncementFailure(
        exit,
        "Failed to send update announcement",
        "Cannot send update announcement",
      );
      expect(releaseCalls).toHaveLength(1);
    }),
  );

  it.effect("fails update announcement dispatch when delivery recording remains pending", () =>
    Effect.gen(function* () {
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceFeatureFlags: () =>
            Effect.succeed([
              makeWorkspaceFeatureFlag({ flagName: updateAnnouncementsFeatureFlagName }),
            ]),
          claimWorkspaceUpdateAnnouncementDelivery: () =>
            Effect.succeed({
              status: "claimed" as const,
              delivery: Option.some(makeWorkspaceUpdateAnnouncementDelivery()),
            }),
          recordWorkspaceUpdateAnnouncementDelivery: () =>
            Effect.fail(
              new SheetWorkflowsServicesDispatchTestError({
                message: "record failed",
                cause: { endpoint: "recordWorkspaceUpdateAnnouncementDelivery" },
              }),
            ),
        },
      });

      const fiber = yield* Effect.forkChild(
        Effect.exit(runUpdateAnnouncement(updateAnnouncementSuccessBotClient, sheetApisClient)),
      );
      yield* TestClock.adjust(Duration.seconds(1));
      const exit = yield* Fiber.join(fiber);

      yield* expectSerializableUpdateAnnouncementFailure(
        exit,
        "Failed to record update announcement delivery after successful send",
        "record failed",
      );
    }),
  );

  it.effect("does not serialize update announcement interrupts", () =>
    Effect.gen(function* () {
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceFeatureFlags: () => Effect.interrupt,
        },
      });

      const exit = yield* Effect.exit(
        runUpdateAnnouncement(unusedUpdateAnnouncementBotClient, sheetApisClient),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error),
      ).toEqual([]);
    }),
  );

  it.live("persists slot button metadata with the requester Discord user id", () =>
    Effect.gen(function* () {
      const upsertCalls: Array<unknown> = [];
      const sendCalls: Array<unknown> = [];
      const botClient = makeClientDeliveryMock({
        sendMessage: (_conversationId: string, message: unknown) => {
          sendCalls.push(message);
          return Effect.succeed({ id: "message-1", conversation_id: "conversation-1" });
        },
        updateOriginalInteractionResponse: () =>
          Effect.succeed({ id: "interaction-message-1", conversation_id: "conversation-1" }),
      });
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
      expect(sendCalls).toEqual([
        expect.objectContaining({ nonce: "dispatch-slot-button", enforceNonce: true }),
      ]);
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

  it.effect("uses the requester Discord user id for check-in side effects and output", () =>
    Effect.gen(function* () {
      const memberMutationCalls: Array<unknown> = [];
      const roleCalls: Array<ReadonlyArray<string>> = [];
      const sendCalls: Array<{ readonly conversationId: string; readonly payload: unknown }> = [];
      const botClient = makeClientDeliveryMock({
        updateOriginalInteractionResponse: () =>
          Effect.succeed({ id: "interaction-message-1", conversation_id: "conversation-1" }),
        addWorkspaceMemberRole: (workspaceId, memberId, roleId) => {
          roleCalls.push([workspaceId, memberId, roleId]);
          return Effect.succeed({});
        },
        updateMessage: (_conversationId, messageId) =>
          Effect.succeed({ id: messageId, conversation_id: "checkin-conversation-1" }),
        sendMessage: (conversationId, payload) => {
          sendCalls.push({ conversationId, payload });
          return Effect.succeed({ id: "announcement-1", conversation_id: conversationId });
        },
      });
      const sheetApisClient = makeSheetApisClient({
        messageCheckin: {
          getMessageCheckinData: () =>
            Effect.succeed({
              initialMessage: text("Check in"),
              runningConversationId: "running-conversation-1",
              roleId: Option.some("role-1"),
              workspaceId: Option.some("workspace-1"),
              conversationId: Option.some("checkin-conversation-1"),
            }),
          setMessageCheckinMemberCheckinAtIfUnset: (args: {
            readonly payload: { readonly checkinClaimId: string };
          }) => {
            memberMutationCalls.push(args);
            return Effect.succeed({
              memberId: "discord-user-1",
              checkinAt: Option.some({}),
              checkinClaimId: Option.some(args.payload.checkinClaimId),
            });
          },
          getMessageCheckinMembers: () =>
            Effect.succeed([
              {
                memberId: "discord-user-1",
                checkinAt: Option.some({}),
              },
            ]),
        },
      });

      const result = yield* runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.checkinButton(checkinButtonPayload, requester),
      );

      expect(result.checkedInMemberId).toBe("discord-user-1");
      expect(memberMutationCalls).toEqual([
        {
          payload: expect.objectContaining({ memberId: "discord-user-1" }),
        },
      ]);
      expect(roleCalls).toEqual([["workspace-1", "discord-user-1", "role-1"]]);
      expect(sendCalls).toEqual([
        {
          conversationId: "running-conversation-1",
          payload: {
            content: [
              { type: "userMention", userId: "discord-user-1" },
              { type: "text", text: " has checked in!" },
            ],
          },
        },
      ]);
    }),
  );

  it.live("deletes the slot button message when metadata persistence fails", () =>
    Effect.gen(function* () {
      const deleteCalls: Array<ReadonlyArray<string>> = [];
      const botClient = makeClientDeliveryMock({
        sendMessage: () =>
          Effect.succeed({ id: "message-1", conversation_id: "delivered-conversation-1" }),
        deleteMessage: (conversationId: string, messageId: string) => {
          deleteCalls.push([conversationId, messageId]);
          return Effect.succeed({});
        },
      });
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
      expect(deleteCalls).toEqual([["delivered-conversation-1", "message-1"]]);
    }),
  );

  it.effect("returns slot button success when the final interaction update fails", () =>
    Effect.gen(function* () {
      const upsertCalls: Array<unknown> = [];
      const botClient = makeClientDeliveryMock({
        sendMessage: () => Effect.succeed({ id: "message-1", conversation_id: "conversation-1" }),
        updateOriginalInteractionResponse: () =>
          Effect.fail(
            new SheetWorkflowsServicesDispatchTestError({ message: "interaction update failed" }),
          ),
      });
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
                description: "+3 | hour 1 <t:1774526400:t> - <t:1774530000:t>",
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
                description: "Some services are not ready.\nChecked at <t:1779537600:F>",
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
              },
            ],
          },
        },
      ]);
    }),
  );

  it.effect("preserves status lookup failures when the failure response cannot be sent", () =>
    Effect.gen(function* () {
      const lookupError = new SheetWorkflowsServicesDispatchTestError({
        message: "status lookup failed",
      });
      const botClient = makeClientDeliveryMock({
        updateOriginalInteractionResponse: () =>
          Effect.fail(
            new SheetWorkflowsServicesDispatchTestError({
              message: "failure response failed",
            }),
          ),
      });
      const sheetApisClient = makeSheetApisClient({
        status: {
          getServices: () => Effect.fail(lookupError),
        },
      });

      const exit = yield* Effect.exit(runServiceStatus(botClient, sheetApisClient));
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();

      expect(Option.getOrNull(failure)).toBe(lookupError);
      expect(Option.isSome(failure) && isInteractionFailureHandled(failure.value)).toBe(false);
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

  it.effect("handles next room-order buttons through the increment path", () =>
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

  it.effect("uses the claimed room-order rank as the navigation baseline", () =>
    Effect.gen(function* () {
      const apiCalls: Array<string> = [];
      const expectedRankCalls: Array<number> = [];
      const initialRoomOrder = makeMessageRoomOrder({ rank: 2 });
      const botClient = makeRoomOrderUpdateBotClient();
      const sheetApisClient = makeRoomOrderRankSheetApisClient(
        apiCalls,
        initialRoomOrder,
        3,
        expectedRankCalls,
      );

      const result = yield* runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.roomOrderNextButton(roomOrderButtonPayload, initialRoomOrder),
      );

      expect(result.status).toBe("updated");
      expect(expectedRankCalls).toEqual([3]);
      expect(apiCalls).toEqual(["claim", "increment", "release"]);
    }),
  );

  it.effect("preserves a room-order update claim for an ambiguous returned rank", () =>
    Effect.gen(function* () {
      const apiCalls: Array<string> = [];
      const initialRoomOrder = makeMessageRoomOrder({ rank: 2 });
      const sheetApisClient = makeRoomOrderRankSheetApisClient(
        apiCalls,
        initialRoomOrder,
        initialRoomOrder.rank,
        [],
        {
          incrementMessageRoomOrderRank: (payload) =>
            Effect.succeed(
              makeMessageRoomOrder({
                rank: payload.expectedRank + 2,
                tentativeUpdateClaimId: Option.some(payload.tentativeUpdateClaimId),
              }),
            ),
        },
      );

      const exit = yield* Effect.exit(
        runWithDispatchService(makeRoomOrderUpdateBotClient(), sheetApisClient, (service) =>
          service.roomOrderNextButton(roomOrderButtonPayload, initialRoomOrder),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(apiCalls).toEqual(["claim", "increment"]);
      expect(Cause.pretty(Exit.isFailure(exit) ? exit.cause : Cause.empty)).toContain(
        "Room-order rank update returned an ambiguous persisted state; update claim preserved",
      );
    }),
  );

  it.effect("preserves navigation failures when the rollback response cannot be sent", () =>
    Effect.gen(function* () {
      const apiCalls: Array<string> = [];
      const renderError = new SheetWorkflowsServicesDispatchTestError({
        message: "room-order render failed",
      });
      const botClient = makeRoomOrderUpdateBotClient([], {
        updateOriginalInteractionResponse: () =>
          Effect.fail(
            new SheetWorkflowsServicesDispatchTestError({
              message: "rollback response failed",
            }),
          ),
      });
      const initialRoomOrder = makeMessageRoomOrder();
      const sheetApisClient = makeRoomOrderRankSheetApisClient(
        apiCalls,
        initialRoomOrder,
        initialRoomOrder.rank,
        [],
        { getMessageRoomOrderEntry: () => Effect.fail(renderError) },
      );

      const exit = yield* Effect.exit(
        runWithDispatchService(botClient, sheetApisClient, (service) =>
          service.roomOrderNextButton(roomOrderButtonPayload, initialRoomOrder),
        ),
      );
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();

      expect(apiCalls).toEqual(["claim", "increment", "decrement", "release"]);
      expect(Option.isSome(failure)).toBe(true);
      expect(Option.isSome(failure) && isInteractionFailureHandled(failure.value)).toBe(true);
      expect(Cause.pretty(Exit.isFailure(exit) ? exit.cause : Cause.empty)).toContain(
        "room-order render failed",
      );
      expect(Cause.pretty(Exit.isFailure(exit) ? exit.cause : Cause.empty)).not.toContain(
        "rollback response failed",
      );
    }),
  );

  it.effect("handles send room-order buttons through the send claim path", () =>
    Effect.gen(function* () {
      const apiCalls: Array<string> = [];
      const botCalls: Array<string> = [];
      const sentPayloads: Array<unknown> = [];
      const claimIds: Array<string> = [];
      const initialRoomOrder = makeMessageRoomOrder();
      const botClient = makeClientDeliveryMock({
        updateOriginalInteractionResponse: () => {
          botCalls.push("interaction");
          return Effect.succeed({ id: "interaction-message-1", conversation_id: "conversation-1" });
        },
        sendMessage: (_conversationId: string, message: unknown) => {
          botCalls.push("send");
          sentPayloads.push(message);
          return Effect.succeed({ id: "sent-message-1", conversation_id: "conversation-1" });
        },
        createPin: () => {
          botCalls.push("pin");
          return Effect.succeed({});
        },
      });
      const sheetApisClient = makeRoomOrderSendSheetApisClient(
        apiCalls,
        initialRoomOrder,
        claimIds,
      );

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
      expect(claimIds).toEqual(["room-order-send:room-order-message-1"]);
      expect(sentPayloads).toMatchObject([
        {
          nonce: makeDeliveryNonce("room-order-send:room-order-message-1"),
          enforceNonce: true,
          content: expect.any(Array),
          components: expect.any(Array),
        },
      ]);
      expect(botCalls).toEqual(["send", "pin", "interaction"]);
    }),
  );

  it.effect("retries pinning a room-order message that was already sent", () =>
    Effect.gen(function* () {
      const apiCalls: Array<string> = [];
      const botCalls: Array<string> = [];
      const initialRoomOrder = makeMessageRoomOrder({
        sentMessageId: Option.some("sent-message-1"),
        sentConversationId: Option.some("conversation-1"),
      });
      const botClient = makeClientDeliveryMock({
        createPin: (conversationId, messageId) => {
          botCalls.push(`pin:${conversationId}:${messageId}`);
          return Effect.void;
        },
        updateOriginalInteractionResponse: () => {
          botCalls.push("interaction");
          return Effect.succeed({ id: "interaction-message-1", conversation_id: "conversation-1" });
        },
      });
      const sheetApisClient = makeRoomOrderSendSheetApisClient(apiCalls, initialRoomOrder);

      const result = yield* runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.roomOrderSendButton(roomOrderButtonPayload, initialRoomOrder),
      );

      expect(result).toEqual({
        messageId: "sent-message-1",
        messageConversationId: "conversation-1",
        status: "pinned",
        detail: "room order was already sent and is now pinned.",
      });
      expect(apiCalls).toEqual([]);
      expect(botCalls).toEqual(["pin:conversation-1:sent-message-1", "interaction"]);
    }),
  );

  it.effect("returns a partial send when tracking is inconsistent and its update fails", () =>
    Effect.gen(function* () {
      const apiCalls: Array<string> = [];
      const initialRoomOrder = makeMessageRoomOrder();
      const botClient = makeClientDeliveryMock({
        sendMessage: () =>
          Effect.succeed({ id: "sent-message-1", conversation_id: "conversation-1" }),
        updateOriginalInteractionResponse: () =>
          Effect.fail(
            new SheetWorkflowsServicesDispatchTestError({
              message: "interaction update failed",
            }),
          ),
      });
      const sheetApisClient = makeRoomOrderSendSheetApisClient(apiCalls, initialRoomOrder, [], () =>
        Effect.succeed(makeMessageRoomOrder()),
      );

      const result = yield* runWithDispatchService(botClient, sheetApisClient, (service) =>
        service.roomOrderSendButton(roomOrderButtonPayload, initialRoomOrder),
      );

      expect(result).toEqual({
        messageId: "sent-message-1",
        messageConversationId: "conversation-1",
        status: "partial",
        detail: "sent room order, but failed to track it.",
      });
      expect(apiCalls).toEqual(["claimSend", "completeSend"]);
    }),
  );

  it.effect("returns a partial send when tracking is ambiguous and its update fails", () =>
    Effect.gen(function* () {
      const apiCalls: Array<string> = [];
      const initialRoomOrder = makeMessageRoomOrder();
      const botClient = makeClientDeliveryMock({
        sendMessage: () =>
          Effect.succeed({ id: "sent-message-1", conversation_id: "conversation-1" }),
        updateOriginalInteractionResponse: () =>
          Effect.fail(
            new SheetWorkflowsServicesDispatchTestError({
              message: "interaction update failed",
            }),
          ),
      });
      const sheetApisClient = makeRoomOrderSendSheetApisClient(apiCalls, initialRoomOrder, [], () =>
        Effect.fail(new SheetWorkflowsServicesDispatchTestError({ message: "tracking failed" })),
      );
      const fiber = yield* Effect.forkChild(
        runWithDispatchService(botClient, sheetApisClient, (service) =>
          service.roomOrderSendButton(roomOrderButtonPayload, initialRoomOrder),
        ),
      );
      yield* TestClock.adjust(Duration.seconds(5));

      const result = yield* Fiber.join(fiber);

      expect(result).toEqual({
        messageId: "sent-message-1",
        messageConversationId: "conversation-1",
        status: "partial",
        detail: "sent room order, but tracking could not be confirmed; the claim was preserved.",
      });
      expect(apiCalls).toEqual([
        "claimSend",
        "completeSend",
        "completeSend",
        "completeSend",
        "completeSend",
        "completeSend",
      ]);
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
        messageRoomOrder: {
          getMessageRoomOrder: () =>
            Effect.fail({
              _tag: "ArgumentError",
              message: "Cannot get message room order, the message might not be registered",
            }),
        },
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

  it.effect("preserves partial tentative-pin results when the notification fails", () =>
    Effect.gen(function* () {
      const botCalls: Array<string> = [];
      const initialRoomOrder = makeMessageRoomOrder({ tentative: true });
      const botClient = makeClientDeliveryMock({
        createPin: () => {
          botCalls.push("pin");
          return Effect.fail(
            new SheetWorkflowsServicesDispatchTestError({ message: "pin failed" }),
          );
        },
        updateMessage: (_conversationId: string, messageId: string) => {
          botCalls.push("cleanup");
          return Effect.succeed({ id: messageId, conversation_id: "conversation-1" });
        },
        updateOriginalInteractionResponse: () => {
          botCalls.push("interaction");
          return Effect.fail(
            new SheetWorkflowsServicesDispatchTestError({
              message: "partial notification failed",
            }),
          );
        },
      });
      const sheetApisClient = makeSheetApisClient({
        messageRoomOrder: {
          getMessageRoomOrder: () => Effect.succeed(initialRoomOrder),
          claimMessageRoomOrderTentativePin: ({ payload }: { payload: { claimId: string } }) =>
            Effect.succeed(
              makeMessageRoomOrder({
                tentative: true,
                tentativePinClaimId: Option.some(payload.claimId),
              }),
            ),
          getMessageRoomOrderRange: () => Effect.succeed(roomOrderRange),
          getMessageRoomOrderEntry: () => Effect.succeed(roomOrderEntries),
        },
        workspaceConfig: {
          getWorkspaceConversationById: () => Effect.succeed(makeWorkspaceConversationConfig()),
        },
        sheet: {
          getEventConfig: () => Effect.succeed(roomOrderEventConfig),
        },
      });

      const fiber = yield* Effect.forkChild(
        runWithDispatchService(botClient, sheetApisClient, (service) =>
          service.roomOrderPinTentativeButton(roomOrderButtonPayload, initialRoomOrder),
        ),
      );
      yield* TestClock.adjust(Duration.seconds(1));
      const result = yield* Fiber.join(fiber);

      expect(result).toEqual({
        messageId: roomOrderButtonPayload.messageId,
        messageConversationId: roomOrderButtonPayload.messageConversationId,
        status: "partial",
        detail:
          "tentative room-order pin could not be confirmed; message controls were removed and its claim was preserved.",
      });
      expect(botCalls).toEqual(["pin", "cleanup", "interaction"]);
    }),
  );

  it.effect("retries failed tentative-pin claim cleanup on authorization mismatch", () =>
    Effect.gen(function* () {
      const releaseCalls: Array<string> = [];
      const initialRoomOrder = makeMessageRoomOrder({ tentative: true });
      const sheetApisClient = makeSheetApisClient({
        messageRoomOrder: {
          getMessageRoomOrder: () => Effect.succeed(initialRoomOrder),
          claimMessageRoomOrderTentativePin: ({ payload }: { payload: { claimId: string } }) =>
            Effect.succeed(
              makeMessageRoomOrder({
                tentative: true,
                workspaceId: Option.some("different-workspace"),
                tentativePinClaimId: Option.some(payload.claimId),
              }),
            ),
          releaseMessageRoomOrderTentativePinClaim: () =>
            Effect.suspend(() => {
              releaseCalls.push("release");
              return Effect.fail(
                new SheetWorkflowsServicesDispatchTestError({ message: "release failed" }),
              );
            }),
          getMessageRoomOrderRange: () => Effect.succeed(roomOrderRange),
          getMessageRoomOrderEntry: () => Effect.succeed(roomOrderEntries),
        },
        workspaceConfig: {
          getWorkspaceConversationById: () => Effect.succeed(makeWorkspaceConversationConfig()),
        },
        sheet: {
          getEventConfig: () => Effect.succeed(roomOrderEventConfig),
        },
      });
      const fiber = yield* Effect.forkChild(
        runWithDispatchService(makeRoomOrderUpdateBotClient(), sheetApisClient, (service) =>
          service.roomOrderPinTentativeButton(roomOrderButtonPayload, initialRoomOrder),
        ).pipe(Effect.exit),
      );
      yield* TestClock.adjust(Duration.seconds(1));

      const exit = yield* Fiber.join(fiber);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(releaseCalls).toHaveLength(3);
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
        messageRoomOrder: {
          getMessageRoomOrder: () =>
            Effect.fail({
              _tag: "ArgumentError",
              message: "Cannot get message room order, the message might not be registered",
            }),
        },
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
              Effect.fail({
                _tag: "ArgumentError",
                message:
                  "Cannot get conversation by id, the workspace or the conversation id might not be registered or does not match the specified running status",
              }),
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

  it.effect("does not update an interaction for an empty kickout response token", () =>
    Effect.gen(function* () {
      const botClient = makeClientDeliveryMock({
        updateOriginalInteractionResponse: () =>
          Effect.die("empty interaction token must not be delivered"),
      });
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceConversationById: () =>
            Effect.fail({
              _tag: "ArgumentError",
              message:
                "Cannot get conversation by id, the workspace or the conversation id might not be registered or does not match the specified running status",
            }),
        },
      });

      const exit = yield* Effect.exit(
        runKickout(
          makeKickoutPayload({ interactionResponseToken: "" }),
          botClient,
          sheetApisClient,
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false);
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
      const botClient = makeInteractionUpdateBotClient(updateCalls, {
        getMembersForParent: () => Effect.die("members should not be loaded without a schedule"),
        removeWorkspaceMemberRole: (workspaceId: string, memberId: string, roleId: string) => {
          removeCalls.push([workspaceId, memberId, roleId]);
          return Effect.succeed({});
        },
      });
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

  it.effect("reports partial kickout failures after attempting every removal", () =>
    Effect.gen(function* () {
      const updateCalls: Array<unknown> = [];
      const removeCalls: Array<ReadonlyArray<string>> = [];
      const botClient = makeInteractionUpdateBotClient(updateCalls, {
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
            ? Effect.fail(
                new SheetWorkflowsServicesDispatchTestError({
                  message: "Discord role removal failed",
                }),
              )
            : Effect.succeed({});
        },
      });
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

      const exit = yield* Effect.exit(runKickout(makeKickoutPayload(), botClient, sheetApisClient));

      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
      expect(Option.getOrNull(failure)).toMatchObject({
        error: {
          _tag: "UnknownError",
          cause: { failedMemberIds: ["member-2"], removedMemberIds: ["member-3"] },
        },
      });
      expect(removeCalls).toEqual([
        ["workspace-1", "member-2", "role-1"],
        ["workspace-1", "member-3", "role-1"],
      ]);
      expectInteractionUpdateContent(updateCalls, "Kicked out @member-3; 1 role removal(s) failed");
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
          getWorkspaceConversationById: (args: unknown) => {
            sheetApiCalls.push(args);
            return Effect.succeed(makeWorkspaceConversationConfig());
          },
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
        { query: { workspaceId: "workspace-1", conversationId: "conversation-1" } },
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

  it.effect("does not create a conversation config while unsetting missing fields", () =>
    Effect.gen(function* () {
      const upsertWorkspaceConversationConfig = () =>
        Effect.die("missing config must not be upserted");
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceConversationById: () =>
            Effect.fail(
              makeArgumentError(
                "Cannot get conversation by id, the workspace or the conversation id might not be registered",
              ),
            ),
          upsertWorkspaceConversationConfig,
        },
      });

      const exit = yield* runWithDispatchService(
        makeInteractionUpdateBotClient([]),
        sheetApisClient,
        (service) =>
          service.conversationUnset({
            ...conversationConfigPayload,
            dispatchRequestId: "dispatch-conversation-unset-missing",
            name: true,
          } satisfies ConversationUnsetDispatchPayload),
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
      expect(Option.getOrNull(error)).toMatchObject({
        message: "Cannot unset conversation config, conversation conversation-1 is not configured",
      });
    }),
  );

  it.effect("preserves unexpected conversation lookup argument errors", () =>
    Effect.gen(function* () {
      const lookupError = makeArgumentError("conversation lookup request was invalid");
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceConversationById: () => Effect.fail(lookupError),
          upsertWorkspaceConversationConfig: () =>
            Effect.die("invalid lookup must not be followed by an upsert"),
        },
      });

      const exit = yield* runWithDispatchService(
        makeInteractionUpdateBotClient([]),
        sheetApisClient,
        (service) =>
          service.conversationUnset({
            ...conversationConfigPayload,
            dispatchRequestId: "dispatch-conversation-unset-invalid-lookup",
            name: true,
          } satisfies ConversationUnsetDispatchPayload),
      ).pipe(Effect.exit);

      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
      expect(Option.getOrNull(failure)).toBe(lookupError);
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
            description: "Sheet id: sheet\\-1\nAuto check-in: Enabled\nMonitor role: @role:role-1",
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
        embeds: [{ description: "Sheet id for Workspace One is now set to sheet\\-2" }],
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

  it.effect("formats a user's team list", () =>
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

  it.effect("summarizes team lists that exceed Discord embed limits", () =>
    Effect.gen(function* () {
      const updateCalls: Array<{
        readonly interactionResponseToken: string;
        readonly payload: unknown;
      }> = [];
      const sheetApisClient = makeSheetApisClient({
        player: {
          getTeamsByIds: () =>
            Effect.succeed([
              Array.from(
                { length: 30 },
                (_, index) =>
                  new Team({
                    type: "player",
                    playerId: Option.some("user-1"),
                    playerName: Option.some("Alice"),
                    teamName: Option.some(`Team ${index + 1}`),
                    tags: ["tag1"],
                    lead: 100,
                    backline: 200,
                    talent: Option.some(50),
                  }),
              ),
            ]),
        },
      });

      const result = yield* runWithDispatchService(
        makeInteractionUpdateBotClient(updateCalls),
        sheetApisClient,
        (service) =>
          service.teamList({
            ...commandBase,
            dispatchRequestId: "dispatch-large-team-list",
            workspaceId: "workspace-1",
            targetUserId: "user-1",
            targetUsername: "Alice",
          } satisfies TeamListDispatchPayload),
      );

      expect(result.teamCount).toBe(30);
      expect(updateCalls[0]?.payload).toMatchObject({
        embeds: [
          {
            fields: expect.arrayContaining([
              {
                name: "More teams",
                value: "6 additional teams were omitted.",
              },
            ]),
          },
        ],
      });
    }),
  );

  it.effect("uses the text confirmation path when team submission confirmations are disabled", () =>
    Effect.gen(function* () {
      const deliveryCalls: Array<unknown> = [];
      const sheetApiCalls: Array<unknown> = [];
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceFeatureFlags: () => Effect.succeed([]),
        },
        teamSubmission: {
          upsertFromDiscord: (args: unknown) => {
            sheetApiCalls.push(["upsertFromDiscord", args]);
            return Effect.succeed(makeTeamSubmissionUpsertResult());
          },
          setConfirmationMessage: (args: unknown) => {
            sheetApiCalls.push(["setConfirmationMessage", args]);
            return Effect.succeed(makeConfirmedTeamSubmissionResult());
          },
        },
      });

      const result = yield* runWithDispatchService(
        makeTeamSubmissionDeliveryClient(deliveryCalls),
        sheetApisClient,
        (service) => service.teamSubmission(teamSubmissionPayload),
      );

      expect(result.status).toBe("registered");
      expect(sheetApiCalls).toEqual([
        ["upsertFromDiscord", { payload: teamSubmissionPayload }],
        [
          "setConfirmationMessage",
          {
            payload: {
              workspaceId: "workspace-1",
              conversationId: "conversation-1",
              messageId: "source-message-1",
              confirmationMessageId: "confirmation-message-1",
            },
          },
        ],
      ]);
      expect(deliveryCalls).toEqual([
        {
          method: "sendMessage",
          conversationId: "conversation-1",
          payload: {
            content: "Registered teams from Alice",
            allowedMentions: "none",
            nonce: makeDeliveryNonce("team-submission-confirmation:source-message-1"),
            enforceNonce: true,
          },
        },
      ]);
    }),
  );

  it.effect("replaces a deleted stored text confirmation", () =>
    Effect.gen(function* () {
      const deliveryCalls: Array<unknown> = [];
      const setConfirmationCalls: Array<unknown> = [];
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceFeatureFlags: () => Effect.succeed([]),
        },
        teamSubmission: {
          upsertFromDiscord: () => Effect.succeed(makeConfirmedTeamSubmissionResult()),
          setConfirmationMessage: (args: unknown) => {
            setConfirmationCalls.push(args);
            return Effect.succeed(makeConfirmedTeamSubmissionResult());
          },
        },
      });

      const result = yield* runWithDispatchService(
        makeTeamSubmissionDeliveryClient(deliveryCalls, {
          updateMessageError: new DiscordBotNotFoundError({
            message: "Confirmation message not found",
            status: 404,
          }),
          sentMessageId: "replacement-confirmation-message",
        }),
        sheetApisClient,
        (service) => service.teamSubmission(teamSubmissionPayload),
      );

      expect(result.status).toBe("registered");
      expect(deliveryCalls).toMatchObject([
        { method: "updateMessage", messageId: "confirmation-message-1" },
        { method: "sendMessage", conversationId: "conversation-1" },
      ]);
      expect(setConfirmationCalls).toEqual([
        {
          payload: {
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            messageId: "source-message-1",
            confirmationMessageId: "replacement-confirmation-message",
          },
        },
      ]);
    }),
  );

  it.effect("reports when persisted teams cannot receive a text confirmation", () =>
    Effect.gen(function* () {
      const deliveryCalls: Array<unknown> = [];
      const sheetApiCalls: Array<string> = [];
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceFeatureFlags: () => Effect.succeed([]),
        },
        teamSubmission: {
          upsertFromDiscord: () => {
            sheetApiCalls.push("upsertFromDiscord");
            return Effect.succeed(makeTeamSubmissionUpsertResult());
          },
        },
      });

      const exit = yield* Effect.exit(
        runWithDispatchService(
          makeTeamSubmissionDeliveryClient(deliveryCalls, { failSendMessage: true }),
          sheetApisClient,
          (service) => service.teamSubmission(teamSubmissionPayload),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
      expect(Option.isSome(failure) && isInteractionFailureHandled(failure.value)).toBe(true);
      if (Option.isSome(failure)) {
        expect(unwrapInteractionFailure(failure.value)).toMatchObject({
          message:
            "Teams were added, but Tiara could not deliver the confirmation message. Please check the sheet.",
        });
      }
      expect(sheetApiCalls).toEqual(["upsertFromDiscord"]);
      expect(deliveryCalls).toMatchObject([
        { method: "sendMessage", conversationId: "conversation-1" },
      ]);
    }),
  );

  it.effect("does not recurse indefinitely through cyclic delivery error causes", () =>
    Effect.gen(function* () {
      const firstError: { cause?: unknown } = {};
      const secondError: { cause?: unknown } = { cause: firstError };
      firstError.cause = secondError;
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceFeatureFlags: () => Effect.succeed([]),
        },
        teamSubmission: {
          upsertFromDiscord: () => Effect.succeed(makeConfirmedTeamSubmissionResult()),
        },
      });

      const exit = yield* Effect.exit(
        runWithDispatchService(
          makeTeamSubmissionDeliveryClient([], { updateMessageError: firstError }),
          sheetApisClient,
          (service) => service.teamSubmission(teamSubmissionPayload),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.every(Cause.isFailReason)).toBe(true);
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && isInteractionFailureHandled(failure.value)).toBe(true);
        if (Option.isSome(failure)) {
          expect(unwrapInteractionFailure(failure.value)).toMatchObject({
            message:
              "Teams were added, but Tiara could not deliver the confirmation message. Please check the sheet.",
          });
        }
      }
    }),
  );

  it.effect(
    "adds a reaction and edits the reply embed when team submission confirmations succeed",
    () =>
      Effect.gen(function* () {
        const deliveryCalls: Array<unknown> = [];
        const sheetApisClient = makeSheetApisClient({
          workspaceConfig: {
            getWorkspaceFeatureFlags: () =>
              Effect.succeed([
                makeWorkspaceFeatureFlag({ flagName: "team-submission-confirmations" }),
              ]),
          },
          teamSubmission: {
            upsertFromDiscord: () => Effect.succeed(makeTeamSubmissionUpsertResult()),
            setConfirmationMessage: () => Effect.succeed(makeConfirmedTeamSubmissionResult()),
          },
        });

        const result = yield* runWithDispatchService(
          makeTeamSubmissionDeliveryClient(deliveryCalls),
          sheetApisClient,
          (service) => service.teamSubmission(teamSubmissionPayload),
        );

        expect(result.status).toBe("registered");
        expect(deliveryCalls).toMatchObject([
          {
            method: "sendMessage",
            conversationId: "conversation-1",
            payload: {
              embeds: [{ title: "Adding teams to the sheet", color: 0xfee75c }],
              messageReference: {
                failIfNotExists: false,
              },
              nonce: makeDeliveryNonce("team-submission-progress:source-message-1"),
              enforceNonce: true,
            },
          },
          {
            method: "addMessageReaction",
            conversationId: "conversation-1",
            messageId: "source-message-1",
            emoji: { id: "907705464215711834", name: "Miku_Happy" },
          },
          {
            method: "updateMessage",
            conversationId: "conversation-1",
            messageId: "confirmation-message-1",
            payload: {
              embeds: [
                {
                  title: "Teams added to the sheet",
                  description: "• Alice - Cool Team (fullFill)",
                  color: 0x57f287,
                },
              ],
              allowedMentions: "none",
            },
          },
        ]);
      }),
  );

  it.effect("continues writing teams when adding the source reaction fails", () =>
    Effect.gen(function* () {
      const deliveryCalls: Array<unknown> = [];
      const sheetApiCalls: Array<readonly [string, unknown]> = [];
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceFeatureFlags: () =>
            Effect.succeed([
              makeWorkspaceFeatureFlag({ flagName: "team-submission-confirmations" }),
            ]),
        },
        teamSubmission: {
          upsertFromDiscord: (args: unknown) => {
            sheetApiCalls.push(["upsertFromDiscord", args]);
            return Effect.succeed(makeTeamSubmissionUpsertResult());
          },
          setConfirmationMessage: (args: unknown) => {
            sheetApiCalls.push(["setConfirmationMessage", args]);
            return Effect.succeed(makeConfirmedTeamSubmissionResult());
          },
        },
      });

      const result = yield* runWithDispatchService(
        makeTeamSubmissionDeliveryClient(deliveryCalls, { failAddMessageReaction: true }),
        sheetApisClient,
        (service) => service.teamSubmission(teamSubmissionPayload),
      );

      expect(result.status).toBe("registered");
      expect(sheetApiCalls.map(([method]) => method)).toEqual([
        "upsertFromDiscord",
        "setConfirmationMessage",
      ]);
      expect(deliveryCalls).toMatchObject([
        { method: "sendMessage" },
        { method: "addMessageReaction", messageId: "source-message-1" },
        { method: "updateMessage", messageId: "confirmation-message-1" },
      ]);
    }),
  );

  it.effect("fails visibly when the final confirmation reply update fails", () =>
    Effect.gen(function* () {
      const deliveryCalls: Array<unknown> = [];
      const sheetApiCalls: Array<readonly [string, unknown]> = [];
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getWorkspaceFeatureFlags: () =>
            Effect.succeed([
              makeWorkspaceFeatureFlag({ flagName: "team-submission-confirmations" }),
            ]),
        },
        teamSubmission: {
          upsertFromDiscord: (args: unknown) => {
            sheetApiCalls.push(["upsertFromDiscord", args]);
            return Effect.succeed(makeTeamSubmissionUpsertResult());
          },
          setConfirmationMessage: (args: unknown) => {
            sheetApiCalls.push(["setConfirmationMessage", args]);
            return Effect.succeed(makeConfirmedTeamSubmissionResult());
          },
        },
      });

      const exit = yield* Effect.exit(
        runWithDispatchService(
          makeTeamSubmissionDeliveryClient(deliveryCalls, { failUpdateMessage: true }),
          sheetApisClient,
          (service) => service.teamSubmission(teamSubmissionPayload),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(sheetApiCalls.map(([method]) => method)).toEqual(["upsertFromDiscord"]);
      expect(deliveryCalls).toMatchObject([
        { method: "sendMessage" },
        { method: "addMessageReaction", messageId: "source-message-1" },
        {
          method: "updateMessage",
          messageId: "confirmation-message-1",
          payload: { embeds: [{ title: "Teams added to the sheet" }] },
        },
        { method: "removeMessageReaction", messageId: "source-message-1" },
        {
          method: "updateMessage",
          messageId: "confirmation-message-1",
          payload: { embeds: [{ title: "Teams added, but confirmation failed" }] },
        },
      ]);
    }),
  );

  it.effect(
    "removes the reaction and edits the reply embed when team submission writing fails",
    () =>
      Effect.gen(function* () {
        const deliveryCalls: Array<unknown> = [];
        const sheetApisClient = makeSheetApisClient({
          workspaceConfig: {
            getWorkspaceFeatureFlags: () =>
              Effect.succeed([
                makeWorkspaceFeatureFlag({ flagName: "team-submission-confirmations" }),
              ]),
          },
          teamSubmission: {
            upsertFromDiscord: () =>
              Effect.fail(
                new SheetWorkflowsServicesDispatchTestError({
                  message: "upsert failed",
                }),
              ),
          },
        });

        const exit = yield* Effect.exit(
          runWithDispatchService(
            makeTeamSubmissionDeliveryClient(deliveryCalls),
            sheetApisClient,
            (service) => service.teamSubmission(teamSubmissionPayload),
          ),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        expect(deliveryCalls).toMatchObject([
          { method: "sendMessage" },
          { method: "addMessageReaction" },
          { method: "removeMessageReaction", messageId: "source-message-1" },
          {
            method: "updateMessage",
            payload: {
              embeds: [{ title: "Could not add teams", color: 0xed4245 }],
              components: [],
              allowedMentions: "none",
            },
          },
        ]);
      }),
  );

  it.effect("confirms a team submission by marking it confirmed and deleting the reply", () =>
    Effect.gen(function* () {
      const deliveryCalls: Array<unknown> = [];
      const sheetApiCalls: Array<unknown> = [];
      const sheetApisClient = makeSheetApisClient({
        teamSubmission: {
          confirmFromDiscord: (args: unknown) => {
            sheetApiCalls.push(args);
            return Effect.succeed({ status: "confirmed" });
          },
        },
      });

      const result = yield* runWithDispatchService(
        makeTeamSubmissionDeliveryClient(deliveryCalls),
        sheetApisClient,
        (service) => service.teamSubmissionConfirmButton(teamSubmissionButtonPayload, requester),
      );

      expect(result).toEqual({ status: "confirmed" });
      expect(sheetApiCalls).toEqual([
        {
          payload: {
            client: discordClient,
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            messageId: "source-message-1",
            confirmationMessageId: "confirmation-message-1",
            requesterUserId: "discord-user-1",
          },
        },
      ]);
      expect(deliveryCalls).toEqual([
        {
          method: "updateOriginalInteractionResponse",
          interactionResponseToken: "interaction-token",
          payload: {
            content: "Team submission confirmed.",
            allowedMentions: "none",
          },
        },
        {
          method: "deleteMessage",
          conversationId: "conversation-1",
          messageId: "confirmation-message-1",
        },
        {
          method: "removeMessageReaction",
          conversationId: "conversation-1",
          messageId: "source-message-1",
          emoji: { id: "907705464215711834", name: "Miku_Happy" },
        },
      ]);
    }),
  );

  it.effect("resolves the confirm interaction when confirmation fails", () =>
    Effect.gen(function* () {
      const deliveryCalls: Array<unknown> = [];
      const sheetApisClient = makeSheetApisClient({
        teamSubmission: {
          confirmFromDiscord: () =>
            Effect.fail(
              new SheetWorkflowsServicesDispatchTestError({
                message: "confirm failed",
              }),
            ),
        },
      });

      const exit = yield* Effect.exit(
        runWithDispatchService(
          makeTeamSubmissionDeliveryClient(deliveryCalls),
          sheetApisClient,
          (service) => service.teamSubmissionConfirmButton(teamSubmissionButtonPayload, requester),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(deliveryCalls).toEqual([
        {
          method: "updateOriginalInteractionResponse",
          interactionResponseToken: "interaction-token",
          payload: {
            content: "Could not confirm this team submission. Please try again.",
            allowedMentions: "none",
          },
        },
      ]);
    }),
  );

  it.effect("still deletes the reply when confirmed interaction response update fails", () =>
    Effect.gen(function* () {
      const deliveryCalls: Array<unknown> = [];
      const sheetApisClient = makeSheetApisClient({
        teamSubmission: {
          confirmFromDiscord: () => Effect.succeed({ status: "confirmed" }),
        },
      });

      const result = yield* runWithDispatchService(
        makeTeamSubmissionDeliveryClient(deliveryCalls, { failInteractionUpdate: true }),
        sheetApisClient,
        (service) => service.teamSubmissionConfirmButton(teamSubmissionButtonPayload, requester),
      );

      expect(result).toEqual({ status: "confirmed" });
      expect(deliveryCalls).toMatchObject([
        {
          method: "updateOriginalInteractionResponse",
          payload: {
            content: "Team submission confirmed.",
            allowedMentions: "none",
          },
        },
        {
          method: "deleteMessage",
          conversationId: "conversation-1",
          messageId: "confirmation-message-1",
        },
        {
          method: "removeMessageReaction",
          conversationId: "conversation-1",
          messageId: "source-message-1",
        },
      ]);
    }),
  );

  it.effect(
    "rejects a team submission by rolling back, removing the reaction, and deleting the reply",
    () =>
      Effect.gen(function* () {
        const deliveryCalls: Array<unknown> = [];
        const sheetApisClient = makeSheetApisClient({
          teamSubmission: {
            revertFromDiscord: () =>
              Effect.succeed({
                status: "rejected",
                rowMappings: [],
                rollbackSnapshot: [],
                confirmationText: "Rolled back.",
              }),
          },
        });

        const result = yield* runWithDispatchService(
          makeTeamSubmissionDeliveryClient(deliveryCalls),
          sheetApisClient,
          (service) => service.teamSubmissionRejectButton(teamSubmissionButtonPayload, requester),
        );

        expect(result).toEqual({ status: "rejected" });
        expect(deliveryCalls).toEqual([
          {
            method: "updateOriginalInteractionResponse",
            interactionResponseToken: "interaction-token",
            payload: {
              content: "Team submission rejected and rolled back.",
              allowedMentions: "none",
            },
          },
          {
            method: "removeMessageReaction",
            conversationId: "conversation-1",
            messageId: "source-message-1",
            emoji: { id: "907705464215711834", name: "Miku_Happy" },
          },
          {
            method: "deleteMessage",
            conversationId: "conversation-1",
            messageId: "confirmation-message-1",
          },
        ]);
      }),
  );

  it.effect("still deletes the reply when rejected interaction response update fails", () =>
    Effect.gen(function* () {
      const deliveryCalls: Array<unknown> = [];
      const sheetApisClient = makeSheetApisClient({
        teamSubmission: {
          revertFromDiscord: () =>
            Effect.succeed({
              status: "rejected",
              rowMappings: [],
              rollbackSnapshot: [],
              confirmationText: "Rolled back.",
            }),
        },
      });

      const result = yield* runWithDispatchService(
        makeTeamSubmissionDeliveryClient(deliveryCalls, { failInteractionUpdate: true }),
        sheetApisClient,
        (service) => service.teamSubmissionRejectButton(teamSubmissionButtonPayload, requester),
      );

      expect(result).toEqual({ status: "rejected" });
      expect(deliveryCalls).toMatchObject([
        {
          method: "updateOriginalInteractionResponse",
          payload: {
            content: "Team submission rejected and rolled back.",
            allowedMentions: "none",
          },
        },
        { method: "removeMessageReaction", messageId: "source-message-1" },
        {
          method: "deleteMessage",
          conversationId: "conversation-1",
          messageId: "confirmation-message-1",
        },
      ]);
    }),
  );

  it.effect("keeps and edits the reply when team submission rollback fails", () =>
    Effect.gen(function* () {
      const deliveryCalls: Array<unknown> = [];
      const sheetApisClient = makeSheetApisClient({
        teamSubmission: {
          revertFromDiscord: () =>
            Effect.succeed({
              status: "rollbackFailed",
              rowMappings: [],
              rollbackSnapshot: [],
              confirmationText: "Rollback failed.",
            }),
        },
      });

      const result = yield* runWithDispatchService(
        makeTeamSubmissionDeliveryClient(deliveryCalls),
        sheetApisClient,
        (service) => service.teamSubmissionRejectButton(teamSubmissionButtonPayload, requester),
      );

      expect(result).toEqual({ status: "rollbackFailed" });
      expect(deliveryCalls).toMatchObject([
        {
          method: "updateMessage",
          conversationId: "conversation-1",
          messageId: "confirmation-message-1",
          payload: {
            embeds: [
              {
                title: "Rollback failed",
                description: "Rollback failed.",
                color: 0xed4245,
              },
            ],
            allowedMentions: "none",
          },
        },
        {
          method: "updateOriginalInteractionResponse",
          interactionResponseToken: "interaction-token",
          payload: {
            content: "Rollback failed. Please check the updated reply.",
            allowedMentions: "none",
          },
        },
        { method: "removeMessageReaction", messageId: "source-message-1" },
      ]);
    }),
  );

  it.effect("finishes rollback-failed interactions when publishing the reply fails", () =>
    Effect.gen(function* () {
      const deliveryCalls: Array<unknown> = [];
      const sheetApisClient = makeSheetApisClient({
        teamSubmission: {
          revertFromDiscord: () =>
            Effect.succeed({
              status: "rollbackFailed",
              rowMappings: [],
              rollbackSnapshot: [],
              confirmationText: "Rollback failed.",
            }),
        },
      });

      const result = yield* runWithDispatchService(
        makeTeamSubmissionDeliveryClient(deliveryCalls, { failUpdateMessage: true }),
        sheetApisClient,
        (service) => service.teamSubmissionRejectButton(teamSubmissionButtonPayload, requester),
      );

      expect(result).toEqual({ status: "rollbackFailed" });
      expect(deliveryCalls).toMatchObject([
        {
          method: "updateMessage",
          conversationId: "conversation-1",
          messageId: "confirmation-message-1",
        },
        {
          method: "updateOriginalInteractionResponse",
          interactionResponseToken: "interaction-token",
        },
        { method: "removeMessageReaction", messageId: "source-message-1" },
      ]);
    }),
  );

  it.effect("preserves the reply and reaction when the rollback API fails before rollback", () =>
    Effect.gen(function* () {
      const deliveryCalls: Array<unknown> = [];
      const sheetApisClient = makeSheetApisClient({
        teamSubmission: {
          revertFromDiscord: () =>
            Effect.fail(
              new SheetWorkflowsServicesDispatchTestError({
                message: "rollback update failed",
              }),
            ),
        },
      });

      const exit = yield* Effect.exit(
        runWithDispatchService(
          makeTeamSubmissionDeliveryClient(deliveryCalls),
          sheetApisClient,
          (service) => service.teamSubmissionRejectButton(teamSubmissionButtonPayload, requester),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(deliveryCalls).toEqual([
        {
          method: "updateOriginalInteractionResponse",
          interactionResponseToken: "interaction-token",
          payload: {
            content: "Could not reject this team submission. Please try again.",
            allowedMentions: "none",
          },
        },
      ]);
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
