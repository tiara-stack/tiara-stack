import { Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { DeliveryKey, ResponseReference } from "sheet-bot-api";
import {
  CheckinsOpen,
  CheckinMessagesLoad,
  CheckinMessagesSave,
  CheckinsTestAuto,
  CalculationsRecalculateSheet,
  ConversationsUpdateConfigAndDeliver,
  DiscordLoadWorkspaceChannels,
  RoomOrdersNavigate,
  TeamSubmissionsDecide,
  WorkspacesFeatureFlagsSetAndDeliver,
} from "./catalog";

const responseReference = Schema.decodeUnknownSync(ResponseReference)("response-reference");

const messageRef = (messageId: string) => ({
  conversation: {
    workspace: {
      client: { platform: "discord", clientId: "sheet-bot" },
      workspaceId: "workspace",
    },
    conversationId: "conversation",
  },
  messageId,
});

describe("sheet Workflow Contract schema compatibility", () => {
  it("publishes config-only hourly check-in message load and save values", () => {
    const binding = { eventStartEpochMs: 1_700_000_000_000, messageSetGeneration: 3 };

    expect(
      Schema.decodeUnknownSync(CheckinMessagesLoad.input)({
        workspaceId: "workspace",
        conversationName: "alpha",
      }),
    ).toEqual({ workspaceId: "workspace", conversationName: "alpha" });
    expect(
      Schema.decodeUnknownSync(CheckinMessagesLoad.success)({
        workspaceId: "workspace",
        conversationId: "channel-1",
        conversationName: "alpha",
        binding,
        messages: [{ hour: 12, template: null, version: 2 }],
      }),
    ).toMatchObject({ binding, messages: [{ hour: 12, template: null, version: 2 }] });

    const saveInput = Schema.decodeUnknownSync(CheckinMessagesSave.input)({
      workspaceId: "workspace",
      conversationId: "channel-1",
      binding,
      hour: 12,
      template: "  preserve me  ",
      expectedVersion: 2,
      responseReference,
    });
    expect(saveInput.template).toBe("  preserve me  ");
    expect(CheckinMessagesLoad.authorizationPolicy.requiredAnyCapabilities).toEqual([
      "workspace.monitor",
      "workspace.manage",
    ]);
    expect(CheckinMessagesSave.authorizationPolicy.requiredAnyCapabilities).toEqual([
      "workspace.monitor",
      "workspace.manage",
    ]);
    expect(
      Schema.decodeUnknownSync(CheckinMessagesSave.declaredFailure)({
        _tag: "CheckinMessageConflict",
        kind: "row-version",
        message: "Refresh before saving",
        currentVersion: 3,
      }),
    ).toMatchObject({ _tag: "CheckinMessageConflict", kind: "row-version", currentVersion: 3 });
  });

  it("preserves the legacy workspace-channel success wire shape", () => {
    const channels = [
      { id: "1", name: "general", type: 0, parentId: null, position: 1 },
      { id: "2", name: "raids", type: 0, parentId: "category", position: 2 },
    ];

    expect(Schema.decodeUnknownSync(DiscordLoadWorkspaceChannels.success)(channels)).toEqual(
      channels,
    );
  });

  it("retains business arguments while removing gateway identity and credential fields", () => {
    const decoded = Schema.decodeUnknownSync(CheckinsOpen.input)({
      workspaceId: "workspace",
      responseReference,
      conversationName: "raid",
      hour: 12,
      dispatchRequestId: "legacy-dispatch-id",
      interactionResponseToken: "must-not-cross-the-contract",
      interactionResponseDeadlineEpochMs: 123,
      callerUserId: "must-not-select-a-principal",
      workflowName: "must-not-dispatch-generically",
    });

    expect(decoded).toEqual({
      workspaceId: "workspace",
      responseReference,
      conversationName: "raid",
      hour: 12,
    });
    expect(decoded).not.toHaveProperty("dispatchRequestId");
    expect(decoded).not.toHaveProperty("interactionResponseToken");
    expect(decoded).not.toHaveProperty("callerUserId");
    expect(decoded).not.toHaveProperty("workflowName");
  });

  it("accepts optional integer hours for automatic check-in tests", () => {
    const baseInput = {
      workspaceId: "workspace",
      responseReference,
      anchorConversationId: "anchor",
    };

    expect(Schema.decodeUnknownSync(CheckinsTestAuto.input)(baseInput)).toEqual(baseInput);
    expect(Schema.decodeUnknownSync(CheckinsTestAuto.input)({ ...baseInput, hour: 4 }).hour).toBe(
      4,
    );
    expect(() =>
      Schema.decodeUnknownSync(CheckinsTestAuto.input)({ ...baseInput, hour: 4.5 }),
    ).toThrow();
  });

  it("consolidates symmetric legacy operations into desired-state discriminators", () => {
    expect(
      Schema.decodeUnknownSync(RoomOrdersNavigate.input)({
        workspaceId: "workspace",
        responseReference,
        messageId: "message",
        messageConversationId: "conversation",
        direction: "next",
      }).direction,
    ).toBe("next");
    expect(
      Schema.decodeUnknownSync(WorkspacesFeatureFlagsSetAndDeliver.input)({
        workspaceId: "workspace",
        flagName: "team-submission-confirmations",
        enabled: false,
      }).enabled,
    ).toBe(false);
    for (const decision of ["confirm", "reject"] as const) {
      expect(
        Schema.decodeUnknownSync(TeamSubmissionsDecide.input)({
          responseReference,
          sourceMessage: messageRef("source"),
          confirmationMessage: messageRef("confirmation"),
          decision,
        }).decision,
      ).toBe(decision);
    }
    expect(() =>
      Schema.decodeUnknownSync(TeamSubmissionsDecide.input)({
        responseReference,
        sourceMessage: messageRef("source"),
        confirmationMessage: messageRef("confirmation"),
        decision: "maybe",
      }),
    ).toThrow();
  });

  it("preserves explicit nulls for conversation configuration unsets", () => {
    const input = Schema.decodeUnknownSync(ConversationsUpdateConfigAndDeliver.input)({
      workspaceId: "workspace",
      conversationId: "conversation",
      responseReference,
      patch: {
        running: null,
        name: null,
        roleId: null,
        checkinConversationId: null,
      },
    });

    expect(input.patch).toEqual({
      running: null,
      name: null,
      roleId: null,
      checkinConversationId: null,
    });
  });

  it("publishes the approved Apps Script calculation input and compact success", () => {
    const input = Schema.decodeUnknownSync(CalculationsRecalculateSheet.input)({
      spreadsheetId: "spreadsheet",
      sheetRef: "Raid!AX30:CC",
      hour: 12,
      config: { cc: true, considerEnc: false, healNeeded: 1 },
      players: [
        { name: "one", encable: false },
        { name: "two", encable: false },
        { name: "three", encable: true },
        { name: "four", encable: true },
        { name: "five", encable: false },
      ],
      fixedTeams: [{ name: "fixed", heal: true }],
    });
    const success = Schema.decodeUnknownSync(CalculationsRecalculateSheet.success)({
      spreadsheetId: "spreadsheet",
      sheetRef: "Raid!AX30:CC",
      hour: 12,
      outputRange: "AX31:CC33",
      roomCount: 3,
    });

    expect(input.players).toHaveLength(5);
    expect(success).toMatchObject({ outputRange: "AX31:CC33", roomCount: 3 });
    const insufficientPlayersInput = {
      spreadsheetId: "spreadsheet",
      sheetRef: "Raid!AX30:CC",
      hour: 12,
      config: { cc: true, considerEnc: false, healNeeded: 1 },
      players: [
        { name: "one", encable: false },
        { name: "two", encable: false },
        { name: "three", encable: true },
        { name: "four", encable: true },
      ],
      fixedTeams: [{ name: "fixed", heal: true }],
    };

    expect(() =>
      Schema.decodeUnknownSync(CalculationsRecalculateSheet.input)(insufficientPlayersInput),
    ).toThrow();
  });

  it("keeps public Declared Failures typed and strips runtime diagnostics", () => {
    const failure = Schema.decodeUnknownSync(CheckinsOpen.declaredFailure)({
      _tag: "DeliveryRejected",
      operation: "respond",
      message: "response expired",
      recoveryRequired: false,
      deliveryKey: Schema.decodeUnknownSync(DeliveryKey)("private-delivery-key"),
      cause: { message: "private provider error" },
      stack: "private stack",
    });

    expect(failure).toEqual({
      _tag: "DeliveryRejected",
      operation: "respond",
      message: "response expired",
      recoveryRequired: false,
    });
    expect(failure).not.toHaveProperty("deliveryKey");
    expect(failure).not.toHaveProperty("cause");
    expect(failure).not.toHaveProperty("stack");
  });
});
