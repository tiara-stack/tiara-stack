import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { MessageCheckinMember } from "sheet-ingress-api/schemas/messageCheckin";
import {
  DispatchWorkflows,
  type DispatchRequester,
} from "sheet-ingress-api/sheet-cluster-workflows";
import type {
  CheckinDispatchPayload,
  CheckinHandleButtonPayload,
  CheckinDispatchResult,
  KickoutDispatchPayload,
  KickoutDispatchResult,
  RoomOrderPinTentativeButtonPayload,
  SlotButtonDispatchPayload,
  SlotButtonDispatchResult,
  SlotListDispatchPayload,
  SlotListDispatchResult,
} from "sheet-ingress-api/sheet-apis-rpc";
import { Unauthorized } from "typhoon-core/error";
import { DispatchService, SheetApisClient } from "@/services";
import { dispatchWorkflowNames, dispatchWorkflowRegistry } from "./dispatchRegistry";

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
type SheetApisClientMock = typeof SheetApisClient.Service;
type SheetApisApiClient = ReturnType<SheetApisClientMock["get"]>;
type MessageCheckinClient = SheetApisApiClient["messageCheckin"];
type GetMessageCheckinMembersRequest = Parameters<
  MessageCheckinClient["getMessageCheckinMembers"]
>[0];
type GetMessageCheckinMembersMock = (
  request: GetMessageCheckinMembersRequest,
) => Effect.Effect<ReadonlyArray<MessageCheckinMember>>;
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
  checkinButton: unexpectedDispatchServiceCall("checkinButton"),
  roomOrderPreviousButton: unexpectedDispatchServiceCall("roomOrderPreviousButton"),
  roomOrderNextButton: unexpectedDispatchServiceCall("roomOrderNextButton"),
  roomOrderSendButton: unexpectedDispatchServiceCall("roomOrderSendButton"),
  roomOrderPinTentativeButton: unexpectedDispatchServiceCall("roomOrderPinTentativeButton"),
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

const makeSheetApisClientMock = (overrides: {
  readonly getMessageCheckinMembers: GetMessageCheckinMembersMock;
}): SheetApisClientMock => {
  const getMessageCheckinMembers: MessageCheckinClient["getMessageCheckinMembers"] = (request) => {
    if (request.responseMode && request.responseMode !== "decoded-only") {
      return Effect.die(`Unexpected responseMode ${request.responseMode}`);
    }

    return overrides
      .getMessageCheckinMembers(request)
      .pipe(
        Effect.map(
          (members) =>
            members as DecodedResponse<
              ReadonlyArray<MessageCheckinMember>,
              NonNullable<typeof request.responseMode> | "decoded-only"
            >,
        ),
      );
  };
  const messageCheckin: Pick<MessageCheckinClient, "getMessageCheckinMembers"> = {
    getMessageCheckinMembers,
  };
  const client = new Proxy(
    { messageCheckin },
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
    expect(dispatchWorkflowNames).toEqual(DispatchWorkflows.map((workflow) => workflow.name));
    expect(Object.keys(dispatchWorkflowRegistry)).toEqual([
      "checkin",
      "roomOrder",
      "kickout",
      "slotButton",
      "slotList",
      "checkinButton",
      "roomOrderPreviousButton",
      "roomOrderNextButton",
      "roomOrderSendButton",
      "roomOrderPinTentativeButton",
    ]);
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

  it("routes slot workflows to DispatchService", async () => {
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
          }),
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

    expect(left).toBe(right);
    expect(left).not.toBe(different);
  });
});
