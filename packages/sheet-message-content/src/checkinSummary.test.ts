import { describe, expect, it } from "vitest";
import { Option } from "effect";
import {
  autoMonitorCheckinMessage,
  autoCheckinSummaryMessage,
  makeMonitorCheckinMessage,
  manualCheckinSummaryMessage,
} from "./checkinSummary";
import { textValue } from "./rendering";
import { renderPlainText } from "./text";

describe("check-in summaries", () => {
  const monitorCheckinMessage = makeMonitorCheckinMessage({
    initialMessage: [{ type: "text", text: "check-in prompt" }],
    empty: 0,
    out: [{ name: "MikuEnjoyer", userId: "filler-out" }],
    stay: [{ name: "AiriFan", userId: "filler-stay" }],
    in: [],
    lookupFailedMessage: Option.none(),
  });

  it("renders the manual command's exact production summary", () => {
    expect(renderPlainText(monitorCheckinMessage)).toBe(
      "Check-in message sent!\nNo empty slots\nOut: @filler-out\nStay: @filler-stay\nIn: None",
    );
  });

  it("uses names when a filler has no user ID", () => {
    const message = makeMonitorCheckinMessage({
      initialMessage: [{ type: "text", text: "check-in prompt" }],
      empty: 0,
      out: [{ name: "Sheet-only filler" }],
      stay: [],
      in: [],
      lookupFailedMessage: Option.none(),
    });

    expect(renderPlainText(message)).toContain("Out: Sheet-only filler");
  });

  it("keeps the production no-change empty-slot rules", () => {
    const makeNoChange = (empty: number) =>
      renderPlainText(
        makeMonitorCheckinMessage({
          initialMessage: null,
          empty,
          out: [],
          stay: [],
          in: [],
          lookupFailedMessage: Option.none(),
        }),
      );

    expect(makeNoChange(2)).toBe(
      "No check-in message sent, no new players to check in\n+2 empty slots",
    );
    expect(makeNoChange(1)).toBe(
      "No check-in message sent, no new players to check in\n+1 empty slot",
    );
    expect(makeNoChange(0)).toBe("No check-in message sent, no new players to check in");
    expect(makeNoChange(5)).toBe("No check-in message sent, no new players to check in");
  });

  it("wraps the same summary in the production auto-check-in embed", () => {
    const message = autoCheckinSummaryMessage({
      monitorUserId: "monitor-1",
      monitorCheckinMessage,
      monitorFailureMessage: null,
    });

    expect(message.content).toEqual([{ type: "userMention", userId: "monitor-1" }]);
    expect(message.allowedMentions).toBe("default");
    expect(message.embeds?.[0]?.title).toEqual([
      { type: "text", text: "Auto check-in summary for monitors" },
    ]);
    expect(renderPlainText(textValue(message.embeds?.[0]?.description ?? []))).toBe(
      "Check-in message sent!\nNo empty slots\nOut: @filler-out\nStay: @filler-stay\nIn: None\nSent automatically via auto check-in.",
    );
  });

  it("wraps the manual summary in an embed without a monitor ping or auto-check-in line", () => {
    const message = manualCheckinSummaryMessage({ monitorCheckinMessage });

    expect(message.content).toBeNull();
    expect(message.allowedMentions).toBe("none");
    expect(message.embeds?.[0]?.title).toEqual([
      { type: "text", text: "Check-in summary for monitors" },
    ]);
    expect(renderPlainText(textValue(message.embeds?.[0]?.description ?? []))).toBe(
      "Check-in message sent!\nNo empty slots\nOut: @filler-out\nStay: @filler-stay\nIn: None",
    );
  });

  it("renders a required monitor handoff with room context and a check-in button", () => {
    const message = autoMonitorCheckinMessage({
      client: { platform: "discord", clientId: "tiarabot" },
      workspaceId: "workspace-1",
      runningConversationId: "running-1",
      hour: 4,
      monitorUserId: "monitor-1",
      monitorCheckinRequired: true,
      monitorCheckinMessage,
      monitorFailureMessage: null,
    });

    expect(renderPlainText(message.content ?? [])).toBe(
      "@monitor-1 please check in for hour 4 in #running-1.",
    );
    expect(message.components?.[0]?.components[0]).toMatchObject({
      actionId: "interaction:checkin",
      label: "Check in",
      disabled: false,
    });
    expect(message.embeds?.[0]?.fields).toHaveLength(2);
    expect(message.allowedMentions).toBe("default");
  });

  it("renders a continuing monitor without a button", () => {
    const message = autoMonitorCheckinMessage({
      client: { platform: "discord", clientId: "tiarabot" },
      workspaceId: "workspace-1",
      runningConversationId: "running-1",
      hour: 4,
      monitorUserId: "monitor-1",
      monitorCheckinRequired: false,
      monitorCheckinMessage,
      monitorFailureMessage: null,
    });

    expect(renderPlainText(message.content ?? [])).toBe(
      "@monitor-1 is continuing from hour 3 in #running-1; no new monitor check-in is required.",
    );
    expect(message.components).toBeUndefined();
  });

  it("renders unresolved monitor output without a mention or button", () => {
    const message = autoMonitorCheckinMessage({
      client: { platform: "discord", clientId: "tiarabot" },
      workspaceId: "workspace-1",
      runningConversationId: "running-1",
      hour: 4,
      monitorUserId: null,
      monitorCheckinRequired: true,
      monitorCheckinMessage,
      monitorFailureMessage: [{ type: "text", text: "Monitor ID is missing." }],
    });

    expect(message.content).toBeNull();
    expect(message.components).toBeUndefined();
    expect(message.allowedMentions).toBe("none");
    expect(renderPlainText(textValue(message.embeds?.[0]?.description ?? []))).toContain(
      "Monitor ID is missing.",
    );
  });
});
