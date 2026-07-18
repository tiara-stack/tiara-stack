import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { autoCheckinSummaryMessage, makeMonitorCheckinMessage } from "./checkinSummary";
import { textValue } from "./rendering";
import { renderPlainText } from "./text";

describe("check-in summaries", () => {
  const monitorCheckinMessage = makeMonitorCheckinMessage({
    initialMessage: [{ type: "text", text: "check-in prompt" }],
    empty: 0,
    out: [{ name: "MikuEnjoyer" }],
    stay: [{ name: "AiriFan" }],
    in: [],
    lookupFailedMessage: Option.none(),
  });

  it("renders the manual command's exact production summary", () => {
    expect(renderPlainText(monitorCheckinMessage)).toBe(
      "Check-in message sent!\nNo empty slots\nOut: MikuEnjoyer\nStay: AiriFan\nIn: None",
    );
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
      "Check-in message sent!\nNo empty slots\nOut: MikuEnjoyer\nStay: AiriFan\nIn: None\nSent automatically via auto check-in.",
    );
  });
});
