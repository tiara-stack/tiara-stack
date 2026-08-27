import { expect, it } from "@effect/vitest";
import { Duration, Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { makeTrustedSheetPersistenceMock } from "./testHelpers";

const messageKey = {
  clientPlatform: "discord",
  clientId: "discord-main",
  messageId: "message-1",
} as const;

const roomOrderData = {
  previousFills: [],
  fills: ["fill-1"],
  hour: 12,
  rank: 0,
  tentative: false,
  monitor: null,
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  createdByUserId: "user-1",
} as const;

const bindRoomOrder = (persistence: ReturnType<typeof makeTrustedSheetPersistenceMock>) =>
  persistence.roomOrderState.bindMessageRoomOrderIfAbsent({
    ...messageKey,
    data: roomOrderData,
    entries: [],
  });

const getRoomOrder = (persistence: ReturnType<typeof makeTrustedSheetPersistenceMock>) =>
  persistence.roomOrderState.getMessageRoomOrder(messageKey).pipe(Effect.map(Option.getOrThrow));

it.effect("preserves createdAt while refreshing audit fields for named upserts", () =>
  Effect.gen(function* () {
    const persistence = makeTrustedSheetPersistenceMock();
    yield* TestClock.setTime(1_000);

    yield* persistence.workspaces.upsertWorkspaceConfig({
      workspaceId: "workspace-1",
      sheetId: "sheet-1",
    });
    yield* persistence.workspaces.upsertWorkspaceConversationConfig({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      name: "Running",
      running: true,
    });
    yield* persistence.workspaces.upsertTeamSubmissionChannel({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      destinationTeamConfigName: "default",
      writeMode: "upsert",
      removedRowStrategy: "blank",
      requireValidOshi: false,
    });
    yield* persistence.preferences.upsertUserPlatformConfig({
      platform: "discord",
      userId: "user-1",
      checkinDmEnabled: false,
      monitorDmEnabled: false,
      defaultClientId: "discord-main",
    });
    yield* persistence.slotState.upsertMessageSlotData({
      ...messageKey,
      day: 1,
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      createdByUserId: "user-1",
    });

    yield* TestClock.adjust(Duration.seconds(1));
    yield* persistence.workspaces.upsertWorkspaceConfig({
      workspaceId: "workspace-1",
      sheetId: "sheet-2",
    });
    yield* persistence.workspaces.upsertWorkspaceConversationConfig({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      name: "Updated",
    });
    yield* persistence.workspaces.upsertTeamSubmissionChannel({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      destinationTeamConfigName: "updated",
      writeMode: "upsert",
      removedRowStrategy: "blank",
      requireValidOshi: true,
    });
    yield* persistence.preferences.upsertUserPlatformConfig({
      platform: "discord",
      userId: "user-1",
      checkinDmEnabled: true,
    });
    yield* persistence.slotState.upsertMessageSlotData({
      ...messageKey,
      day: 2,
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      createdByUserId: "user-1",
    });

    const workspace = Option.getOrThrow(
      yield* persistence.workspaces.getWorkspaceConfigByWorkspaceId({
        workspaceId: "workspace-1",
      }),
    );
    const conversation = Option.getOrThrow(
      yield* persistence.workspaces.getWorkspaceConversationById({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
      }),
    );
    const channel = Option.getOrThrow(
      yield* persistence.workspaces.getTeamSubmissionChannelByConversationId({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
      }),
    );
    const user = Option.getOrThrow(
      yield* persistence.preferences.getUserPlatformConfig({
        platform: "discord",
        userId: "user-1",
      }),
    );
    const slot = Option.getOrThrow(yield* persistence.slotState.getMessageSlotData(messageKey));

    for (const row of [workspace, conversation, channel, user, slot]) {
      expect(row.createdAt).toBe(1_000);
      expect(row.updatedAt).toBe(2_000);
    }
    expect(workspace.sheetId).toBe("sheet-2");
    expect(conversation.name).toBe("Updated");
    expect(channel.destinationTeamConfigName).toBe("updated");
    expect(user.checkinDmEnabled).toBe(true);
    expect(slot.day).toBe(2);
  }),
);

it.effect("keeps blocked room-order claims intact during rereads", () =>
  Effect.gen(function* () {
    const completedSend = makeTrustedSheetPersistenceMock();
    yield* TestClock.setTime(1_000);
    yield* bindRoomOrder(completedSend);
    yield* completedSend.roomOrderState.claimMessageRoomOrderSend({
      ...messageKey,
      claimId: "send-1",
    });
    yield* completedSend.roomOrderState.completeMessageRoomOrderSend({
      ...messageKey,
      claimId: "send-1",
      sentMessageId: "sent-1",
      sentConversationId: "conversation-1",
      sentAt: 1_000,
    });
    yield* completedSend.roomOrderState.claimMessageRoomOrderSend({
      ...messageKey,
      claimId: "send-2",
    });
    expect(yield* getRoomOrder(completedSend)).toMatchObject({
      sendClaimId: null,
      sentMessageId: "sent-1",
    });

    const activeSend = makeTrustedSheetPersistenceMock();
    yield* bindRoomOrder(activeSend);
    yield* activeSend.roomOrderState.claimMessageRoomOrderSend({
      ...messageKey,
      claimId: "send-active",
    });
    yield* activeSend.roomOrderState.claimMessageRoomOrderTentativeUpdate({
      ...messageKey,
      claimId: "update-blocked-by-send",
    });
    expect(yield* getRoomOrder(activeSend)).toMatchObject({
      sendClaimId: "send-active",
      tentativeUpdateClaimId: null,
    });

    const activeTentativeUpdate = makeTrustedSheetPersistenceMock();
    yield* bindRoomOrder(activeTentativeUpdate);
    yield* activeTentativeUpdate.roomOrderState.claimMessageRoomOrderTentativeUpdate({
      ...messageKey,
      claimId: "update-1",
    });
    yield* activeTentativeUpdate.roomOrderState.claimMessageRoomOrderTentativePin({
      ...messageKey,
      claimId: "pin-blocked-by-update",
    });
    expect(yield* getRoomOrder(activeTentativeUpdate)).toMatchObject({
      tentativeUpdateClaimId: "update-1",
      tentativePinClaimId: null,
    });

    const staleSend = makeTrustedSheetPersistenceMock();
    yield* bindRoomOrder(staleSend);
    yield* staleSend.roomOrderState.claimMessageRoomOrderSend({
      ...messageKey,
      claimId: "send-stale",
    });
    yield* TestClock.adjust(Duration.minutes(11));
    yield* staleSend.roomOrderState.claimMessageRoomOrderTentativePin({
      ...messageKey,
      claimId: "pin-blocked-by-stale-send",
    });
    expect(yield* getRoomOrder(staleSend)).toMatchObject({
      sendClaimId: "send-stale",
      tentativePinClaimId: null,
    });
  }),
);
