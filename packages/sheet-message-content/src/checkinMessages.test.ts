import { describe, expect, it } from "@effect/vitest";
import { renderPlainText } from "./text";
import { textValue } from "./rendering";
import { monitorPingMessage, reminderMessage } from "./checkinMessages";

const context = {
  workspaceId: "server-1",
  runningConversationId: "run-1",
  runningConversationName: "marathon",
  checkinConversationId: "checkin-1",
  hour: 4,
};

describe("check-in DM messages", () => {
  it("renders the filler reminder production copy", () => {
    expect(renderPlainText(textValue(reminderMessage(context).content ?? []))).toBe(
      "Check-in is open for hour 4.\nServer: server-1\nRunning channel: marathon\nOpen the check-in message in the server and tap Check in.",
    );
    expect(reminderMessage(context).allowedMentions).toBe("none");
  });

  it("renders the monitor ping production copy", () => {
    expect(renderPlainText(textValue(monitorPingMessage(context).content ?? []))).toBe(
      "Check-in is open for hour 4.\nServer: server-1\nRunning channel: marathon\nYou are assigned as monitor for this hour.\nOpen the running channel for the monitor summary and next steps.",
    );
    expect(monitorPingMessage(context).allowedMentions).toBe("none");
  });
});
