import { describe, expect, it, vi } from "vitest";
import { Effect, HashSet, Option, Redacted } from "effect";
import { Headers } from "effect/unstable/http";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import { DispatchRoomOrderButtonMethods } from "sheet-ingress-api/sheet-apis-rpc";
import { DispatchWorkflowOperations } from "sheet-ingress-api/sheet-workflows-workflows";
import { getIngressRpcHeaders } from "./rpcAuthorizationClient";
import { SheetWorkflowsForwardingClient } from "./sheetWorkflowsForwardingClient";
import { SheetWorkflowsRpcClient } from "./sheetWorkflowsRpcClient";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";

const makeSheetApisRpcTokens = () =>
  ({
    getServiceToken: (tokenPath: string) => Effect.succeed(`${tokenPath}-token`),
  }) as never;

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(SheetApisRpcTokens, makeSheetApisRpcTokens()),
      Effect.provideService(SheetAuthUser, {
        accountId: "discord-user-1",
        userId: "user-1",
        permissions: HashSet.empty(),
        token: Redacted.make("sheet-auth-session-token"),
      }),
    ) as Effect.Effect<A, E, never>,
  );

describe("SheetWorkflowsForwardingClient", () => {
  it("builds sheet-workflows ingress headers with sheet-auth session token but no Discord access token", async () => {
    const headers = await run(getIngressRpcHeaders({ serviceTokenPath: "sheet-workflows-token" }));

    expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-ingress-auth"))).toBe(
      "Bearer sheet-workflows-token-token",
    );
    expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-user-id"))).toBe("user-1");
    expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-account-id"))).toBe(
      "discord-user-1",
    );
    expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-session-token"))).toBe(
      "Bearer sheet-auth-session-token",
    );
    expect(Option.isNone(Headers.get(headers, "x-sheet-discord-access-token"))).toBe(true);
  });

  it("builds sheet-bot ingress headers with the sheet-bot service token and shared auth context", async () => {
    const headers = await run(getIngressRpcHeaders({ serviceTokenPath: "sheet-bot-token" }));

    expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-ingress-auth"))).toBe(
      "Bearer sheet-bot-token-token",
    );
    expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-user-id"))).toBe("user-1");
    expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-account-id"))).toBe(
      "discord-user-1",
    );
    expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-session-token"))).toBe(
      "Bearer sheet-auth-session-token",
    );
  });

  it("keeps split room-order forwarding methods aligned with shared button metadata", async () => {
    const makeDiscard = (operation: {
      readonly workflow: { executionId: (payload: never) => Effect.Effect<string> };
    }) => vi.fn((payload) => operation.workflow.executionId(payload as never));
    const rpcClient = {
      [DispatchWorkflowOperations.checkin.discardRpcTag]: makeDiscard(
        DispatchWorkflowOperations.checkin,
      ),
      [DispatchWorkflowOperations.checkinButton.discardRpcTag]: makeDiscard(
        DispatchWorkflowOperations.checkinButton,
      ),
      [DispatchWorkflowOperations.roomOrder.discardRpcTag]: makeDiscard(
        DispatchWorkflowOperations.roomOrder,
      ),
      [DispatchWorkflowOperations.kickout.discardRpcTag]: makeDiscard(
        DispatchWorkflowOperations.kickout,
      ),
      [DispatchWorkflowOperations.slotButton.discardRpcTag]: makeDiscard(
        DispatchWorkflowOperations.slotButton,
      ),
      [DispatchWorkflowOperations.slotList.discardRpcTag]: makeDiscard(
        DispatchWorkflowOperations.slotList,
      ),
      [DispatchWorkflowOperations.serviceStatus.discardRpcTag]: makeDiscard(
        DispatchWorkflowOperations.serviceStatus,
      ),
      [DispatchWorkflowOperations.guildWelcome.discardRpcTag]: makeDiscard(
        DispatchWorkflowOperations.guildWelcome,
      ),
      [DispatchWorkflowOperations.slotOpenButton.discardRpcTag]: makeDiscard(
        DispatchWorkflowOperations.slotOpenButton,
      ),
      [DispatchWorkflowOperations.roomOrderPreviousButton.discardRpcTag]: makeDiscard(
        DispatchWorkflowOperations.roomOrderPreviousButton,
      ),
      [DispatchWorkflowOperations.roomOrderNextButton.discardRpcTag]: makeDiscard(
        DispatchWorkflowOperations.roomOrderNextButton,
      ),
      [DispatchWorkflowOperations.roomOrderSendButton.discardRpcTag]: makeDiscard(
        DispatchWorkflowOperations.roomOrderSendButton,
      ),
      [DispatchWorkflowOperations.roomOrderPinTentativeButton.discardRpcTag]: makeDiscard(
        DispatchWorkflowOperations.roomOrderPinTentativeButton,
      ),
    };

    const client = await Effect.runPromise(
      SheetWorkflowsForwardingClient.make.pipe(
        Effect.provideService(SheetWorkflowsRpcClient, rpcClient as never),
      ),
    );
    const expectDiscarded = <O extends { readonly discardRpcTag: keyof typeof rpcClient }>(
      operation: O,
      payload: unknown,
    ) => {
      expect(rpcClient[operation.discardRpcTag]).toHaveBeenCalledWith(payload);
    };

    const requester = { accountId: "account-1", userId: "user-1" };
    const authorizedRoomOrder = new MessageRoomOrder({
      messageId: "message-1",
      hour: 1,
      previousFills: [],
      fills: [],
      rank: 1,
      tentative: false,
      monitor: Option.none(),
      guildId: Option.some("guild-1"),
      messageChannelId: Option.some("channel-1"),
      createdByUserId: Option.none(),
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
    });
    const checkinPayload = {
      requester,
      payload: { dispatchRequestId: "dispatch-checkin", guildId: "guild-1" },
    };
    await expect(
      Effect.runPromise(
        client.dispatch.checkin(checkinPayload as never) as Effect.Effect<unknown, unknown, never>,
      ),
    ).resolves.toMatchObject({
      executionId: await Effect.runPromise(
        DispatchWorkflowOperations.checkin.workflow.executionId(checkinPayload as never),
      ),
      operation: "checkin",
    });
    expectDiscarded(DispatchWorkflowOperations.checkin, checkinPayload);
    await expect(
      Effect.runPromise(
        client.dispatch.checkinButton({
          requester,
          payload: {
            messageId: "message-1",
            interactionToken: "token-1",
            interactionDeadlineEpochMs: Date.now() + 60_000,
          },
        } as never) as Effect.Effect<unknown, unknown, never>,
      ),
    ).resolves.toMatchObject({ operation: "checkinButton" });
    expectDiscarded(DispatchWorkflowOperations.checkinButton, {
      requester,
      payload: {
        messageId: "message-1",
        interactionToken: "token-1",
        interactionDeadlineEpochMs: expect.any(Number),
      },
    });
    await expect(
      Effect.runPromise(
        client.dispatch.roomOrder({
          requester,
          payload: { dispatchRequestId: "dispatch-room-order", guildId: "guild-1" },
        } as never) as Effect.Effect<unknown, unknown, never>,
      ),
    ).resolves.toMatchObject({ operation: "roomOrder" });
    expectDiscarded(DispatchWorkflowOperations.roomOrder, {
      requester,
      payload: { dispatchRequestId: "dispatch-room-order", guildId: "guild-1" },
    });
    await expect(
      Effect.runPromise(
        client.dispatch.kickout({
          requester,
          payload: { dispatchRequestId: "dispatch-kickout", guildId: "guild-1" },
        } as never) as Effect.Effect<unknown, unknown, never>,
      ),
    ).resolves.toMatchObject({ operation: "kickout" });
    expectDiscarded(DispatchWorkflowOperations.kickout, {
      requester,
      payload: { dispatchRequestId: "dispatch-kickout", guildId: "guild-1" },
    });
    await expect(
      Effect.runPromise(
        client.dispatch.slotButton({
          requester,
          payload: {
            dispatchRequestId: "dispatch-slot-button",
            guildId: "guild-1",
            channelId: "channel-1",
            day: 1,
            interactionToken: "token-1",
            interactionDeadlineEpochMs: Date.now() + 60_000,
          },
        } as never) as Effect.Effect<unknown, unknown, never>,
      ),
    ).resolves.toMatchObject({ operation: "slotButton" });
    expectDiscarded(DispatchWorkflowOperations.slotButton, {
      requester,
      payload: {
        dispatchRequestId: "dispatch-slot-button",
        guildId: "guild-1",
        channelId: "channel-1",
        day: 1,
        interactionToken: "token-1",
        interactionDeadlineEpochMs: expect.any(Number),
      },
    });
    await expect(
      Effect.runPromise(
        client.dispatch.slotList({
          requester,
          payload: {
            dispatchRequestId: "dispatch-slot-list",
            guildId: "guild-1",
            day: 1,
            messageType: "ephemeral",
            interactionToken: "token-1",
            interactionDeadlineEpochMs: Date.now() + 60_000,
          },
        } as never) as Effect.Effect<unknown, unknown, never>,
      ),
    ).resolves.toMatchObject({ operation: "slotList" });
    expectDiscarded(DispatchWorkflowOperations.slotList, {
      requester,
      payload: {
        dispatchRequestId: "dispatch-slot-list",
        guildId: "guild-1",
        day: 1,
        messageType: "ephemeral",
        interactionToken: "token-1",
        interactionDeadlineEpochMs: expect.any(Number),
      },
    });
    await expect(
      Effect.runPromise(
        client.dispatch.slotOpenButton({
          requester,
          payload: {
            messageId: "message-1",
            interactionToken: "token-1",
            interactionDeadlineEpochMs: Date.now() + 60_000,
          },
        } as never) as Effect.Effect<unknown, unknown, never>,
      ),
    ).resolves.toMatchObject({ operation: "slotOpenButton" });
    expectDiscarded(DispatchWorkflowOperations.slotOpenButton, {
      requester,
      payload: {
        messageId: "message-1",
        interactionToken: "token-1",
        interactionDeadlineEpochMs: expect.any(Number),
      },
    });
    await expect(
      Effect.runPromise(
        client.dispatch.serviceStatus({
          requester,
          payload: {
            dispatchRequestId: "dispatch-service-status",
            interactionToken: "token-1",
            interactionDeadlineEpochMs: Date.now() + 60_000,
          },
        } as never) as Effect.Effect<unknown, unknown, never>,
      ),
    ).resolves.toMatchObject({ operation: "serviceStatus" });
    expectDiscarded(DispatchWorkflowOperations.serviceStatus, {
      requester,
      payload: {
        dispatchRequestId: "dispatch-service-status",
        interactionToken: "token-1",
        interactionDeadlineEpochMs: expect.any(Number),
      },
    });
    await expect(
      Effect.runPromise(
        client.dispatch.guildWelcome({
          requester,
          payload: {
            dispatchRequestId: "dispatch-guild-welcome",
            guildId: "guild-1",
            guildName: "Guild One",
            joinedAt: "2026-05-31T00:00:00.000Z",
            systemChannelId: "channel-1",
          },
        } as never) as Effect.Effect<unknown, unknown, never>,
      ),
    ).resolves.toMatchObject({ operation: "guildWelcome" });
    expectDiscarded(DispatchWorkflowOperations.guildWelcome, {
      requester,
      payload: {
        dispatchRequestId: "dispatch-guild-welcome",
        guildId: "guild-1",
        guildName: "Guild One",
        joinedAt: "2026-05-31T00:00:00.000Z",
        systemChannelId: "channel-1",
      },
    });

    for (const method of Object.values(DispatchRoomOrderButtonMethods)) {
      const operation = [
        DispatchWorkflowOperations.roomOrderPreviousButton,
        DispatchWorkflowOperations.roomOrderNextButton,
        DispatchWorkflowOperations.roomOrderSendButton,
        DispatchWorkflowOperations.roomOrderPinTentativeButton,
      ].find((candidate) => candidate.endpointName === method.endpointName);
      expect(operation).toBeDefined();
      expect(client.dispatch).toHaveProperty(method.endpointName);
      const payload = {
        requester,
        payload: {
          guildId: "guild-1",
          messageId: "message-1",
          messageChannelId: "channel-1",
          interactionToken: "token-1",
          interactionDeadlineEpochMs: Date.now() + 60_000,
        },
        authorizedRoomOrder,
      };
      await expect(
        Effect.runPromise(
          client.dispatch[method.endpointName](payload as never) as Effect.Effect<
            unknown,
            unknown,
            never
          >,
        ),
      ).resolves.toMatchObject({
        executionId:
          operation === undefined
            ? undefined
            : await Effect.runPromise(operation.workflow.executionId(payload as never)),
        operation: operation?.operation,
        status: "accepted",
      });
      if (operation !== undefined) {
        expectDiscarded(operation, payload);
      }
    }
  });
});
