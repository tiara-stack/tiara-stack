// fallow-ignore-file code-duplication
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Cause, Context, Duration, Effect, Exit, Layer, Option, Schema, Stream } from "effect";
import { ClusterSchema, Sharding } from "effect/unstable/cluster";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { WorkflowEngine } from "effect/unstable/workflow";
import { MessageCheckinMember } from "sheet-ingress-api/schemas/messageCheckin";
import { MessageSlot } from "sheet-ingress-api/schemas/messageSlot";
import {
  DispatchWorkflows as SheetIngressDispatchWorkflows,
  type DispatchRequester,
} from "sheet-ingress-api/sheet-workflows-workflows";
import type {
  AutoCheckinTestDispatchPayload,
  AutoCheckinTestDispatchResult,
  CheckinDispatchPayload,
  CheckinDispatchResult,
  CheckinHandleButtonPayload,
  CheckinHandleButtonResult,
  WorkspaceWelcomeDispatchPayload,
  WorkspaceWelcomeDispatchResult,
  KickoutDispatchPayload,
  KickoutDispatchResult,
  RoomOrderPinTentativeButtonPayload,
  ServiceWorkspaceFeatureFlagDispatchPayload,
  ServiceWorkspaceFeatureFlagDispatchResult,
  ServiceStatusDispatchPayload,
  ServiceStatusDispatchResult,
  SlotButtonDispatchPayload,
  SlotButtonDispatchResult,
  SlotListDispatchPayload,
  SlotListDispatchResult,
  SlotOpenButtonPayload,
  SlotOpenButtonResult,
  UpdateAnnouncementDispatchPayload,
  UpdateAnnouncementDispatchResult,
} from "sheet-ingress-api/sheet-apis-rpc";
import { Unauthorized } from "typhoon-core/error";
import { markInteractionFailureHandled } from "@/handlers/shared/interactionFailure";
import { DispatchService, ClientDeliveryClient, SheetApisClient } from "@/services";
import {
  dispatchFailureMessage,
  dispatchFailureResponse,
  dispatchWorkflowNames,
  dispatchWorkflowRegistry,
  isClusterPersistenceCause,
  makeButtonWorkflowHandler,
  makeWorkflowHandler,
  retryClusterPersistenceCause,
} from "./dispatchRegistry";
import {
  DispatchCheckinButtonWorkflow,
  DispatchServiceStatusWorkflow,
  DispatchWorkflows,
} from "./dispatchWorkflows";

const requester: DispatchRequester = {
  accountId: "account-1",
  userId: "user-1",
};

const discordClient = { platform: "discord", clientId: "discord-main" } as const;

const checkinPayload: CheckinDispatchPayload = {
  client: discordClient,
  dispatchRequestId: "dispatch-1",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
};

const autoCheckinTestPayload: AutoCheckinTestDispatchPayload = {
  client: discordClient,
  dispatchRequestId: "dispatch-auto-checkin-test",
  workspaceId: "workspace-1",
  anchorConversationId: "anchor-conversation-1",
  interactionResponseToken: "interaction-token",
  interactionResponseDeadlineEpochMs: 4_102_444_800_000,
};

const kickoutPayload: KickoutDispatchPayload = {
  client: discordClient,
  dispatchRequestId: "dispatch-kickout",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
};

const slotButtonPayload: SlotButtonDispatchPayload = {
  client: discordClient,
  dispatchRequestId: "dispatch-slot-button",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  day: 1,
  interactionResponseToken: "interaction-token",
  interactionResponseDeadlineEpochMs: 4_102_444_800_000,
};

const slotListPayload: SlotListDispatchPayload = {
  client: discordClient,
  dispatchRequestId: "dispatch-slot-list",
  workspaceId: "workspace-1",
  day: 1,
  messageType: "ephemeral",
  interactionResponseToken: "interaction-token",
  interactionResponseDeadlineEpochMs: 4_102_444_800_000,
};

const slotOpenButtonPayload: SlotOpenButtonPayload = {
  client: discordClient,
  messageId: "slot-message-1",
  interactionResponseToken: "interaction-token",
  interactionResponseDeadlineEpochMs: 4_102_444_800_000,
};

const serviceStatusPayload: ServiceStatusDispatchPayload = {
  client: discordClient,
  dispatchRequestId: "dispatch-service-status",
  interactionResponseToken: "interaction-token",
  interactionResponseDeadlineEpochMs: 4_102_444_800_000,
};

const workspaceWelcomePayload: WorkspaceWelcomeDispatchPayload = {
  client: discordClient,
  dispatchRequestId: "discord-workspace-create:workspace-1:2026-05-31T00:00:00.000Z",
  workspaceId: "workspace-1",
  workspaceName: "Workspace One",
  joinedAt: "2026-05-31T00:00:00.000Z",
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

const serviceWorkspaceFeatureFlagPayload: ServiceWorkspaceFeatureFlagDispatchPayload = {
  client: discordClient,
  dispatchRequestId: "dispatch-service-workspace-feature-flag",
  workspaceId: "workspace-1",
  flagName: "beta-feature",
  systemConversationId: "system-conversation",
};

const interactionResponseDeadlineEpochMs = 4_102_444_800_000;

const checkinButtonPayload: CheckinHandleButtonPayload = {
  client: discordClient,
  messageId: "message-1",
  interactionResponseToken: "interaction-token",
  interactionResponseDeadlineEpochMs,
};

const pinTentativePayload: RoomOrderPinTentativeButtonPayload = {
  client: discordClient,
  workspaceId: "workspace-1",
  messageId: "message-1",
  messageConversationId: "conversation-1",
  interactionResponseToken: "interaction-token",
  interactionResponseDeadlineEpochMs,
};

type DispatchServiceMock = typeof DispatchService.Service;
type ShardingMock = typeof Sharding.Sharding.Service;
type SheetApisClientMock = typeof SheetApisClient.Service;
type SheetApisApiClient = ReturnType<SheetApisClientMock["get"]>;
type MessageCheckinClient = SheetApisApiClient["messageCheckin"];
type MessageSlotClient = SheetApisApiClient["messageSlot"];
type GetMessageCheckinMembersRequest = Parameters<
  MessageCheckinClient["getMessageCheckinMembers"]
>[0];
type GetMessageSlotDataRequest = Parameters<MessageSlotClient["getMessageSlotData"]>[0];
type GetMessageCheckinMembersMock = (
  request: GetMessageCheckinMembersRequest,
) => Effect.Effect<ReadonlyArray<MessageCheckinMember>>;
type GetMessageSlotDataMock = (
  request: GetMessageSlotDataRequest,
) => Effect.Effect<MessageSlot, unknown>;
type DecodedResponse<
  A,
  Mode extends HttpApiClient.Client.ResponseMode,
> = HttpApiClient.Client.Response<A, Mode>;

const unexpectedDispatchServiceCall = <Method extends keyof DispatchServiceMock>(
  method: Method,
): DispatchServiceMock[Method] =>
  (() =>
    Effect.die(`Unexpected DispatchService.${String(method)} call`)) as DispatchServiceMock[Method];

const makeDispatchServiceMock = (overrides: Partial<DispatchServiceMock>): DispatchServiceMock => ({
  autoCheckinTest: unexpectedDispatchServiceCall("autoCheckinTest"),
  checkin: unexpectedDispatchServiceCall("checkin"),
  roomOrder: unexpectedDispatchServiceCall("roomOrder"),
  kickout: unexpectedDispatchServiceCall("kickout"),
  slotButton: unexpectedDispatchServiceCall("slotButton"),
  slotList: unexpectedDispatchServiceCall("slotList"),
  slotOpenButton: unexpectedDispatchServiceCall("slotOpenButton"),
  serviceStatus: unexpectedDispatchServiceCall("serviceStatus"),
  workspaceWelcome: unexpectedDispatchServiceCall("workspaceWelcome"),
  updateAnnouncement: unexpectedDispatchServiceCall("updateAnnouncement"),
  serviceAddWorkspaceFeatureFlag: unexpectedDispatchServiceCall("serviceAddWorkspaceFeatureFlag"),
  serviceRemoveWorkspaceFeatureFlag: unexpectedDispatchServiceCall(
    "serviceRemoveWorkspaceFeatureFlag",
  ),
  checkinButton: unexpectedDispatchServiceCall("checkinButton"),
  roomOrderPreviousButton: unexpectedDispatchServiceCall("roomOrderPreviousButton"),
  roomOrderNextButton: unexpectedDispatchServiceCall("roomOrderNextButton"),
  roomOrderSendButton: unexpectedDispatchServiceCall("roomOrderSendButton"),
  roomOrderPinTentativeButton: unexpectedDispatchServiceCall("roomOrderPinTentativeButton"),
  conversationListConfig: unexpectedDispatchServiceCall("conversationListConfig"),
  conversationSet: unexpectedDispatchServiceCall("conversationSet"),
  conversationUnset: unexpectedDispatchServiceCall("conversationUnset"),
  workspaceListConfig: unexpectedDispatchServiceCall("workspaceListConfig"),
  workspaceAddMonitorRole: unexpectedDispatchServiceCall("workspaceAddMonitorRole"),
  workspaceRemoveMonitorRole: unexpectedDispatchServiceCall("workspaceRemoveMonitorRole"),
  workspaceSetSheet: unexpectedDispatchServiceCall("workspaceSetSheet"),
  workspaceSetAutoCheckin: unexpectedDispatchServiceCall("workspaceSetAutoCheckin"),
  teamList: unexpectedDispatchServiceCall("teamList"),
  scheduleList: unexpectedDispatchServiceCall("scheduleList"),
  screenshot: unexpectedDispatchServiceCall("screenshot"),
  ...overrides,
});

const makeShardingMock = (overrides: Partial<ShardingMock>): ShardingMock =>
  Sharding.Sharding.of({
    getRegistrationEvents: Stream.empty,
    getShardId: () => {
      throw new Error("Unexpected Sharding.getShardId call");
    },
    hasShardId: () => false,
    getSnowflake: Effect.die("Unexpected Sharding.getSnowflake call"),
    isShutdown: Effect.succeed(false),
    makeClient: () => Effect.die("Unexpected Sharding.makeClient call"),
    registerEntity: () => Effect.die("Unexpected Sharding.registerEntity call"),
    registerSingleton: () => Effect.die("Unexpected Sharding.registerSingleton call"),
    send: () => Effect.die("Unexpected Sharding.send call"),
    sendOutgoing: () => Effect.die("Unexpected Sharding.sendOutgoing call"),
    notify: () => Effect.die("Unexpected Sharding.notify call"),
    reset: () => Effect.die("Unexpected Sharding.reset call"),
    pollStorage: Effect.die("Unexpected Sharding.pollStorage call"),
    activeEntityCount: Effect.die("Unexpected Sharding.activeEntityCount call"),
    ...overrides,
  });

const makeMessageCheckinMember = (memberId: string) =>
  new MessageCheckinMember({
    clientPlatform: "discord",
    clientId: "discord-main",
    messageId: checkinButtonPayload.messageId,
    memberId,
    checkinAt: Option.none(),
    checkinClaimId: Option.none(),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
  });

const makeMessageSlot = (overrides?: {
  readonly workspaceId?: Option.Option<string>;
  readonly conversationId?: Option.Option<string>;
}) =>
  new MessageSlot({
    clientPlatform: "discord",
    clientId: "discord-main",
    messageId: slotOpenButtonPayload.messageId,
    day: 2,
    workspaceId: overrides?.workspaceId ?? Option.some("workspace-1"),
    conversationId: overrides?.conversationId ?? Option.some("conversation-1"),
    createdByUserId: Option.some(requester.userId),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
  });

const makeSheetApisClientMock = (overrides: {
  readonly getMessageCheckinMembers?: GetMessageCheckinMembersMock;
  readonly getMessageSlotData?: GetMessageSlotDataMock;
}): SheetApisClientMock => {
  const getMessageCheckinMembers: MessageCheckinClient["getMessageCheckinMembers"] = (request) => {
    if (request.responseMode && request.responseMode !== "decoded-only") {
      return Effect.die(`Unexpected responseMode ${request.responseMode}`);
    }

    return (
      overrides.getMessageCheckinMembers?.(request) ??
      Effect.die("Unexpected SheetApisClient.messageCheckin.getMessageCheckinMembers access")
    ).pipe(
      Effect.map(
        (members) =>
          members as DecodedResponse<
            ReadonlyArray<MessageCheckinMember>,
            NonNullable<typeof request.responseMode> | "decoded-only"
          >,
      ),
    );
  };
  const getMessageSlotData = (request: GetMessageSlotDataRequest) => {
    if (request.responseMode && request.responseMode !== "decoded-only") {
      return Effect.die(`Unexpected responseMode ${request.responseMode}`);
    }

    return (
      overrides.getMessageSlotData?.(request) ??
      Effect.die("Unexpected SheetApisClient.messageSlot.getMessageSlotData access")
    ).pipe(
      Effect.map(
        (messageSlot) =>
          messageSlot as DecodedResponse<MessageSlot, NonNullable<typeof request.responseMode>>,
      ),
    );
  };
  const messageCheckin: Pick<MessageCheckinClient, "getMessageCheckinMembers"> = {
    getMessageCheckinMembers,
  };
  const messageSlot: Pick<MessageSlotClient, "getMessageSlotData"> = {
    getMessageSlotData: getMessageSlotData as unknown as MessageSlotClient["getMessageSlotData"],
  };
  const client = new Proxy(
    { messageCheckin, messageSlot },
    {
      get(target, property) {
        if (property in target) {
          return target[property as keyof typeof target];
        }
        throw new Error(`Unexpected SheetApisClient.${String(property)} access`);
      },
    },
  ) as SheetApisApiClient;

  return {
    get: () => client,
  };
};

describe("dispatch workflow registry", () => {
  it("has metadata for every dispatch workflow", () => {
    expect(dispatchWorkflowNames).toEqual(
      SheetIngressDispatchWorkflows.map((workflow) => workflow.name),
    );
    expect(Object.keys(dispatchWorkflowRegistry)).toEqual([
      "autoCheckinTest",
      "checkin",
      "roomOrder",
      "kickout",
      "slotButton",
      "slotList",
      "slotOpenButton",
      "serviceStatus",
      "workspaceWelcome",
      "updateAnnouncement",
      "serviceAddWorkspaceFeatureFlag",
      "serviceRemoveWorkspaceFeatureFlag",
      "checkinButton",
      "roomOrderPreviousButton",
      "roomOrderNextButton",
      "roomOrderSendButton",
      "roomOrderPinTentativeButton",
      "conversationListConfig",
      "conversationSet",
      "conversationUnset",
      "workspaceListConfig",
      "workspaceAddMonitorRole",
      "workspaceRemoveMonitorRole",
      "workspaceSetSheet",
      "workspaceSetAutoCheckin",
      "teamList",
      "scheduleList",
      "screenshot",
    ]);
  });

  it("assigns dispatch workflows to the configured dispatch shard group", () => {
    for (const workflow of DispatchWorkflows) {
      const shardGroup = Context.get(workflow.annotations, ClusterSchema.ShardGroup);
      expect(shardGroup(undefined as never)).toBe("dispatch");
    }
  });

  it.effect("detects cluster persistence defects", () =>
    Effect.sync(() => {
      expect(
        isClusterPersistenceCause(
          Cause.die({
            _tag: "PersistenceError",
            name: "~effect/cluster/ClusterError/PersistenceError",
          }),
        ),
      ).toBe(true);
      expect(isClusterPersistenceCause(Cause.die(new Error("other defect")))).toBe(false);
    }),
  );

  it.effect("retries cluster persistence defects without retrying typed failures", () =>
    Effect.gen(function* () {
      let persistenceAttempts = 0;
      const recovered = yield* retryClusterPersistenceCause(
        Effect.suspend(() => {
          persistenceAttempts += 1;
          return persistenceAttempts < 3
            ? Effect.die({ _tag: "PersistenceError" })
            : Effect.succeed("ok");
        }),
        3,
        Duration.zero,
      );

      let typedAttempts = 0;
      const typedFailure = yield* Effect.exit(
        retryClusterPersistenceCause(
          Effect.suspend(() => {
            typedAttempts += 1;
            return Effect.fail("typed failure");
          }),
          3,
          Duration.zero,
        ),
      );

      expect(recovered).toBe("ok");
      expect(persistenceAttempts).toBe(3);
      expect(Exit.isFailure(typedFailure)).toBe(true);
      expect(typedAttempts).toBe(1);
    }),
  );

  it.live("routes check-in workflow execution to DispatchService", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const result = yield* dispatchWorkflowRegistry.checkin.execute({
          requester,
          payload: checkinPayload,
        });

        expect(result).toEqual({
          hour: 1,
          runningConversationId: "running-conversation",
          checkinConversationId: "checkin-conversation",
          checkinMessageId: "checkin-message",
          checkinMessageConversationId: "checkin-conversation",
          primaryMessageId: "primary-message",
          primaryMessageConversationId: "primary-conversation",
          tentativeRoomOrderMessageId: null,
          tentativeRoomOrderMessageConversationId: null,
        });
      }).pipe(
        Effect.provideService(
          DispatchService,
          makeDispatchServiceMock({
            checkin: (payload: CheckinDispatchPayload, currentRequester: DispatchRequester) =>
              Effect.sync((): CheckinDispatchResult => {
                expect(payload).toBe(checkinPayload);
                expect(currentRequester).toBe(requester);
                return {
                  hour: 1,
                  runningConversationId: "running-conversation",
                  checkinConversationId: "checkin-conversation",
                  checkinMessageId: "checkin-message",
                  checkinMessageConversationId: "checkin-conversation",
                  primaryMessageId: "primary-message",
                  primaryMessageConversationId: "primary-conversation",
                  tentativeRoomOrderMessageId: null,
                  tentativeRoomOrderMessageConversationId: null,
                };
              }),
          }),
        ),
        Effect.provide(Layer.empty),
      );
    }),
  );

  it.live("routes auto check-in test workflow execution to DispatchService", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const result = yield* dispatchWorkflowRegistry.autoCheckinTest.execute({
          requester,
          payload: autoCheckinTestPayload,
        });

        expect(result).toEqual({
          workspaceId: "workspace-1",
          hour: 1,
          anchorMessageId: "anchor-message",
          anchorMessageConversationId: "anchor-conversation-1",
          conversationCount: 1,
          sentCount: 1,
          skippedCount: 0,
          failedCount: 0,
          conversations: [
            {
              conversationName: "main",
              runningConversationId: "running-conversation",
              checkinConversationId: "checkin-conversation",
              hour: 1,
              status: "sent",
              checkinPreviewMessageId: "checkin-preview",
              monitorPreviewMessageId: "monitor-preview",
              tentativeRoomOrderPreviewMessageId: null,
              error: null,
            },
          ],
        });
      }).pipe(
        Effect.provideService(
          DispatchService,
          makeDispatchServiceMock({
            autoCheckinTest: (
              payload: AutoCheckinTestDispatchPayload,
              currentRequester: DispatchRequester,
            ) =>
              Effect.sync((): AutoCheckinTestDispatchResult => {
                expect(payload).toBe(autoCheckinTestPayload);
                expect(currentRequester).toBe(requester);
                return {
                  workspaceId: "workspace-1",
                  hour: 1,
                  anchorMessageId: "anchor-message",
                  anchorMessageConversationId: "anchor-conversation-1",
                  conversationCount: 1,
                  sentCount: 1,
                  skippedCount: 0,
                  failedCount: 0,
                  conversations: [
                    {
                      conversationName: "main",
                      runningConversationId: "running-conversation",
                      checkinConversationId: "checkin-conversation",
                      hour: 1,
                      status: "sent",
                      checkinPreviewMessageId: "checkin-preview",
                      monitorPreviewMessageId: "monitor-preview",
                      tentativeRoomOrderPreviewMessageId: null,
                      error: null,
                    },
                  ],
                };
              }),
          }),
        ),
        Effect.provide(Layer.empty),
      );
    }),
  );

  it.live("routes kickout workflow execution to DispatchService", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const result = yield* dispatchWorkflowRegistry.kickout.execute({
          requester,
          payload: kickoutPayload,
        });

        expect(result).toEqual({
          workspaceId: "workspace-1",
          runningConversationId: "conversation-1",
          hour: 1,
          roleId: "role-1",
          removedMemberIds: ["account-2"],
          status: "removed",
        });
      }).pipe(
        Effect.provideService(
          DispatchService,
          makeDispatchServiceMock({
            kickout: (payload, currentRequester) =>
              Effect.sync(() => {
                expect(payload).toBe(kickoutPayload);
                expect(currentRequester).toBe(requester);
                return {
                  workspaceId: "workspace-1",
                  runningConversationId: "conversation-1",
                  hour: 1,
                  roleId: "role-1",
                  removedMemberIds: ["account-2"],
                  status: "removed",
                } satisfies KickoutDispatchResult;
              }),
          }),
        ),
      );
    }),
  );

  it.live("requires manage-workspace authorization snapshots for config mutation workflows", () =>
    Effect.gen(function* () {
      type TestAuthorization = {
        readonly workspaceId: string;
        readonly scope: "member" | "monitor" | "manage";
      };
      const authorization: TestAuthorization = { workspaceId: "workspace-1", scope: "manage" };
      const unauthorized: TestAuthorization = { workspaceId: "workspace-1", scope: "monitor" };
      const cases = [
        (currentAuthorization: typeof authorization) =>
          dispatchWorkflowRegistry.conversationSet.authorize({
            requester,
            authorization: currentAuthorization,
            payload: {
              client: discordClient,
              dispatchRequestId: "dispatch-conversation-set",
              workspaceId: "workspace-1",
              conversationId: "conversation-1",
              running: true,
              interactionResponseToken: "interaction-token",
              interactionResponseDeadlineEpochMs,
            },
          }),
        (currentAuthorization: typeof authorization) =>
          dispatchWorkflowRegistry.conversationUnset.authorize({
            requester,
            authorization: currentAuthorization,
            payload: {
              client: discordClient,
              dispatchRequestId: "dispatch-conversation-unset",
              workspaceId: "workspace-1",
              conversationId: "conversation-1",
              running: true,
              interactionResponseToken: "interaction-token",
              interactionResponseDeadlineEpochMs,
            },
          }),
        (currentAuthorization: typeof authorization) =>
          dispatchWorkflowRegistry.workspaceAddMonitorRole.authorize({
            requester,
            authorization: currentAuthorization,
            payload: {
              client: discordClient,
              dispatchRequestId: "dispatch-server-add-monitor-role",
              workspaceId: "workspace-1",
              roleId: "role-1",
              interactionResponseToken: "interaction-token",
              interactionResponseDeadlineEpochMs,
            },
          }),
        (currentAuthorization: typeof authorization) =>
          dispatchWorkflowRegistry.workspaceRemoveMonitorRole.authorize({
            requester,
            authorization: currentAuthorization,
            payload: {
              client: discordClient,
              dispatchRequestId: "dispatch-server-remove-monitor-role",
              workspaceId: "workspace-1",
              roleId: "role-1",
              interactionResponseToken: "interaction-token",
              interactionResponseDeadlineEpochMs,
            },
          }),
        (currentAuthorization: typeof authorization) =>
          dispatchWorkflowRegistry.workspaceSetSheet.authorize({
            requester,
            authorization: currentAuthorization,
            payload: {
              client: discordClient,
              dispatchRequestId: "dispatch-server-set-sheet",
              workspaceId: "workspace-1",
              sheetId: "sheet-1",
              interactionResponseToken: "interaction-token",
              interactionResponseDeadlineEpochMs,
            },
          }),
        (currentAuthorization: typeof authorization) =>
          dispatchWorkflowRegistry.workspaceSetAutoCheckin.authorize({
            requester,
            authorization: currentAuthorization,
            payload: {
              client: discordClient,
              dispatchRequestId: "dispatch-server-set-auto-checkin",
              workspaceId: "workspace-1",
              autoCheckin: true,
              interactionResponseToken: "interaction-token",
              interactionResponseDeadlineEpochMs,
            },
          }),
      ];

      for (const authorize of cases) {
        yield* authorize(authorization);
        const denied = yield* Effect.exit(authorize(unauthorized));
        expect(denied._tag).toBe("Failure");
      }
    }),
  );

  it.live("requires monitor-workspace authorization snapshots for screenshot workflow", () =>
    Effect.gen(function* () {
      const request = {
        requester,
        authorization: { workspaceId: "workspace-1", scope: "monitor" as const },
        payload: {
          client: discordClient,
          dispatchRequestId: "dispatch-screenshot",
          workspaceId: "workspace-1",
          conversationName: "run",
          day: 1,
          interactionResponseToken: "interaction-token",
          interactionResponseDeadlineEpochMs,
        },
      };

      yield* dispatchWorkflowRegistry.screenshot.authorize(request);
      const denied = yield* Effect.exit(
        dispatchWorkflowRegistry.screenshot.authorize({
          ...request,
          authorization: { workspaceId: "workspace-2", scope: "monitor" as const },
        }),
      );
      expect(denied._tag).toBe("Failure");
    }),
  );

  it.live("allows team and schedule list for self or monitor snapshots", () =>
    Effect.gen(function* () {
      const base = {
        requester,
        payload: {
          client: discordClient,
          workspaceId: "workspace-1",
          targetUserId: requester.accountId,
          targetUsername: "Requester",
          interactionResponseToken: "interaction-token",
          interactionResponseDeadlineEpochMs,
        },
      };

      yield* dispatchWorkflowRegistry.teamList.authorize({
        ...base,
        payload: { ...base.payload, dispatchRequestId: "dispatch-team-list" },
      });
      yield* dispatchWorkflowRegistry.scheduleList.authorize({
        ...base,
        payload: { ...base.payload, dispatchRequestId: "dispatch-schedule-list", day: 1 },
      });

      const monitorAuthorization = { workspaceId: "workspace-1", scope: "monitor" as const };
      yield* dispatchWorkflowRegistry.teamList.authorize({
        ...base,
        authorization: monitorAuthorization,
        payload: {
          ...base.payload,
          dispatchRequestId: "dispatch-team-list-other",
          targetUserId: "account-2",
        },
      });
      const denied = yield* Effect.exit(
        dispatchWorkflowRegistry.scheduleList.authorize({
          ...base,
          payload: {
            ...base.payload,
            dispatchRequestId: "dispatch-schedule-list-other",
            day: 1,
            targetUserId: "account-2",
          },
        }),
      );
      expect(denied._tag).toBe("Failure");
    }),
  );

  it.live("routes slot workflows to DispatchService", () =>
    Effect.gen(function* () {
      const authorizedMessageSlot = makeMessageSlot();
      yield* Effect.gen(function* () {
        const buttonResult = yield* dispatchWorkflowRegistry.slotButton.execute({
          requester,
          payload: slotButtonPayload,
        });
        const listResult = yield* dispatchWorkflowRegistry.slotList.execute({
          requester,
          payload: slotListPayload,
        });
        const openButtonResult = yield* dispatchWorkflowRegistry.slotOpenButton.execute(
          {
            requester,
            payload: slotOpenButtonPayload,
          },
          authorizedMessageSlot,
        );

        expect(buttonResult).toEqual({
          messageId: "message-1",
          messageConversationId: "conversation-1",
          day: 1,
        });
        expect(listResult).toEqual({
          workspaceId: "workspace-1",
          day: 1,
          messageType: "ephemeral",
        });
        expect(openButtonResult).toEqual({
          messageId: "slot-message-1",
          workspaceId: "workspace-1",
          day: 2,
        });
      }).pipe(
        Effect.provideService(
          DispatchService,
          makeDispatchServiceMock({
            slotButton: (payload, currentRequester) =>
              Effect.sync(() => {
                expect(payload).toBe(slotButtonPayload);
                expect(currentRequester).toBe(requester);
                return {
                  messageId: "message-1",
                  messageConversationId: "conversation-1",
                  day: 1,
                } satisfies SlotButtonDispatchResult;
              }),
            slotList: (payload) =>
              Effect.sync(() => {
                expect(payload).toBe(slotListPayload);
                return {
                  workspaceId: "workspace-1",
                  day: 1,
                  messageType: "ephemeral",
                } satisfies SlotListDispatchResult;
              }),
            slotOpenButton: (payload, messageSlot) =>
              Effect.sync(() => {
                expect(payload).toBe(slotOpenButtonPayload);
                expect(messageSlot).toBe(authorizedMessageSlot);
                return {
                  messageId: payload.messageId,
                  workspaceId: "workspace-1",
                  day: 2,
                } satisfies SlotOpenButtonResult;
              }),
          }),
        ),
      );
    }),
  );

  it.live("routes service status workflow execution to DispatchService", () =>
    Effect.gen(function* () {
      const serviceStatus = vi.fn((payload: ServiceStatusDispatchPayload) =>
        Effect.sync(() => {
          expect(payload).toBe(serviceStatusPayload);
          return {
            overallStatus: "ok",
            okCount: 7,
            downCount: 0,
          } satisfies ServiceStatusDispatchResult;
        }),
      ) as DispatchServiceMock["serviceStatus"];

      yield* Effect.gen(function* () {
        const result = yield* dispatchWorkflowRegistry.serviceStatus.execute({
          requester,
          payload: serviceStatusPayload,
        });

        expect(result).toEqual({
          overallStatus: "ok",
          okCount: 7,
          downCount: 0,
        });
        expect(serviceStatus).toHaveBeenCalledWith(serviceStatusPayload);
      }).pipe(
        Effect.provideService(
          DispatchService,
          makeDispatchServiceMock({
            serviceStatus,
          }),
        ),
      );
    }),
  );

  it.live("routes workspace welcome workflow execution to DispatchService", () =>
    Effect.gen(function* () {
      const workspaceWelcome = vi.fn((payload: WorkspaceWelcomeDispatchPayload) =>
        Effect.sync(() => {
          expect(payload).toBe(workspaceWelcomePayload);
          return {
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            messageId: "message-1",
          } satisfies WorkspaceWelcomeDispatchResult;
        }),
      ) as DispatchServiceMock["workspaceWelcome"];

      yield* Effect.gen(function* () {
        const result = yield* dispatchWorkflowRegistry.workspaceWelcome.execute({
          requester,
          payload: workspaceWelcomePayload,
        });

        expect(result).toEqual({
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          messageId: "message-1",
        });
        expect(workspaceWelcome).toHaveBeenCalledWith(workspaceWelcomePayload);
      }).pipe(
        Effect.provideService(
          DispatchService,
          makeDispatchServiceMock({
            workspaceWelcome,
          }),
        ),
      );
    }),
  );

  it.live("routes service workspace feature flag workflows to DispatchService", () =>
    Effect.gen(function* () {
      const resultPayload = {
        workspaceId: "workspace-1",
        flagName: "beta-feature",
        announcementConversationId: "conversation-1",
        announcementMessageId: "message-1",
      } satisfies ServiceWorkspaceFeatureFlagDispatchResult;
      const serviceAddWorkspaceFeatureFlag = vi.fn(
        (payload: ServiceWorkspaceFeatureFlagDispatchPayload) =>
          Effect.sync(() => {
            expect(payload).toBe(serviceWorkspaceFeatureFlagPayload);
            return resultPayload;
          }),
      ) as DispatchServiceMock["serviceAddWorkspaceFeatureFlag"];
      const serviceRemoveWorkspaceFeatureFlag = vi.fn(
        (payload: ServiceWorkspaceFeatureFlagDispatchPayload) =>
          Effect.sync(() => {
            expect(payload).toBe(serviceWorkspaceFeatureFlagPayload);
            return resultPayload;
          }),
      ) as DispatchServiceMock["serviceRemoveWorkspaceFeatureFlag"];

      yield* Effect.gen(function* () {
        const addResult = yield* dispatchWorkflowRegistry.serviceAddWorkspaceFeatureFlag.execute({
          requester,
          payload: serviceWorkspaceFeatureFlagPayload,
        });
        const removeResult =
          yield* dispatchWorkflowRegistry.serviceRemoveWorkspaceFeatureFlag.execute({
            requester,
            payload: serviceWorkspaceFeatureFlagPayload,
          });

        expect(addResult).toEqual(resultPayload);
        expect(removeResult).toEqual(resultPayload);
        expect(serviceAddWorkspaceFeatureFlag).toHaveBeenCalledWith(
          serviceWorkspaceFeatureFlagPayload,
        );
        expect(serviceRemoveWorkspaceFeatureFlag).toHaveBeenCalledWith(
          serviceWorkspaceFeatureFlagPayload,
        );
      }).pipe(
        Effect.provideService(
          DispatchService,
          makeDispatchServiceMock({
            serviceAddWorkspaceFeatureFlag,
            serviceRemoveWorkspaceFeatureFlag,
          }),
        ),
      );
    }),
  );

  it.live("routes update announcement workflows to DispatchService", () =>
    Effect.gen(function* () {
      const resultPayload = {
        workspaceId: "workspace-1",
        announcementId: "update-announcements-2026-06-05",
        status: "sent",
        announcementConversationId: "conversation-1",
        announcementMessageId: "message-1",
      } satisfies UpdateAnnouncementDispatchResult;
      const updateAnnouncement = vi.fn((payload: UpdateAnnouncementDispatchPayload) =>
        Effect.sync(() => {
          expect(payload).toBe(updateAnnouncementPayload);
          return resultPayload;
        }),
      ) as DispatchServiceMock["updateAnnouncement"];

      yield* Effect.gen(function* () {
        const result = yield* dispatchWorkflowRegistry.updateAnnouncement.execute({
          requester,
          payload: updateAnnouncementPayload,
        });

        expect(result).toEqual(resultPayload);
        expect(updateAnnouncement).toHaveBeenCalledWith(updateAnnouncementPayload);
      }).pipe(
        Effect.provideService(
          DispatchService,
          makeDispatchServiceMock({
            updateAnnouncement,
          }),
        ),
      );
    }),
  );

  it.live(
    "does not overwrite handled interaction failure replies with the generic dispatch failure",
    () =>
      Effect.gen(function* () {
        const updateOriginalInteractionResponse = vi.fn(() => Effect.void);
        const serviceStatus = vi.fn(() =>
          Effect.fail(markInteractionFailureHandled(new Error("status failed"))),
        );

        const exit = yield* Effect.exit(
          DispatchServiceStatusWorkflow.execute({
            requester,
            payload: serviceStatusPayload,
          }),
        ).pipe(
          Effect.provide(
            DispatchServiceStatusWorkflow.toLayer(
              makeWorkflowHandler({ ...dispatchWorkflowRegistry.serviceStatus }),
            ),
          ),
          Effect.provideService(
            DispatchService,
            makeDispatchServiceMock({
              serviceStatus: serviceStatus as unknown as DispatchServiceMock["serviceStatus"],
            }),
          ),
          Effect.provideService(ClientDeliveryClient, {
            updateOriginalInteractionResponse,
          } as never),
          Effect.provide(WorkflowEngine.layerMemory),
        );

        expect(exit._tag).toBe("Failure");
        expect(serviceStatus).toHaveBeenCalledWith(serviceStatusPayload);
        expect(updateOriginalInteractionResponse).not.toHaveBeenCalled();
      }),
  );

  it.live("includes the thrown error message for unhandled interaction failures", () =>
    Effect.gen(function* () {
      const updateOriginalInteractionResponse = vi.fn(
        (_interactionResponseToken: string, _payload: unknown) => Effect.void,
      );
      const serviceStatus = vi.fn(() => Effect.fail(new Error("status failed")));

      const exit = yield* Effect.exit(
        DispatchServiceStatusWorkflow.execute({
          requester,
          payload: serviceStatusPayload,
        }),
      ).pipe(
        Effect.provide(
          DispatchServiceStatusWorkflow.toLayer(
            makeWorkflowHandler({ ...dispatchWorkflowRegistry.serviceStatus }),
          ),
        ),
        Effect.provideService(
          DispatchService,
          makeDispatchServiceMock({
            serviceStatus: serviceStatus as unknown as DispatchServiceMock["serviceStatus"],
          }),
        ),
        Effect.provideService(ClientDeliveryClient, {
          updateOriginalInteractionResponse,
        } as never),
        Effect.provide(WorkflowEngine.layerMemory),
      );

      expect(exit._tag).toBe("Failure");
      expect(serviceStatus).toHaveBeenCalledWith(serviceStatusPayload);
      expect(updateOriginalInteractionResponse).toHaveBeenCalledWith("interaction-token", {
        content:
          "Dispatch failed. Please try again.\nUnexpected error: status failed\nFull error is attached.",
        files: [
          expect.objectContaining({
            name: "error.txt",
            contentType: "text/plain",
            content: expect.any(Uint8Array),
          }),
        ],
      });
      const [, payload] = updateOriginalInteractionResponse.mock.calls[0]!;
      const [file] = (
        payload as { readonly files: ReadonlyArray<{ readonly content: Uint8Array }> }
      ).files;
      expect(new TextDecoder().decode(file.content)).toContain("status failed");
    }),
  );

  it("formats typed dispatch failures with actionable labels", () => {
    expect(
      dispatchFailureMessage({
        _tag: "SheetConfigError",
        message: "Error getting ranges config, no value ranges found",
      }),
    ).toBe(
      "Dispatch failed. Please try again.\nSheet config error: Error getting ranges config, no value ranges found",
    );

    expect(
      dispatchFailureMessage({ _tag: "ArgumentError", message: "message slot not found" }),
    ).toBe("Dispatch failed. Please try again.\nRequest error: message slot not found");

    expect(
      dispatchFailureMessage({ _tag: "FutureTaggedError", message: "new failure shape" }),
    ).toBe("Dispatch failed. Please try again.\nUnexpected error: new failure shape");
  });

  it("truncates long dispatch failure details", () => {
    const content = dispatchFailureMessage({
      _tag: "SchemaError",
      message: "x".repeat(2_000),
    });
    const detail = content.split("Data format error: ")[1]!;

    expect(detail.length).toBeLessThanOrEqual(1_200);
    expect(content).toMatch(/^Dispatch failed\. Please try again\.\nData format error: x+\.\.\.$/);
  });

  it("attaches the full dispatch failure trace as a text file", () => {
    const response = dispatchFailureResponse(new Error("workflow exploded"));

    expect(response.payload).toEqual({
      content:
        "Dispatch failed. Please try again.\nUnexpected error: workflow exploded\nFull error is attached.",
      files: [
        {
          name: "error.txt",
          contentType: "text/plain",
          content: expect.any(Uint8Array),
        },
      ],
    });
    expect(new TextDecoder().decode(response.payload.files[0]!.content)).toContain(
      "workflow exploded",
    );
  });

  it.live("routes check-in button workflows through the dispatch button entity", () =>
    Effect.gen(function* () {
      const expectedExecutionId =
        yield* dispatchWorkflowRegistry.checkinButton.workflow.executionId({
          requester,
          payload: checkinButtonPayload,
        });
      const checkinButton = vi.fn((payload: unknown) =>
        Effect.sync(() => {
          expect(payload).toEqual({
            request: {
              requester,
              payload: checkinButtonPayload,
            },
            executionId: expectedExecutionId,
          });
          return {
            messageId: checkinButtonPayload.messageId,
            messageConversationId: "conversation-1",
            checkedInMemberId: requester.accountId,
          } satisfies CheckinHandleButtonResult;
        }),
      );
      const makeClient = vi.fn((entityId: string) => {
        expect(entityId).toBe(checkinButtonPayload.messageId);
        return { checkinButton } as never;
      });

      yield* DispatchCheckinButtonWorkflow.execute({
        requester,
        payload: checkinButtonPayload,
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() =>
            expect(result).toEqual({
              messageId: checkinButtonPayload.messageId,
              messageConversationId: "conversation-1",
              checkedInMemberId: requester.accountId,
            }),
          ),
        ),
        Effect.provide(
          DispatchCheckinButtonWorkflow.toLayer(
            makeButtonWorkflowHandler({ ...dispatchWorkflowRegistry.checkinButton }),
          ),
        ),
        Effect.provideService(
          Sharding.Sharding,
          makeShardingMock({
            makeClient: () => Effect.succeed(makeClient),
          }),
        ),
        Effect.provideService(DispatchService, makeDispatchServiceMock({})),
        Effect.provide(
          Layer.succeed(SheetApisClient)(
            makeSheetApisClientMock({
              getMessageCheckinMembers: () =>
                Effect.succeed([makeMessageCheckinMember(requester.accountId)]),
            }),
          ),
        ),
        Effect.provideService(ClientDeliveryClient, {
          updateOriginalInteractionResponse: () => Effect.void,
        } as never),
        Effect.provide(WorkflowEngine.layerMemory),
      );

      expect(makeClient).toHaveBeenCalledTimes(1);
      expect(checkinButton).toHaveBeenCalledTimes(1);
    }),
  );

  it.live("authorizes slot open buttons from modern message slot records", () =>
    Effect.gen(function* () {
      const messageSlot = makeMessageSlot();
      yield* Effect.gen(function* () {
        const authorized = yield* dispatchWorkflowRegistry.slotOpenButton.authorize({
          requester,
          payload: slotOpenButtonPayload,
        });

        expect(authorized).toBe(messageSlot);
      }).pipe(
        Effect.provide(
          Layer.succeed(SheetApisClient)(
            makeSheetApisClientMock({
              getMessageSlotData: ({ query }) =>
                Effect.sync(() => {
                  expect(query.messageId).toBe(slotOpenButtonPayload.messageId);
                  expect(query.clientPlatform).toBe("discord");
                  expect(query.clientId).toBe("discord-main");
                  return messageSlot;
                }),
            }),
          ),
        ),
      );
    }),
  );

  it.live("rejects legacy slot open button records without modern authorization fields", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const denied = yield* dispatchWorkflowRegistry.slotOpenButton
          .authorize({
            requester,
            payload: slotOpenButtonPayload,
          })
          .pipe(Effect.flip);

        expect(denied).toMatchObject({
          _tag: "Unauthorized",
          message: "Legacy message slot records are no longer accessible",
        });
      }).pipe(
        Effect.provide(
          Layer.succeed(SheetApisClient)(
            makeSheetApisClientMock({
              getMessageSlotData: () =>
                Effect.succeed(
                  makeMessageSlot({
                    workspaceId: Option.none(),
                    conversationId: Option.some("conversation-1"),
                  }),
                ),
            }),
          ),
        ),
      );
    }),
  );

  it.live("rejects missing slot open button records", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const denied = yield* dispatchWorkflowRegistry.slotOpenButton
          .authorize({
            requester,
            payload: slotOpenButtonPayload,
          })
          .pipe(Effect.flip);

        expect(denied).toMatchObject({
          _tag: "ArgumentError",
          message: "message slot not found",
        });
      }).pipe(
        Effect.provide(
          Layer.succeed(SheetApisClient)(
            makeSheetApisClientMock({
              getMessageSlotData: () =>
                Effect.fail({ _tag: "ArgumentError", message: "message slot not found" }),
            }),
          ),
        ),
      );
    }),
  );

  it.live("rejects check-in button access for non-participants", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const denied = yield* dispatchWorkflowRegistry.checkinButton
          .authorize({
            requester,
            payload: checkinButtonPayload,
          })
          .pipe(Effect.flip);

        expect(denied).toBeInstanceOf(Unauthorized);
      }).pipe(
        Effect.provide(
          Layer.succeed(SheetApisClient)(
            makeSheetApisClientMock({
              getMessageCheckinMembers: () =>
                Effect.succeed([makeMessageCheckinMember("different-account")]),
            }),
          ),
        ),
      );
    }),
  );

  it.effect("allows pin-tentative workflow payloads without an authorization snapshot", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(
        dispatchWorkflowRegistry.roomOrderPinTentativeButton.workflow.payloadSchema,
      )({
        requester,
        payload: pinTentativePayload,
      });

      expect(decoded.authorizedRoomOrder).toBeUndefined();
    }),
  );

  it.live("builds deterministic workflow execution ids", () =>
    Effect.gen(function* () {
      const left = yield* dispatchWorkflowRegistry.checkin.workflow.executionId({
        requester,
        payload: checkinPayload,
      });
      const right = yield* dispatchWorkflowRegistry.checkin.workflow.executionId({
        requester: { accountId: "account-2", userId: "user-2" },
        payload: checkinPayload,
      });
      const different = yield* dispatchWorkflowRegistry.checkin.workflow.executionId({
        requester,
        payload: {
          ...checkinPayload,
          dispatchRequestId: "dispatch-2",
        },
      });
      const workspaceWelcomeLeft =
        yield* dispatchWorkflowRegistry.workspaceWelcome.workflow.executionId({
          requester,
          payload: workspaceWelcomePayload,
        });
      const workspaceWelcomeRight =
        yield* dispatchWorkflowRegistry.workspaceWelcome.workflow.executionId({
          requester: { accountId: "account-2", userId: "user-2" },
          payload: workspaceWelcomePayload,
        });
      const updateAnnouncementLeft =
        yield* dispatchWorkflowRegistry.updateAnnouncement.workflow.executionId({
          requester,
          payload: updateAnnouncementPayload,
        });
      const updateAnnouncementRight =
        yield* dispatchWorkflowRegistry.updateAnnouncement.workflow.executionId({
          requester: { accountId: "account-2", userId: "user-2" },
          payload: updateAnnouncementPayload,
        });

      expect(left).toBe(right);
      expect(left).not.toBe(different);
      expect(workspaceWelcomeLeft).toBe(workspaceWelcomeRight);
      expect(updateAnnouncementLeft).toBe(updateAnnouncementRight);
    }),
  );
});
