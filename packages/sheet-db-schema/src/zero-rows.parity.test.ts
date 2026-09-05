import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  AuditSheetConfigurationRow,
  ConfigWorkspaceCheckinMessageMutationReceiptRow,
  ConfigWorkspaceCheckinMessageRow,
  ConfigWorkspaceCheckinMessageSetRow,
  ConfigUserPlatformRow,
  ConfigWorkspaceConversationRow,
  ConfigWorkspaceFeatureFlagRow,
  ConfigWorkspaceMonitorRoleRow,
  ConfigWorkspaceRow,
  ConfigWorkspaceSheetImportAttemptRow,
  ConfigWorkspaceSheetRevisionRow,
  ConfigWorkspaceSheetRow,
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
  auditSheetConfiguration,
  configWorkspaceCheckinMessage,
  configWorkspaceCheckinMessageMutationReceipt,
  configWorkspaceCheckinMessageSet,
  configUserPlatform,
  configWorkspace,
  configWorkspaceSheet,
  configWorkspaceSheetImportAttempt,
  configWorkspaceSheetRevision,
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
    name: "configWorkspaceSheet",
    replicated: ConfigWorkspaceSheetRow,
    persistence: configWorkspaceSheet.json,
    value: {
      workspaceId: "workspace-1",
      source: { kind: "legacy", binding: { status: "unresolved", expectedTitle: "Users" } },
      legacyBinding: null,
      draftVersion: 0,
      baseRevisionId: null,
      baselineDigest: null,
      draft: null,
      diagnostics: [],
      activeRevisionId: null,
      updatedBy: null,
      ...audit,
    },
  },
  {
    name: "configWorkspaceSheetRevision",
    replicated: ConfigWorkspaceSheetRevisionRow,
    persistence: configWorkspaceSheetRevision.json,
    value: {
      workspaceId: "workspace-1",
      revisionId: "revision-1",
      spreadsheetId: "spreadsheet-1",
      configuration: { schemaVersion: 1 },
      createdBy: "user-1",
      ...audit,
    },
  },
  {
    name: "configWorkspaceSheetImportAttempt",
    replicated: ConfigWorkspaceSheetImportAttemptRow,
    persistence: configWorkspaceSheetImportAttempt.json,
    value: {
      attemptId: "attempt-1",
      workspaceId: "workspace-1",
      status: "succeeded",
      sourceBinding: { status: "unresolved", expectedTitle: "Users" },
      baselineDigest: "digest-1",
      result: null,
      createdBy: "user-1",
      ...audit,
    },
  },
  {
    name: "auditSheetConfiguration",
    replicated: AuditSheetConfigurationRow,
    persistence: auditSheetConfiguration.json,
    value: {
      eventId: "event-1",
      workspaceId: "workspace-1",
      operation: "import",
      outcome: "succeeded",
      invocationId: "invocation-1",
      effectivePrincipal: { kind: "user", id: "user-1" },
      actorProvenance: null,
      metadata: { attemptId: "attempt-1" },
      reason: null,
      ...audit,
    },
  },
  {
    name: "configWorkspaceCheckinMessageSet",
    replicated: ConfigWorkspaceCheckinMessageSetRow,
    persistence: configWorkspaceCheckinMessageSet.json,
    value: {
      workspaceId: "workspace-1",
      eventStartEpochMs: Date.UTC(2026, 8, 5, 12),
      messageSetGeneration: 3,
      updatedBy: "user-1",
      ...audit,
    },
  },
  {
    name: "configWorkspaceCheckinMessage",
    replicated: ConfigWorkspaceCheckinMessageRow,
    persistence: configWorkspaceCheckinMessage.json,
    value: {
      workspaceId: "workspace-1",
      messageSetGeneration: 3,
      conversationId: "running-1",
      hour: 12,
      template: null,
      version: 2,
      createdBy: "user-1",
      updatedBy: "user-2",
      ...audit,
    },
  },
  {
    name: "configWorkspaceCheckinMessageMutationReceipt",
    replicated: ConfigWorkspaceCheckinMessageMutationReceiptRow,
    persistence: configWorkspaceCheckinMessageMutationReceipt.json,
    value: {
      invocationId: "invocation-1",
      actionKey: "save-hour-12",
      workspaceId: "workspace-1",
      inputDigest: "digest-1",
      result: { version: 2 },
      createdBy: "user-1",
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
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      createdByUserId: "user-1",
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
      sheetConfigurationBinding: null,
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
