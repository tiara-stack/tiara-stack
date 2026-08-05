import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  ConfigUserPlatformRow,
  ConfigWorkspaceConversationRow,
  ConfigWorkspaceFeatureFlagRow,
  ConfigWorkspaceMonitorRoleRow,
  ConfigWorkspaceRow,
  ConfigWorkspaceTeamSubmissionChannelRow,
  ConfigWorkspaceUpdateAnnouncementDeliveryRow,
  MessageCheckinMemberRow,
  MessageCheckinRow,
  MessageRoomOrderEntryRow,
  MessageRoomOrderRow,
  MessageSlotRow,
  MessageTeamSubmissionRow,
} from "sheet-zero-api/rows";
import {
  configUserPlatform,
  configWorkspace,
  configWorkspaceConversation,
  configWorkspaceFeatureFlag,
  configWorkspaceMonitorRole,
  configWorkspaceTeamSubmissionChannel,
  configWorkspaceUpdateAnnouncementDelivery,
  messageCheckin,
  messageCheckinMember,
  messageRoomOrder,
  messageRoomOrderEntry,
  messageSlot,
  messageTeamSubmission,
} from "./models";

type StructCodec = Schema.Top & {
  readonly fields: Readonly<Record<string, Schema.Top>>;
};

type RowParityCase = {
  readonly name: string;
  readonly replicated: StructCodec;
  readonly persistence: StructCodec;
  readonly value: Readonly<Record<string, unknown>>;
};

const audit = {
  createdAt: Date.UTC(2026, 0, 1),
  updatedAt: Date.UTC(2026, 0, 2),
  deletedAt: null,
} as const;

const messageKey = {
  clientPlatform: "discord",
  clientId: "client-1",
  messageId: "message-1",
} as const;

const cases = [
  {
    name: "configWorkspace",
    replicated: ConfigWorkspaceRow,
    persistence: configWorkspace.json,
    value: {
      workspaceId: "workspace-1",
      sheetId: null,
      autoCheckin: true,
      monitorConversationId: null,
      ...audit,
    },
  },
  {
    name: "configWorkspaceMonitorRole",
    replicated: ConfigWorkspaceMonitorRoleRow,
    persistence: configWorkspaceMonitorRole.json,
    value: { workspaceId: "workspace-1", roleId: "role-1", ...audit },
  },
  {
    name: "configWorkspaceFeatureFlag",
    replicated: ConfigWorkspaceFeatureFlagRow,
    persistence: configWorkspaceFeatureFlag.json,
    value: { workspaceId: "workspace-1", flagName: "feature-1", ...audit },
  },
  {
    name: "configWorkspaceUpdateAnnouncementDelivery",
    replicated: ConfigWorkspaceUpdateAnnouncementDeliveryRow,
    persistence: configWorkspaceUpdateAnnouncementDelivery.json,
    value: {
      workspaceId: "workspace-1",
      announcementId: "announcement-1",
      publishedAt: Date.UTC(2026, 0, 3),
      deliveredAt: Date.UTC(2026, 0, 4),
      conversationId: "conversation-1",
      messageId: "message-1",
      ...audit,
    },
  },
  {
    name: "configUserPlatform",
    replicated: ConfigUserPlatformRow,
    persistence: configUserPlatform.json,
    value: {
      platform: "discord",
      userId: "user-1",
      defaultClientId: null,
      checkinDmEnabled: true,
      monitorDmEnabled: false,
      ...audit,
    },
  },
  {
    name: "configWorkspaceConversation",
    replicated: ConfigWorkspaceConversationRow,
    persistence: configWorkspaceConversation.json,
    value: {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      name: null,
      running: true,
      roleId: null,
      checkinConversationId: null,
      ...audit,
    },
  },
  {
    name: "configWorkspaceTeamSubmissionChannel",
    replicated: ConfigWorkspaceTeamSubmissionChannelRow,
    persistence: configWorkspaceTeamSubmissionChannel.json,
    value: {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      destinationTeamConfigName: null,
      writeMode: "upsert",
      removedRowStrategy: "blank",
      requireValidOshi: true,
      ...audit,
    },
  },
  {
    name: "messageSlot",
    replicated: MessageSlotRow,
    persistence: messageSlot.json,
    value: {
      ...messageKey,
      day: 2,
      workspaceId: null,
      conversationId: null,
      createdByUserId: null,
      ...audit,
    },
  },
  {
    name: "messageCheckin",
    replicated: MessageCheckinRow,
    persistence: messageCheckin.json,
    value: {
      ...messageKey,
      initialMessage: [{ content: "hello" }],
      hour: 12,
      runningConversationId: "running-1",
      roleId: null,
      workspaceId: null,
      conversationId: null,
      createdByUserId: null,
      ...audit,
    },
  },
  {
    name: "messageCheckinMember",
    replicated: MessageCheckinMemberRow,
    persistence: messageCheckinMember.json,
    value: {
      ...messageKey,
      memberId: "member-1",
      checkinAt: null,
      checkinClaimId: null,
      ...audit,
    },
  },
  {
    name: "messageRoomOrder",
    replicated: MessageRoomOrderRow,
    persistence: messageRoomOrder.json,
    value: {
      ...messageKey,
      previousFills: ["one"],
      fills: ["two"],
      hour: 12,
      rank: 3,
      tentative: false,
      monitor: null,
      workspaceId: null,
      conversationId: null,
      createdByUserId: null,
      sendClaimId: null,
      sendClaimedAt: null,
      sentMessageId: null,
      sentConversationId: null,
      sentAt: null,
      tentativeUpdateClaimId: null,
      tentativeUpdateClaimedAt: null,
      tentativePinClaimId: null,
      tentativePinClaimedAt: null,
      tentativePinnedAt: null,
      ...audit,
    },
  },
  {
    name: "messageRoomOrderEntry",
    replicated: MessageRoomOrderEntryRow,
    persistence: messageRoomOrderEntry.json,
    value: {
      ...messageKey,
      rank: 3,
      position: 1,
      hour: 12,
      team: "team-1",
      tags: ["tag-1"],
      effectValue: 1.5,
      ...audit,
    },
  },
  {
    name: "messageTeamSubmission",
    replicated: MessageTeamSubmissionRow,
    persistence: messageTeamSubmission.json,
    value: {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      clientPlatform: "discord",
      clientId: "client-1",
      discordGuildId: "guild-1",
      discordChannelId: "channel-1",
      discordAuthorId: "author-1",
      sheetId: "sheet-1",
      confirmationMessageId: null,
      parsedSubmission: { teams: ["team-1"] },
      rowMappings: [{ row: 1 }],
      rollbackSnapshot: null,
      version: 1,
      status: "registered",
      ...audit,
    },
  },
] as const satisfies ReadonlyArray<RowParityCase>;

describe("replicated row codec parity", () => {
  for (const testCase of cases) {
    it(`matches persistence JSON semantics for ${testCase.name}`, () => {
      expect(Object.keys(testCase.replicated.fields)).toEqual(
        Object.keys(testCase.persistence.fields),
      );

      const replicatedDecoded = Schema.decodeUnknownSync(testCase.replicated)(testCase.value);
      const persistenceDecoded = Schema.decodeUnknownSync(testCase.persistence)(testCase.value);
      expect(replicatedDecoded).toEqual(persistenceDecoded);
      expect(replicatedDecoded).toEqual(testCase.value);

      expect(Schema.encodeUnknownSync(testCase.replicated)(replicatedDecoded)).toEqual(
        Schema.encodeUnknownSync(testCase.persistence)(persistenceDecoded),
      );
    });
  }
});
