// fallow-ignore-file code-duplication
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Context, Effect, HashSet, Option, Redacted } from "effect";
import { Headers } from "effect/unstable/http";
import { SheetAuthUser } from "sheet-ingress-api/internal";
import { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import { DispatchRoomOrderButtonMethods } from "sheet-ingress-api/sheet-apis-rpc";
import { DispatchWorkflowOperations } from "sheet-ingress-api/internal";
import { getIngressRpcHeaders } from "./rpcAuthorizationClient";
import { SheetWorkflowsForwardingClient } from "./sheetWorkflowsForwardingClient";
import { SheetWorkflowsHttpClient } from "./sheetWorkflowsHttpClient";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";

const dispatchClient = { platform: "discord", clientId: "discord-main" } as const;

const makeSheetApisRpcTokens = (): Context.Service.Shape<typeof SheetApisRpcTokens> => ({
  getServiceUser: Effect.fn("test.getServiceUser")(() =>
    Effect.succeed({
      accountId: "service",
      userId: "service",
      permissions: HashSet.fromIterable(["service"]),
      scopes: new Set(["service"]) as never,
      token: Redacted.make("unavailable"),
      tokenType: "service",
    }),
  ),
  getServiceToken: Effect.fn("test.getServiceToken")((resource: string) =>
    Effect.succeed(`${resource}-token`),
  ),
  getDelegatedAuthorization: Effect.fn("test.getDelegatedAuthorization")(({ resource, user }) => {
    void user;
    return Effect.succeed(Redacted.make(`${resource}-delegated-token`));
  }),
  withServiceUser: Effect.fn("test.withServiceUser")(function* (effect) {
    const serviceUser = yield* makeSheetApisRpcTokens().getServiceUser();
    return yield* effect.pipe(Effect.provideService(SheetAuthUser, serviceUser));
  }),
});

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(SheetApisRpcTokens, makeSheetApisRpcTokens()),
    Effect.provideService(SheetAuthUser, {
      accountId: "discord-user-1",
      userId: "user-1",
      permissions: HashSet.empty(),
      scopes: new Set() as never,
      token: Redacted.make("sheet-auth-session-token"),
      tokenType: "session",
    }),
  );

const runWithoutUser = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(SheetApisRpcTokens, makeSheetApisRpcTokens()));

describe("SheetWorkflowsForwardingClient", () => {
  it.effect("builds sheet-workflows ingress headers with a delegated bearer token", () =>
    Effect.gen(function* () {
      const headers = yield* run(getIngressRpcHeaders({ serviceTokenResource: "sheet-workflows" }));

      expect(Option.getOrUndefined(Headers.get(headers, "authorization"))).toBe(
        "Bearer sheet-workflows-delegated-token",
      );
      expect(Option.isNone(Headers.get(headers, "x-sheet-ingress-auth"))).toBe(true);
      expect(Option.isNone(Headers.get(headers, "x-sheet-auth-session-token"))).toBe(true);
      expect(Option.isNone(Headers.get(headers, "x-sheet-auth-token"))).toBe(true);
    }),
  );

  it.effect("builds sheet-bot ingress headers with a service bearer token", () =>
    Effect.gen(function* () {
      const headers = yield* runWithoutUser(
        getIngressRpcHeaders({ serviceTokenResource: "sheet-bot" }),
      );

      expect(Option.getOrUndefined(Headers.get(headers, "authorization"))).toBe(
        "Bearer sheet-bot-token",
      );
      expect(Option.isNone(Headers.get(headers, "x-sheet-ingress-auth"))).toBe(true);
    }),
  );

  it.effect("keeps split room-order forwarding methods aligned with shared button metadata", () =>
    Effect.gen(function* () {
      const makeDispatch = (operation: {
        readonly workflow: { executionId: (payload: never) => Effect.Effect<string> };
      }) =>
        vi.fn((request: { readonly payload: never }) =>
          operation.workflow.executionId(request.payload),
        );
      const dispatchWorkflows = {
        [DispatchWorkflowOperations.autoCheckinTest.rpcTag]: makeDispatch(
          DispatchWorkflowOperations.autoCheckinTest,
        ),
        [DispatchWorkflowOperations.checkin.rpcTag]: makeDispatch(
          DispatchWorkflowOperations.checkin,
        ),
        [DispatchWorkflowOperations.checkinButton.rpcTag]: makeDispatch(
          DispatchWorkflowOperations.checkinButton,
        ),
        [DispatchWorkflowOperations.roomOrder.rpcTag]: makeDispatch(
          DispatchWorkflowOperations.roomOrder,
        ),
        [DispatchWorkflowOperations.kickout.rpcTag]: makeDispatch(
          DispatchWorkflowOperations.kickout,
        ),
        [DispatchWorkflowOperations.slotButton.rpcTag]: makeDispatch(
          DispatchWorkflowOperations.slotButton,
        ),
        [DispatchWorkflowOperations.slotList.rpcTag]: makeDispatch(
          DispatchWorkflowOperations.slotList,
        ),
        [DispatchWorkflowOperations.serviceStatus.rpcTag]: makeDispatch(
          DispatchWorkflowOperations.serviceStatus,
        ),
        [DispatchWorkflowOperations.workspaceWelcome.rpcTag]: makeDispatch(
          DispatchWorkflowOperations.workspaceWelcome,
        ),
        [DispatchWorkflowOperations.serviceAddWorkspaceFeatureFlag.rpcTag]: makeDispatch(
          DispatchWorkflowOperations.serviceAddWorkspaceFeatureFlag,
        ),
        [DispatchWorkflowOperations.serviceRemoveWorkspaceFeatureFlag.rpcTag]: makeDispatch(
          DispatchWorkflowOperations.serviceRemoveWorkspaceFeatureFlag,
        ),
        [DispatchWorkflowOperations.slotOpenButton.rpcTag]: makeDispatch(
          DispatchWorkflowOperations.slotOpenButton,
        ),
        [DispatchWorkflowOperations.roomOrderPreviousButton.rpcTag]: makeDispatch(
          DispatchWorkflowOperations.roomOrderPreviousButton,
        ),
        [DispatchWorkflowOperations.roomOrderNextButton.rpcTag]: makeDispatch(
          DispatchWorkflowOperations.roomOrderNextButton,
        ),
        [DispatchWorkflowOperations.roomOrderSendButton.rpcTag]: makeDispatch(
          DispatchWorkflowOperations.roomOrderSendButton,
        ),
        [DispatchWorkflowOperations.roomOrderPinTentativeButton.rpcTag]: makeDispatch(
          DispatchWorkflowOperations.roomOrderPinTentativeButton,
        ),
      };
      const httpClient = { dispatchWorkflows };

      const client = yield* SheetWorkflowsForwardingClient.make.pipe(
        Effect.provideService(SheetWorkflowsHttpClient, httpClient as never),
      );
      const expectDispatchResult = (
        effect: Effect.Effect<unknown, unknown, never>,
        expected: object,
      ) =>
        Effect.gen(function* () {
          const result = yield* effect;
          expect(result).toMatchObject(expected);
        });
      const expectDispatched = <O extends { readonly rpcTag: keyof typeof dispatchWorkflows }>(
        operation: O,
        payload: unknown,
      ) => {
        expect(dispatchWorkflows[operation.rpcTag]).toHaveBeenCalledWith({ payload });
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
      yield* expectDispatchResult(
        client.dispatch.autoCheckinTest(autoCheckinTestPayload as never) as Effect.Effect<
          unknown,
          unknown,
          never
        >,
        {
          executionId: yield* DispatchWorkflowOperations.autoCheckinTest.workflow.executionId(
            autoCheckinTestPayload as never,
          ),
          operation: "autoCheckinTest",
        },
      );
      expectDispatched(DispatchWorkflowOperations.autoCheckinTest, {
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
      yield* expectDispatchResult(
        client.dispatch.checkin(checkinPayload as never) as Effect.Effect<unknown, unknown, never>,
        {
          executionId: yield* DispatchWorkflowOperations.checkin.workflow.executionId(
            checkinPayload as never,
          ),
          operation: "checkin",
        },
      );
      expectDispatched(DispatchWorkflowOperations.checkin, checkinPayload);
      yield* expectDispatchResult(
        client.dispatch.checkinButton({
          requester,
          payload: {
            client: dispatchClient,
            messageId: "message-1",
            interactionResponseToken: "token-1",
            interactionResponseDeadlineEpochMs: Date.now() + 60_000,
          },
        } as never) as Effect.Effect<unknown, unknown, never>,
        { operation: "checkinButton" },
      );
      expectDispatched(DispatchWorkflowOperations.checkinButton, {
        requester,
        payload: {
          client: dispatchClient,
          messageId: "message-1",
          interactionResponseToken: "token-1",
          interactionResponseDeadlineEpochMs: expect.any(Number),
        },
      });
      yield* expectDispatchResult(
        client.dispatch.roomOrder({
          requester,
          payload: {
            client: dispatchClient,
            dispatchRequestId: "dispatch-room-order",
            workspaceId: "workspace-1",
          },
        } as never) as Effect.Effect<unknown, unknown, never>,
        { operation: "roomOrder" },
      );
      expectDispatched(DispatchWorkflowOperations.roomOrder, {
        requester,
        payload: {
          client: dispatchClient,
          dispatchRequestId: "dispatch-room-order",
          workspaceId: "workspace-1",
        },
      });
      yield* expectDispatchResult(
        client.dispatch.kickout({
          requester,
          payload: {
            client: dispatchClient,
            dispatchRequestId: "dispatch-kickout",
            workspaceId: "workspace-1",
          },
        } as never) as Effect.Effect<unknown, unknown, never>,
        { operation: "kickout" },
      );
      expectDispatched(DispatchWorkflowOperations.kickout, {
        requester,
        payload: {
          client: dispatchClient,
          dispatchRequestId: "dispatch-kickout",
          workspaceId: "workspace-1",
        },
      });
      yield* expectDispatchResult(
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
        { operation: "slotButton" },
      );
      expectDispatched(DispatchWorkflowOperations.slotButton, {
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
      yield* expectDispatchResult(
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
        { operation: "slotList" },
      );
      expectDispatched(DispatchWorkflowOperations.slotList, {
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
      yield* expectDispatchResult(
        client.dispatch.slotOpenButton({
          requester,
          payload: {
            client: dispatchClient,
            messageId: "message-1",
            interactionResponseToken: "token-1",
            interactionResponseDeadlineEpochMs: Date.now() + 60_000,
          },
        } as never) as Effect.Effect<unknown, unknown, never>,
        { operation: "slotOpenButton" },
      );
      expectDispatched(DispatchWorkflowOperations.slotOpenButton, {
        requester,
        payload: {
          client: dispatchClient,
          messageId: "message-1",
          interactionResponseToken: "token-1",
          interactionResponseDeadlineEpochMs: expect.any(Number),
        },
      });
      yield* expectDispatchResult(
        client.dispatch.serviceStatus({
          requester,
          payload: {
            client: dispatchClient,
            dispatchRequestId: "dispatch-service-status",
            interactionResponseToken: "token-1",
            interactionResponseDeadlineEpochMs: Date.now() + 60_000,
          },
        } as never) as Effect.Effect<unknown, unknown, never>,
        { operation: "serviceStatus" },
      );
      expectDispatched(DispatchWorkflowOperations.serviceStatus, {
        requester,
        payload: {
          client: dispatchClient,
          dispatchRequestId: "dispatch-service-status",
          interactionResponseToken: "token-1",
          interactionResponseDeadlineEpochMs: expect.any(Number),
        },
      });
      yield* expectDispatchResult(
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
        { operation: "workspaceWelcome" },
      );
      expectDispatched(DispatchWorkflowOperations.workspaceWelcome, {
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
      yield* expectDispatchResult(
        client.dispatch.serviceAddWorkspaceFeatureFlag(
          serviceFeatureFlagPayload as never,
        ) as Effect.Effect<unknown, unknown, never>,
        { operation: "serviceAddWorkspaceFeatureFlag" },
      );
      yield* expectDispatchResult(
        client.dispatch.serviceRemoveWorkspaceFeatureFlag(
          serviceFeatureFlagPayload as never,
        ) as Effect.Effect<unknown, unknown, never>,
        { operation: "serviceRemoveWorkspaceFeatureFlag" },
      );
      expectDispatched(
        DispatchWorkflowOperations.serviceAddWorkspaceFeatureFlag,
        serviceFeatureFlagPayload,
      );
      expectDispatched(
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
        yield* expectDispatchResult(
          client.dispatch[method.endpointName](payload as never) as Effect.Effect<
            unknown,
            unknown,
            never
          >,
          {
            executionId:
              operation === undefined
                ? undefined
                : yield* operation.workflow.executionId(payload as never),
            operation: operation?.operation,
            status: "accepted",
          },
        );
        if (operation !== undefined) {
          expectDispatched(operation, payload);
        }
      }
    }),
  );
});
