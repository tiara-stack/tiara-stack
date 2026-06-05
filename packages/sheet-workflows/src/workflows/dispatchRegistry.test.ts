import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { ClusterSchema, Sharding } from "effect/unstable/cluster";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { WorkflowEngine } from "effect/unstable/workflow";
import { vi } from "vitest";
import { MessageCheckinMember } from "sheet-ingress-api/schemas/messageCheckin";
import { MessageSlot } from "sheet-ingress-api/schemas/messageSlot";
import {
  DispatchWorkflows as SheetIngressDispatchWorkflows,
  type DispatchRequester,
} from "sheet-ingress-api/sheet-workflows-workflows";
import type {
  CheckinDispatchPayload,
  CheckinDispatchResult,
  CheckinHandleButtonPayload,
  CheckinHandleButtonResult,
  GuildWelcomeDispatchPayload,
  GuildWelcomeDispatchResult,
  KickoutDispatchPayload,
  KickoutDispatchResult,
  RoomOrderPinTentativeButtonPayload,
  ServiceGuildFeatureFlagDispatchPayload,
  ServiceGuildFeatureFlagDispatchResult,
  ServiceStatusDispatchPayload,
  ServiceStatusDispatchResult,
  SlotButtonDispatchPayload,
  SlotButtonDispatchResult,
  SlotListDispatchPayload,
  SlotListDispatchResult,
  SlotOpenButtonPayload,
  SlotOpenButtonResult,
} from "sheet-ingress-api/sheet-apis-rpc";
import { Unauthorized } from "typhoon-core/error";
import { markInteractionFailureHandled } from "@/handlers/shared/interactionFailure";
import { DispatchService, IngressBotClient, SheetApisClient } from "@/services";
import {
  dispatchWorkflowNames,
  dispatchWorkflowRegistry,
  makeButtonWorkflowHandler,
  makeWorkflowHandler,
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

const checkinPayload: CheckinDispatchPayload = {
  dispatchRequestId: "dispatch-1",
  guildId: "guild-1",
  channelId: "channel-1",
};

const kickoutPayload: KickoutDispatchPayload = {
  dispatchRequestId: "dispatch-kickout",
  guildId: "guild-1",
  channelId: "channel-1",
};

const slotButtonPayload: SlotButtonDispatchPayload = {
  dispatchRequestId: "dispatch-slot-button",
  guildId: "guild-1",
  channelId: "channel-1",
  day: 1,
  interactionToken: "interaction-token",
  interactionDeadlineEpochMs: 4_102_444_800_000,
};

const slotListPayload: SlotListDispatchPayload = {
  dispatchRequestId: "dispatch-slot-list",
  guildId: "guild-1",
  day: 1,
  messageType: "ephemeral",
  interactionToken: "interaction-token",
  interactionDeadlineEpochMs: 4_102_444_800_000,
};

const slotOpenButtonPayload: SlotOpenButtonPayload = {
  messageId: "slot-message-1",
  interactionToken: "interaction-token",
  interactionDeadlineEpochMs: 4_102_444_800_000,
};

const serviceStatusPayload: ServiceStatusDispatchPayload = {
  dispatchRequestId: "dispatch-service-status",
  interactionToken: "interaction-token",
  interactionDeadlineEpochMs: 4_102_444_800_000,
};

const guildWelcomePayload: GuildWelcomeDispatchPayload = {
  dispatchRequestId: "discord-guild-create:guild-1:2026-05-31T00:00:00.000Z",
  guildId: "guild-1",
  guildName: "Guild One",
  joinedAt: "2026-05-31T00:00:00.000Z",
  systemChannelId: "system-channel",
};

const serviceGuildFeatureFlagPayload: ServiceGuildFeatureFlagDispatchPayload = {
  dispatchRequestId: "dispatch-service-guild-feature-flag",
  guildId: "guild-1",
  flagName: "beta-feature",
  systemChannelId: "system-channel",
};

const interactionDeadlineEpochMs = 4_102_444_800_000;

const checkinButtonPayload: CheckinHandleButtonPayload = {
  messageId: "message-1",
  interactionToken: "interaction-token",
  interactionDeadlineEpochMs,
};

const pinTentativePayload: RoomOrderPinTentativeButtonPayload = {
  guildId: "guild-1",
  messageId: "message-1",
  messageChannelId: "channel-1",
  interactionToken: "interaction-token",
  interactionDeadlineEpochMs,
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
  checkin: unexpectedDispatchServiceCall("checkin"),
  roomOrder: unexpectedDispatchServiceCall("roomOrder"),
  kickout: unexpectedDispatchServiceCall("kickout"),
  slotButton: unexpectedDispatchServiceCall("slotButton"),
  slotList: unexpectedDispatchServiceCall("slotList"),
  slotOpenButton: unexpectedDispatchServiceCall("slotOpenButton"),
  serviceStatus: unexpectedDispatchServiceCall("serviceStatus"),
  guildWelcome: unexpectedDispatchServiceCall("guildWelcome"),
  serviceAddGuildFeatureFlag: unexpectedDispatchServiceCall("serviceAddGuildFeatureFlag"),
  serviceRemoveGuildFeatureFlag: unexpectedDispatchServiceCall("serviceRemoveGuildFeatureFlag"),
  checkinButton: unexpectedDispatchServiceCall("checkinButton"),
  roomOrderPreviousButton: unexpectedDispatchServiceCall("roomOrderPreviousButton"),
  roomOrderNextButton: unexpectedDispatchServiceCall("roomOrderNextButton"),
  roomOrderSendButton: unexpectedDispatchServiceCall("roomOrderSendButton"),
  roomOrderPinTentativeButton: unexpectedDispatchServiceCall("roomOrderPinTentativeButton"),
  channelListConfig: unexpectedDispatchServiceCall("channelListConfig"),
  channelSet: unexpectedDispatchServiceCall("channelSet"),
  channelUnset: unexpectedDispatchServiceCall("channelUnset"),
  serverListConfig: unexpectedDispatchServiceCall("serverListConfig"),
  serverAddMonitorRole: unexpectedDispatchServiceCall("serverAddMonitorRole"),
  serverRemoveMonitorRole: unexpectedDispatchServiceCall("serverRemoveMonitorRole"),
  serverSetSheet: unexpectedDispatchServiceCall("serverSetSheet"),
  serverSetAutoCheckin: unexpectedDispatchServiceCall("serverSetAutoCheckin"),
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
    messageId: checkinButtonPayload.messageId,
    memberId,
    checkinAt: Option.none(),
    checkinClaimId: Option.none(),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
  });

const makeMessageSlot = (overrides?: {
  readonly guildId?: Option.Option<string>;
  readonly messageChannelId?: Option.Option<string>;
}) =>
  new MessageSlot({
    messageId: slotOpenButtonPayload.messageId,
    day: 2,
    guildId: overrides?.guildId ?? Option.some("guild-1"),
    messageChannelId: overrides?.messageChannelId ?? Option.some("channel-1"),
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
      "checkin",
      "roomOrder",
      "kickout",
      "slotButton",
      "slotList",
      "slotOpenButton",
      "serviceStatus",
      "guildWelcome",
      "serviceAddGuildFeatureFlag",
      "serviceRemoveGuildFeatureFlag",
      "checkinButton",
      "roomOrderPreviousButton",
      "roomOrderNextButton",
      "roomOrderSendButton",
      "roomOrderPinTentativeButton",
      "channelListConfig",
      "channelSet",
      "channelUnset",
      "serverListConfig",
      "serverAddMonitorRole",
      "serverRemoveMonitorRole",
      "serverSetSheet",
      "serverSetAutoCheckin",
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

  it("routes check-in workflow execution to DispatchService", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* dispatchWorkflowRegistry.checkin.execute({
          requester,
          payload: checkinPayload,
        });

        expect(result).toEqual({
          hour: 1,
          runningChannelId: "running-channel",
          checkinChannelId: "checkin-channel",
          checkinMessageId: "checkin-message",
          checkinMessageChannelId: "checkin-channel",
          primaryMessageId: "primary-message",
          primaryMessageChannelId: "primary-channel",
          tentativeRoomOrderMessageId: null,
          tentativeRoomOrderMessageChannelId: null,
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
                  runningChannelId: "running-channel",
                  checkinChannelId: "checkin-channel",
                  checkinMessageId: "checkin-message",
                  checkinMessageChannelId: "checkin-channel",
                  primaryMessageId: "primary-message",
                  primaryMessageChannelId: "primary-channel",
                  tentativeRoomOrderMessageId: null,
                  tentativeRoomOrderMessageChannelId: null,
                };
              }),
          }),
        ),
        Effect.provide(Layer.empty),
      ),
    );
  });

  it("routes kickout workflow execution to DispatchService", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* dispatchWorkflowRegistry.kickout.execute({
          requester,
          payload: kickoutPayload,
        });

        expect(result).toEqual({
          guildId: "guild-1",
          runningChannelId: "channel-1",
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
                  guildId: "guild-1",
                  runningChannelId: "channel-1",
                  hour: 1,
                  roleId: "role-1",
                  removedMemberIds: ["account-2"],
                  status: "removed",
                } satisfies KickoutDispatchResult;
              }),
          }),
        ),
      ),
    );
  });

  it("requires manage-guild authorization snapshots for config mutation workflows", async () => {
    type TestAuthorization = {
      readonly guildId: string;
      readonly scope: "member" | "monitor" | "manage";
    };
    const authorization: TestAuthorization = { guildId: "guild-1", scope: "manage" };
    const unauthorized: TestAuthorization = { guildId: "guild-1", scope: "monitor" };
    const cases = [
      (currentAuthorization: typeof authorization) =>
        dispatchWorkflowRegistry.channelSet.authorize({
          requester,
          authorization: currentAuthorization,
          payload: {
            dispatchRequestId: "dispatch-channel-set",
            guildId: "guild-1",
            channelId: "channel-1",
            running: true,
            interactionToken: "interaction-token",
            interactionDeadlineEpochMs,
          },
        }),
      (currentAuthorization: typeof authorization) =>
        dispatchWorkflowRegistry.channelUnset.authorize({
          requester,
          authorization: currentAuthorization,
          payload: {
            dispatchRequestId: "dispatch-channel-unset",
            guildId: "guild-1",
            channelId: "channel-1",
            running: true,
            interactionToken: "interaction-token",
            interactionDeadlineEpochMs,
          },
        }),
      (currentAuthorization: typeof authorization) =>
        dispatchWorkflowRegistry.serverAddMonitorRole.authorize({
          requester,
          authorization: currentAuthorization,
          payload: {
            dispatchRequestId: "dispatch-server-add-monitor-role",
            guildId: "guild-1",
            roleId: "role-1",
            interactionToken: "interaction-token",
            interactionDeadlineEpochMs,
          },
        }),
      (currentAuthorization: typeof authorization) =>
        dispatchWorkflowRegistry.serverRemoveMonitorRole.authorize({
          requester,
          authorization: currentAuthorization,
          payload: {
            dispatchRequestId: "dispatch-server-remove-monitor-role",
            guildId: "guild-1",
            roleId: "role-1",
            interactionToken: "interaction-token",
            interactionDeadlineEpochMs,
          },
        }),
      (currentAuthorization: typeof authorization) =>
        dispatchWorkflowRegistry.serverSetSheet.authorize({
          requester,
          authorization: currentAuthorization,
          payload: {
            dispatchRequestId: "dispatch-server-set-sheet",
            guildId: "guild-1",
            sheetId: "sheet-1",
            interactionToken: "interaction-token",
            interactionDeadlineEpochMs,
          },
        }),
      (currentAuthorization: typeof authorization) =>
        dispatchWorkflowRegistry.serverSetAutoCheckin.authorize({
          requester,
          authorization: currentAuthorization,
          payload: {
            dispatchRequestId: "dispatch-server-set-auto-checkin",
            guildId: "guild-1",
            autoCheckin: true,
            interactionToken: "interaction-token",
            interactionDeadlineEpochMs,
          },
        }),
    ];

    for (const authorize of cases) {
      await Effect.runPromise(authorize(authorization));
      const denied = await Effect.runPromiseExit(authorize(unauthorized));
      expect(denied._tag).toBe("Failure");
    }
  });

  it("requires monitor-guild authorization snapshots for screenshot workflow", async () => {
    const request = {
      requester,
      authorization: { guildId: "guild-1", scope: "monitor" as const },
      payload: {
        dispatchRequestId: "dispatch-screenshot",
        guildId: "guild-1",
        channelName: "run",
        day: 1,
        interactionToken: "interaction-token",
        interactionDeadlineEpochMs,
      },
    };

    await Effect.runPromise(dispatchWorkflowRegistry.screenshot.authorize(request));
    const denied = await Effect.runPromiseExit(
      dispatchWorkflowRegistry.screenshot.authorize({
        ...request,
        authorization: { guildId: "guild-2", scope: "monitor" as const },
      }),
    );
    expect(denied._tag).toBe("Failure");
  });

  it("allows team and schedule list for self or monitor snapshots", async () => {
    const base = {
      requester,
      payload: {
        guildId: "guild-1",
        targetUserId: requester.accountId,
        targetUsername: "Requester",
        interactionToken: "interaction-token",
        interactionDeadlineEpochMs,
      },
    };

    await Effect.runPromise(
      dispatchWorkflowRegistry.teamList.authorize({
        ...base,
        payload: { ...base.payload, dispatchRequestId: "dispatch-team-list" },
      }),
    );
    await Effect.runPromise(
      dispatchWorkflowRegistry.scheduleList.authorize({
        ...base,
        payload: { ...base.payload, dispatchRequestId: "dispatch-schedule-list", day: 1 },
      }),
    );

    const monitorAuthorization = { guildId: "guild-1", scope: "monitor" as const };
    await Effect.runPromise(
      dispatchWorkflowRegistry.teamList.authorize({
        ...base,
        authorization: monitorAuthorization,
        payload: {
          ...base.payload,
          dispatchRequestId: "dispatch-team-list-other",
          targetUserId: "account-2",
        },
      }),
    );
    const denied = await Effect.runPromiseExit(
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
  });

  it("routes slot workflows to DispatchService", async () => {
    const authorizedMessageSlot = makeMessageSlot();
    await Effect.runPromise(
      Effect.gen(function* () {
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
          messageChannelId: "channel-1",
          day: 1,
        });
        expect(listResult).toEqual({
          guildId: "guild-1",
          day: 1,
          messageType: "ephemeral",
        });
        expect(openButtonResult).toEqual({
          messageId: "slot-message-1",
          guildId: "guild-1",
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
                  messageChannelId: "channel-1",
                  day: 1,
                } satisfies SlotButtonDispatchResult;
              }),
            slotList: (payload) =>
              Effect.sync(() => {
                expect(payload).toBe(slotListPayload);
                return {
                  guildId: "guild-1",
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
                  guildId: "guild-1",
                  day: 2,
                } satisfies SlotOpenButtonResult;
              }),
          }),
        ),
      ),
    );
  });

  it("routes service status workflow execution to DispatchService", async () => {
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

    await Effect.runPromise(
      Effect.gen(function* () {
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
      ),
    );
  });

  it("routes guild welcome workflow execution to DispatchService", async () => {
    const guildWelcome = vi.fn((payload: GuildWelcomeDispatchPayload) =>
      Effect.sync(() => {
        expect(payload).toBe(guildWelcomePayload);
        return {
          guildId: "guild-1",
          channelId: "channel-1",
          messageId: "message-1",
        } satisfies GuildWelcomeDispatchResult;
      }),
    ) as DispatchServiceMock["guildWelcome"];

    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* dispatchWorkflowRegistry.guildWelcome.execute({
          requester,
          payload: guildWelcomePayload,
        });

        expect(result).toEqual({
          guildId: "guild-1",
          channelId: "channel-1",
          messageId: "message-1",
        });
        expect(guildWelcome).toHaveBeenCalledWith(guildWelcomePayload);
      }).pipe(
        Effect.provideService(
          DispatchService,
          makeDispatchServiceMock({
            guildWelcome,
          }),
        ),
      ),
    );
  });

  it("routes service guild feature flag workflows to DispatchService", async () => {
    const resultPayload = {
      guildId: "guild-1",
      flagName: "beta-feature",
      announcementChannelId: "channel-1",
      announcementMessageId: "message-1",
    } satisfies ServiceGuildFeatureFlagDispatchResult;
    const serviceAddGuildFeatureFlag = vi.fn((payload: ServiceGuildFeatureFlagDispatchPayload) =>
      Effect.sync(() => {
        expect(payload).toBe(serviceGuildFeatureFlagPayload);
        return resultPayload;
      }),
    ) as DispatchServiceMock["serviceAddGuildFeatureFlag"];
    const serviceRemoveGuildFeatureFlag = vi.fn((payload: ServiceGuildFeatureFlagDispatchPayload) =>
      Effect.sync(() => {
        expect(payload).toBe(serviceGuildFeatureFlagPayload);
        return resultPayload;
      }),
    ) as DispatchServiceMock["serviceRemoveGuildFeatureFlag"];

    await Effect.runPromise(
      Effect.gen(function* () {
        const addResult = yield* dispatchWorkflowRegistry.serviceAddGuildFeatureFlag.execute({
          requester,
          payload: serviceGuildFeatureFlagPayload,
        });
        const removeResult = yield* dispatchWorkflowRegistry.serviceRemoveGuildFeatureFlag.execute({
          requester,
          payload: serviceGuildFeatureFlagPayload,
        });

        expect(addResult).toEqual(resultPayload);
        expect(removeResult).toEqual(resultPayload);
        expect(serviceAddGuildFeatureFlag).toHaveBeenCalledWith(serviceGuildFeatureFlagPayload);
        expect(serviceRemoveGuildFeatureFlag).toHaveBeenCalledWith(serviceGuildFeatureFlagPayload);
      }).pipe(
        Effect.provideService(
          DispatchService,
          makeDispatchServiceMock({
            serviceAddGuildFeatureFlag,
            serviceRemoveGuildFeatureFlag,
          }),
        ),
      ),
    );
  });

  it("does not overwrite handled interaction failure replies with the generic dispatch failure", async () => {
    const updateOriginalInteractionResponse = vi.fn(() => Effect.void);
    const serviceStatus = vi.fn(() =>
      Effect.fail(markInteractionFailureHandled(new Error("status failed"))),
    );

    const exit = await Effect.runPromise(
      Effect.exit(
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
        Effect.provideService(IngressBotClient, {
          updateOriginalInteractionResponse,
        } as never),
        Effect.provide(WorkflowEngine.layerMemory),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(serviceStatus).toHaveBeenCalledWith(serviceStatusPayload);
    expect(updateOriginalInteractionResponse).not.toHaveBeenCalled();
  });

  it("keeps the generic dispatch failure for unhandled interaction failures", async () => {
    const updateOriginalInteractionResponse = vi.fn(() => Effect.void);
    const serviceStatus = vi.fn(() => Effect.fail(new Error("status failed")));

    const exit = await Effect.runPromise(
      Effect.exit(
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
        Effect.provideService(IngressBotClient, {
          updateOriginalInteractionResponse,
        } as never),
        Effect.provide(WorkflowEngine.layerMemory),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(serviceStatus).toHaveBeenCalledWith(serviceStatusPayload);
    expect(updateOriginalInteractionResponse).toHaveBeenCalledWith("interaction-token", {
      content: "Dispatch failed. Please try again.",
    });
  });

  it("routes check-in button workflows through the dispatch button entity", async () => {
    const expectedExecutionId = await Effect.runPromise(
      dispatchWorkflowRegistry.checkinButton.workflow.executionId({
        requester,
        payload: checkinButtonPayload,
      }),
    );
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
          messageChannelId: "channel-1",
          checkedInMemberId: requester.accountId,
        } satisfies CheckinHandleButtonResult;
      }),
    );
    const makeClient = vi.fn((entityId: string) => {
      expect(entityId).toBe(checkinButtonPayload.messageId);
      return { checkinButton } as never;
    });

    await Effect.runPromise(
      DispatchCheckinButtonWorkflow.execute({
        requester,
        payload: checkinButtonPayload,
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() =>
            expect(result).toEqual({
              messageId: checkinButtonPayload.messageId,
              messageChannelId: "channel-1",
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
        Effect.provideService(IngressBotClient, {
          updateOriginalInteractionResponse: () => Effect.void,
        } as never),
        Effect.provide(WorkflowEngine.layerMemory),
      ),
    );

    expect(makeClient).toHaveBeenCalledTimes(1);
    expect(checkinButton).toHaveBeenCalledTimes(1);
  });

  it("authorizes slot open buttons from modern message slot records", async () => {
    const messageSlot = makeMessageSlot();
    await Effect.runPromise(
      Effect.gen(function* () {
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
                  return messageSlot;
                }),
            }),
          ),
        ),
      ),
    );
  });

  it("rejects legacy slot open button records without modern authorization fields", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
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
                    guildId: Option.none(),
                    messageChannelId: Option.some("channel-1"),
                  }),
                ),
            }),
          ),
        ),
      ),
    );
  });

  it("rejects missing slot open button records", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
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
      ),
    );
  });

  it("rejects check-in button access for non-participants", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
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
      ),
    );
  });

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

  it("builds deterministic workflow execution ids", async () => {
    const left = await Effect.runPromise(
      dispatchWorkflowRegistry.checkin.workflow.executionId({
        requester,
        payload: checkinPayload,
      }),
    );
    const right = await Effect.runPromise(
      dispatchWorkflowRegistry.checkin.workflow.executionId({
        requester: { accountId: "account-2", userId: "user-2" },
        payload: checkinPayload,
      }),
    );
    const different = await Effect.runPromise(
      dispatchWorkflowRegistry.checkin.workflow.executionId({
        requester,
        payload: {
          ...checkinPayload,
          dispatchRequestId: "dispatch-2",
        },
      }),
    );
    const guildWelcomeLeft = await Effect.runPromise(
      dispatchWorkflowRegistry.guildWelcome.workflow.executionId({
        requester,
        payload: guildWelcomePayload,
      }),
    );
    const guildWelcomeRight = await Effect.runPromise(
      dispatchWorkflowRegistry.guildWelcome.workflow.executionId({
        requester: { accountId: "account-2", userId: "user-2" },
        payload: guildWelcomePayload,
      }),
    );

    expect(left).toBe(right);
    expect(left).not.toBe(different);
    expect(guildWelcomeLeft).toBe(guildWelcomeRight);
  });
});
