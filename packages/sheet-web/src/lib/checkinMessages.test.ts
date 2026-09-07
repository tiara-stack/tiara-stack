import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  checkinMessageChannelsFromSchedule,
  checkinMessageForHour,
  normalizeCheckinTemplate,
  preferredCheckinHour,
  renderCheckinExample,
  tokenizeCheckinTemplate,
  withSavedCheckinMessage,
} from "./checkinMessages";
import { CheckinMessagesLoadSuccess, HourlyCheckinMessage } from "sheet-workflow-contracts";

const summaries = [
  {
    conversationName: "weekly-raid",
    day: 2,
    visible: true,
    hour: 52,
    break: false,
    playerNames: [],
    monitorName: "Airi",
    monitorAccountId: "account-airi",
  },
  {
    conversationName: "weekly-raid",
    day: 3,
    visible: true,
    hour: 51,
    break: false,
    playerNames: [],
    monitorName: "Airi",
    monitorAccountId: "account-airi",
  },
  {
    conversationName: "weekly-raid",
    day: 3,
    visible: true,
    hour: 52,
    break: false,
    playerNames: [],
    monitorName: "Someone else",
  },
  {
    conversationName: "alpha",
    day: 1,
    visible: true,
    hour: 4,
    break: false,
    playerNames: [],
    monitorName: "Someone else",
    monitorAccountId: "account-other",
  },
] as const;

const messageData = Schema.decodeUnknownSync(CheckinMessagesLoadSuccess)({
  workspaceId: "workspace",
  conversationId: "running-channel",
  conversationName: "weekly-raid",
  binding: { eventStartEpochMs: 1, messageSetGeneration: 2 },
  messages: [{ hour: 52, template: "Saved", version: 3 }],
});

describe("check-in message editor helpers", () => {
  it("groups schedule hours and only marks stable monitor identity matches", () => {
    expect(checkinMessageChannelsFromSchedule(summaries, "account-airi")).toEqual([
      { name: "alpha", hours: [4], moniHours: [] },
      { name: "weekly-raid", hours: [51, 52], moniHours: [51, 52] },
    ]);
    expect(checkinMessageChannelsFromSchedule(summaries)).toEqual([
      { name: "alpha", hours: [4], moniHours: [] },
      { name: "weekly-raid", hours: [51, 52], moniHours: [] },
    ]);
  });

  it("prefers the current hour only when it is available in the channel", () => {
    expect(preferredCheckinHour([51, 52], 52)).toBe(52);
    expect(preferredCheckinHour([51, 52], 53)).toBe(51);
    expect(preferredCheckinHour([], 52)).toBeUndefined();
  });

  it("normalizes only blank saves and preserves nonblank template text", () => {
    expect(normalizeCheckinTemplate("   ")).toBeNull();
    expect(normalizeCheckinTemplate("  Keep this exact text  ")).toBe("  Keep this exact text  ");
  });

  it("tokenizes supported placeholders without hiding unknown template text", () => {
    expect(tokenizeCheckinTemplate("{{mentionsString}} / {{unknown}} / {{hourString}}")).toEqual([
      { kind: "placeholder", token: "{{mentionsString}}" },
      { kind: "text", value: " / {{unknown}} / " },
      { kind: "placeholder", token: "{{hourString}}" },
    ]);
    expect(renderCheckinExample("{{mentionsString}} check in for {{hourString}}")).toBe(
      "@Airi @Emu check in for hour 52",
    );
  });

  it("merges a saved row so a later editor view sees the latest value", () => {
    const saved = Schema.decodeUnknownSync(HourlyCheckinMessage)({
      hour: 52,
      template: null,
      version: 4,
    });
    const next = withSavedCheckinMessage(messageData, saved);
    expect(checkinMessageForHour(next, 52)).toEqual(saved);
    expect(next.messages).toHaveLength(1);
  });
});
