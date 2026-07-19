import { describe, expect, it } from "@effect/vitest";
import { monitorPingMessage, reminderMessage } from "./checkinMessages";
import { textValue } from "./rendering";
import { renderPlainText } from "./text";

const context = {
  client: { platform: "discord", clientId: "tiarabot" },
  workspaceId: "server-1",
  workspaceName: "Sekai *Tiering*",
  runningConversationId: "run-1",
  checkinConversationId: "checkin-1",
  hour: 4,
};

describe("check-in DM messages", () => {
  it("renders the filler reminder as an embed with the check-in channel mention", () => {
    expect(reminderMessage(context)).toEqual({
      content: null,
      embeds: [
        {
          title: [{ type: "text", text: "Check-in is open for hour 4" }],
          description: [
            { type: "text", text: "Server: Sekai \\*Tiering\\*" },
            { type: "text", text: "\n" },
            { type: "text", text: "Check-in channel: " },
            {
              type: "conversationMention",
              conversation: {
                workspace: {
                  client: { platform: "discord", clientId: "tiarabot" },
                  workspaceId: "server-1",
                },
                conversationId: "checkin-1",
              },
            },
            { type: "text", text: "\n" },
            { type: "text", text: "Open the check-in message and tap Check in." },
          ],
        },
      ],
      allowedMentions: "none",
    });
  });

  it("renders the monitor ping as an embed with the running channel mention", () => {
    expect(monitorPingMessage(context)).toEqual({
      content: null,
      embeds: [
        {
          title: [{ type: "text", text: "Check-in is open for hour 4" }],
          description: [
            { type: "text", text: "Server: Sekai \\*Tiering\\*" },
            { type: "text", text: "\n" },
            { type: "text", text: "Running channel: " },
            {
              type: "conversationMention",
              conversation: {
                workspace: {
                  client: { platform: "discord", clientId: "tiarabot" },
                  workspaceId: "server-1",
                },
                conversationId: "run-1",
              },
            },
            { type: "text", text: "\n" },
            { type: "text", text: "You are assigned as monitor for this hour." },
            { type: "text", text: "\n" },
            {
              type: "text",
              text: "Open the running channel for the monitor summary and next steps.",
            },
          ],
        },
      ],
      allowedMentions: "none",
    });
  });

  it("omits the server line instead of falling back to the server ID", () => {
    const message = reminderMessage({ ...context, workspaceName: undefined });
    const description = message.embeds?.[0]?.description ?? [];

    expect(renderPlainText(textValue(description))).toBe(
      "Check-in channel: #checkin-1\nOpen the check-in message and tap Check in.",
    );
  });
});
