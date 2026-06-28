import { Schema } from "effect";
import { messageRoomOrderEntry as messageRoomOrderEntryModel } from "sheet-db-schema/models";
import { describe, expect, it } from "@effect/vitest";
import {
  FeatureFlagName,
  WorkspaceConversationConfig,
  WorkspaceConfig,
  WorkspaceFeatureFlag,
  WorkspaceMonitorRole,
} from "./workspaceConfig";
import { UserPlatformConfig } from "./userConfig";
import { MessageCheckin, MessageCheckinMember } from "./messageCheckin";
import { MessageRoomOrder, MessageRoomOrderEntry } from "./messageRoomOrder";
import { MessageSlot } from "./messageSlot";
import type { DateTimeOptionField, NumberField, StringArrayField, StringField } from "./model";
import { modelTaggedFields, validateTaggedFields } from "./model";

const expectWireRoundTrip = (
  schema: Schema.Codec<unknown, Record<string, unknown>>,
  payload: Record<string, unknown>,
) => {
  const decoded = Schema.decodeUnknownSync(schema)(payload);
  expect(Schema.encodeUnknownSync(schema)(decoded)).toEqual(payload);
};

const FullMessageRoomOrderEntryFields = validateTaggedFields<{
  readonly clientPlatform: StringField;
  readonly clientId: StringField;
  readonly messageId: StringField;
  readonly rank: NumberField;
  readonly position: NumberField;
  readonly hour: NumberField;
  readonly team: StringField;
  readonly tags: StringArrayField;
  readonly effectValue: NumberField;
  readonly createdAt: DateTimeOptionField;
  readonly updatedAt: DateTimeOptionField;
  readonly deletedAt: DateTimeOptionField;
}>(modelTaggedFields(messageRoomOrderEntryModel), [
  "clientPlatform",
  "clientId",
  "messageId",
  "rank",
  "position",
  "hour",
  "team",
  "tags",
  "effectValue",
  "createdAt",
  "updatedAt",
  "deletedAt",
] as const);

class FullMessageRoomOrderEntry extends Schema.TaggedClass<FullMessageRoomOrderEntry>()(
  "FullMessageRoomOrderEntry",
  FullMessageRoomOrderEntryFields,
) {}

describe("model-derived persisted schemas", () => {
  it("round-trips workspace config row schemas without wire-shape drift", () => {
    expectWireRoundTrip(WorkspaceConfig, {
      _tag: "WorkspaceConfig",
      workspaceId: "workspace-1",
      sheetId: "sheet-1",
      autoCheckin: true,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_100,
      deletedAt: null,
    });

    expectWireRoundTrip(WorkspaceConversationConfig, {
      _tag: "WorkspaceConversationConfig",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      name: "conversation-name",
      running: false,
      roleId: null,
      checkinConversationId: "checkin-conversation-1",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_100,
      deletedAt: null,
    });

    expectWireRoundTrip(WorkspaceMonitorRole, {
      _tag: "WorkspaceMonitorRole",
      workspaceId: "workspace-1",
      roleId: "role-1",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_100,
      deletedAt: null,
    });

    expectWireRoundTrip(WorkspaceFeatureFlag, {
      _tag: "WorkspaceFeatureFlag",
      workspaceId: "workspace-1",
      flagName: "beta-feature",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_100,
      deletedAt: null,
    });
  });

  it("round-trips user platform config row schemas without wire-shape drift", () => {
    expectWireRoundTrip(UserPlatformConfig, {
      _tag: "UserPlatformConfig",
      platform: "discord",
      userId: "discord-user-1",
      defaultClientId: "discord-main",
      checkinDmEnabled: true,
      monitorDmEnabled: false,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_100,
      deletedAt: null,
    });
  });

  it("rejects empty feature flag names at the runtime schema boundary", () => {
    expect(Schema.decodeUnknownSync(FeatureFlagName)("beta-feature")).toBe("beta-feature");
    expect(Schema.decodeUnknownSync(FeatureFlagName)(" beta-feature ")).toBe(" beta-feature ");
    expect(() => Schema.decodeUnknownSync(FeatureFlagName)("")).toThrow();
    expect(() => Schema.decodeUnknownSync(FeatureFlagName)("   ")).toThrow();
  });

  it("round-trips checkin row schemas without wire-shape drift", () => {
    expectWireRoundTrip(MessageCheckin, {
      _tag: "MessageCheckin",
      clientPlatform: "discord",
      clientId: "discord-main",
      messageId: "message-1",
      initialMessage: [{ type: "text", text: "initial" }],
      hour: 12,
      runningConversationId: "channel-1",
      roleId: null,
      workspaceId: "guild-1",
      conversationId: null,
      createdByUserId: "user-1",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_100,
      deletedAt: null,
    });

    expectWireRoundTrip(MessageCheckinMember, {
      _tag: "MessageCheckinMember",
      clientPlatform: "discord",
      clientId: "discord-main",
      messageId: "message-1",
      memberId: "member-1",
      checkinAt: 1_700_000_000_200,
      checkinClaimId: null,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_100,
      deletedAt: null,
    });
  });

  it("round-trips room-order row schemas without wire-shape drift", () => {
    expectWireRoundTrip(MessageRoomOrder, {
      _tag: "MessageRoomOrder",
      clientPlatform: "discord",
      clientId: "discord-main",
      messageId: "message-1",
      previousFills: ["a"],
      fills: ["b"],
      hour: 20,
      rank: 1,
      tentative: false,
      monitor: null,
      workspaceId: "guild-1",
      conversationId: "channel-1",
      createdByUserId: "user-1",
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
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_100,
      deletedAt: null,
    });

    expectWireRoundTrip(MessageRoomOrderEntry, {
      _tag: "MessageRoomOrderEntry",
      clientPlatform: "discord",
      clientId: "discord-main",
      messageId: "message-1",
      rank: 1,
      position: 2,
      team: "team-1",
      tags: ["tag-1"],
      effectValue: 3,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_100,
      deletedAt: null,
    });
  });

  it("round-trips message slot row schemas without wire-shape drift", () => {
    expectWireRoundTrip(MessageSlot, {
      _tag: "MessageSlot",
      clientPlatform: "discord",
      clientId: "discord-main",
      messageId: "message-1",
      day: 4,
      workspaceId: null,
      conversationId: "channel-1",
      createdByUserId: "user-1",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_100,
      deletedAt: null,
    });
  });

  it("keeps room-order entry hour out of the public encoded wire schema", () => {
    const payload = {
      _tag: "MessageRoomOrderEntry",
      clientPlatform: "discord",
      clientId: "discord-main",
      messageId: "message-1",
      rank: 1,
      position: 2,
      hour: 20,
      team: "team-1",
      tags: [],
      effectValue: 3,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_100,
      deletedAt: null,
    };

    const decoded = Schema.decodeUnknownSync(MessageRoomOrderEntry)(payload);
    expect(Schema.encodeUnknownSync(MessageRoomOrderEntry)(decoded)).not.toHaveProperty("hour");

    const fullDecoded = Schema.decodeUnknownSync(FullMessageRoomOrderEntry)({
      ...payload,
      _tag: "FullMessageRoomOrderEntry",
    });
    expect(Schema.encodeUnknownSync(FullMessageRoomOrderEntry)(fullDecoded)).toHaveProperty(
      "hour",
      20,
    );
  });
});
