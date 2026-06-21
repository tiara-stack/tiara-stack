// fallow-ignore-file code-duplication
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
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

const dispatchClient = { platform: "discord", clientId: "discord-main" } as const;

const makeSheetApisRpcTokens = () =>
  ({
    getServiceToken: (resource: string) => Effect.succeed(`${resource}-token`),
  }) as never;

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(SheetApisRpcTokens, makeSheetApisRpcTokens()),
      Effect.provideService(SheetAuthUser, {
        accountId: "discord-user-1",
        userId: "user-1",
        permissions: HashSet.empty(),
        scopes: new Set() as never,
        token: Redacted.make("sheet-auth-session-token"),
      }),
    ) as Effect.Effect<A, E, never>,
  );

describe("SheetWorkflowsForwardingClient", () => {
  it("builds sheet-workflows ingress headers with sheet-auth session token but no Discord access token", async () => {
    const headers = await run(getIngressRpcHeaders({ serviceTokenResource: "sheet-workflows" }));

    expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-ingress-auth"))).toBe(
      "Bearer sheet-workflows-token",
    );
    expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-user-id"))).toBe("user-1");
    expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-account-id"))).toBe(
      "discord-user-1",
    );
    expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-session-token"))).toBe(
      "Bearer sheet-auth-session-token",
    );
    expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-token"))).toBe(
      "Bearer sheet-auth-session-token",
    );
    expect(Option.isNone(Headers.get(headers, "x-sheet-discord-access-token"))).toBe(true);
  });

  it("builds sheet-bot ingress headers with the sheet-bot service token and shared auth context", async () => {
    const headers = await run(getIngressRpcHeaders({ serviceTokenResource: "sheet-bot" }));

    expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-ingress-auth"))).toBe(
      "Bearer sheet-bot-token",
    );
    expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-user-id"))).toBe("user-1");
    expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-account-id"))).toBe(
      "discord-user-1",
    );
    expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-session-token"))).toBe(
      "Bearer sheet-auth-session-token",
    );
    expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-token"))).toBe(
      "Bearer sheet-auth-session-token",
    );
  });

  it("keeps split room-order forwarding methods aligned with shared button metadata", async () => {
    const makeDiscard = (operation: {
      readonly workflow: { executionId: (payload: never) => Effect.Effect<string> };
    }) => vi.fn((payload) => operation.workflow.executionId(payload as never));
    const rpcClient = {
      [DispatchWorkflowOperations.autoCheckinTest.discardRpcTag]: makeDiscard(
        DispatchWorkflowOperations.autoCheckinTest,
      ),
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
      [DispatchWorkflowOperations.workspaceWelcome.discardRpcTag]: makeDiscard(
        DispatchWorkflowOperations.workspaceWelcome,
      ),
      [DispatchWorkflowOperations.serviceAddWorkspaceFeatureFlag.discardRpcTag]: makeDiscard(
        DispatchWorkflowOperations.serviceAddWorkspaceFeatureFlag,
      ),
      [DispatchWorkflowOperations.serviceRemoveWorkspaceFeatureFlag.discardRpcTag]: makeDiscard(
        DispatchWorkflowOperations.serviceRemoveWorkspaceFeatureFlag,
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
      clientPlatform: "discord",
      clientId: "discord-main",
      messageId: "message-1",
      hour: 1,
      previousFills: [],
      fills: [],
      rank: 1,
      tentative: false,
      monitor: Option.none(),
      workspaceId: Option.some("workspace-1"),
      conversationId: Option.some("conversation-1"),
      createdByUserId: Option.none(),
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
    });
    const checkinPayload = {
      requester,
      payload: {
        client: dispatchClient,
        dispatchRequestId: "dispatch-checkin",
        workspaceId: "workspace-1",
      },
    };
    const autoCheckinTestPayload = {
      requester,
      payload: {
        client: dispatchClient,
        dispatchRequestId: "dispatch-auto-checkin-test",
        workspaceId: "workspace-1",
        anchorConversationId: "conversation-1",
        interactionResponseToken: "token-1",
        interactionResponseDeadlineEpochMs: Date.now() + 60_000,
      },
    };
    await expect(
      Effect.runPromise(
        client.dispatch.autoCheckinTest(autoCheckinTestPayload as never) as Effect.Effect<
          unknown,
          unknown,
          never
        >,
      ),
    ).resolves.toMatchObject({
      executionId: await Effect.runPromise(
        DispatchWorkflowOperations.autoCheckinTest.workflow.executionId(
          autoCheckinTestPayload as never,
        ),
      ),
      operation: "autoCheckinTest",
    });
    expectDiscarded(DispatchWorkflowOperations.autoCheckinTest, {
      requester,
      payload: {
        client: dispatchClient,
        dispatchRequestId: "dispatch-auto-checkin-test",
        workspaceId: "workspace-1",
        anchorConversationId: "conversation-1",
        interactionResponseToken: "token-1",
        interactionResponseDeadlineEpochMs: expect.any(Number),
      },
    });
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
            client: dispatchClient,
            messageId: "message-1",
            interactionResponseToken: "token-1",
            interactionResponseDeadlineEpochMs: Date.now() + 60_000,
          },
        } as never) as Effect.Effect<unknown, unknown, never>,
      ),
    ).resolves.toMatchObject({ operation: "checkinButton" });
    expectDiscarded(DispatchWorkflowOperations.checkinButton, {
      requester,
      payload: {
        client: dispatchClient,
        messageId: "message-1",
        interactionResponseToken: "token-1",
        interactionResponseDeadlineEpochMs: expect.any(Number),
      },
    });
    await expect(
      Effect.runPromise(
        client.dispatch.roomOrder({
          requester,
          payload: {
            client: dispatchClient,
            dispatchRequestId: "dispatch-room-order",
            workspaceId: "workspace-1",
          },
        } as never) as Effect.Effect<unknown, unknown, never>,
      ),
    ).resolves.toMatchObject({ operation: "roomOrder" });
    expectDiscarded(DispatchWorkflowOperations.roomOrder, {
      requester,
      payload: {
        client: dispatchClient,
        dispatchRequestId: "dispatch-room-order",
        workspaceId: "workspace-1",
      },
    });
    await expect(
      Effect.runPromise(
        client.dispatch.kickout({
          requester,
          payload: {
            client: dispatchClient,
            dispatchRequestId: "dispatch-kickout",
            workspaceId: "workspace-1",
          },
        } as never) as Effect.Effect<unknown, unknown, never>,
      ),
    ).resolves.toMatchObject({ operation: "kickout" });
    expectDiscarded(DispatchWorkflowOperations.kickout, {
      requester,
      payload: {
        client: dispatchClient,
        dispatchRequestId: "dispatch-kickout",
        workspaceId: "workspace-1",
      },
    });
    await expect(
      Effect.runPromise(
        client.dispatch.slotButton({
          requester,
          payload: {
            client: dispatchClient,
            dispatchRequestId: "dispatch-slot-button",
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            day: 1,
            interactionResponseToken: "token-1",
            interactionResponseDeadlineEpochMs: Date.now() + 60_000,
          },
        } as never) as Effect.Effect<unknown, unknown, never>,
      ),
    ).resolves.toMatchObject({ operation: "slotButton" });
    expectDiscarded(DispatchWorkflowOperations.slotButton, {
      requester,
      payload: {
        client: dispatchClient,
        dispatchRequestId: "dispatch-slot-button",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        day: 1,
        interactionResponseToken: "token-1",
        interactionResponseDeadlineEpochMs: expect.any(Number),
      },
    });
    await expect(
      Effect.runPromise(
        client.dispatch.slotList({
          requester,
          payload: {
            client: dispatchClient,
            dispatchRequestId: "dispatch-slot-list",
            workspaceId: "workspace-1",
            day: 1,
            messageType: "ephemeral",
            interactionResponseToken: "token-1",
            interactionResponseDeadlineEpochMs: Date.now() + 60_000,
          },
        } as never) as Effect.Effect<unknown, unknown, never>,
      ),
    ).resolves.toMatchObject({ operation: "slotList" });
    expectDiscarded(DispatchWorkflowOperations.slotList, {
      requester,
      payload: {
        client: dispatchClient,
        dispatchRequestId: "dispatch-slot-list",
        workspaceId: "workspace-1",
        day: 1,
        messageType: "ephemeral",
        interactionResponseToken: "token-1",
        interactionResponseDeadlineEpochMs: expect.any(Number),
      },
    });
    await expect(
      Effect.runPromise(
        client.dispatch.slotOpenButton({
          requester,
          payload: {
            client: dispatchClient,
            messageId: "message-1",
            interactionResponseToken: "token-1",
            interactionResponseDeadlineEpochMs: Date.now() + 60_000,
          },
        } as never) as Effect.Effect<unknown, unknown, never>,
      ),
    ).resolves.toMatchObject({ operation: "slotOpenButton" });
    expectDiscarded(DispatchWorkflowOperations.slotOpenButton, {
      requester,
      payload: {
        client: dispatchClient,
        messageId: "message-1",
        interactionResponseToken: "token-1",
        interactionResponseDeadlineEpochMs: expect.any(Number),
      },
    });
    await expect(
      Effect.runPromise(
        client.dispatch.serviceStatus({
          requester,
          payload: {
            client: dispatchClient,
            dispatchRequestId: "dispatch-service-status",
            interactionResponseToken: "token-1",
            interactionResponseDeadlineEpochMs: Date.now() + 60_000,
          },
        } as never) as Effect.Effect<unknown, unknown, never>,
      ),
    ).resolves.toMatchObject({ operation: "serviceStatus" });
    expectDiscarded(DispatchWorkflowOperations.serviceStatus, {
      requester,
      payload: {
        client: dispatchClient,
        dispatchRequestId: "dispatch-service-status",
        interactionResponseToken: "token-1",
        interactionResponseDeadlineEpochMs: expect.any(Number),
      },
    });
    await expect(
      Effect.runPromise(
        client.dispatch.workspaceWelcome({
          requester,
          payload: {
            client: dispatchClient,
            dispatchRequestId: "dispatch-workspace-welcome",
            workspaceId: "workspace-1",
            workspaceName: "Workspace One",
            joinedAt: "2026-05-31T00:00:00.000Z",
            systemConversationId: "conversation-1",
          },
        } as never) as Effect.Effect<unknown, unknown, never>,
      ),
    ).resolves.toMatchObject({ operation: "workspaceWelcome" });
    expectDiscarded(DispatchWorkflowOperations.workspaceWelcome, {
      requester,
      payload: {
        client: dispatchClient,
        dispatchRequestId: "dispatch-workspace-welcome",
        workspaceId: "workspace-1",
        workspaceName: "Workspace One",
        joinedAt: "2026-05-31T00:00:00.000Z",
        systemConversationId: "conversation-1",
      },
    });

    const serviceFeatureFlagPayload = {
      requester,
      payload: {
        client: dispatchClient,
        dispatchRequestId: "dispatch-service-workspace-feature-flag",
        workspaceId: "workspace-1",
        flagName: "beta-feature",
        systemConversationId: "conversation-1",
      },
    };
    await expect(
      Effect.runPromise(
        client.dispatch.serviceAddWorkspaceFeatureFlag(
          serviceFeatureFlagPayload as never,
        ) as Effect.Effect<unknown, unknown, never>,
      ),
    ).resolves.toMatchObject({ operation: "serviceAddWorkspaceFeatureFlag" });
    await expect(
      Effect.runPromise(
        client.dispatch.serviceRemoveWorkspaceFeatureFlag(
          serviceFeatureFlagPayload as never,
        ) as Effect.Effect<unknown, unknown, never>,
      ),
    ).resolves.toMatchObject({ operation: "serviceRemoveWorkspaceFeatureFlag" });
    expectDiscarded(
      DispatchWorkflowOperations.serviceAddWorkspaceFeatureFlag,
      serviceFeatureFlagPayload,
    );
    expectDiscarded(
      DispatchWorkflowOperations.serviceRemoveWorkspaceFeatureFlag,
      serviceFeatureFlagPayload,
    );

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
          client: dispatchClient,
          workspaceId: "workspace-1",
          messageId: "message-1",
          messageConversationId: "conversation-1",
          interactionResponseToken: "token-1",
          interactionResponseDeadlineEpochMs: Date.now() + 60_000,
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
