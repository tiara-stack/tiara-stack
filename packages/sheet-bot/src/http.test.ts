import { describe, expect, it } from "@effect/vitest";
import { discordInteractionMessageToRef } from "./http";

const client = { platform: "discord", clientId: "discord-main" } as const;

describe("discordInteractionMessageToRef", () => {
  it("uses guild_id when Discord includes it", () => {
    expect(
      discordInteractionMessageToRef(client, {
        channel_id: "channel-1",
        guild_id: "guild-1",
        id: "message-1",
      }),
    ).toEqual({
      conversation: {
        conversationId: "channel-1",
        workspace: {
          client,
          workspaceId: "guild-1",
        },
      },
      messageId: "message-1",
    });
  });

  it("allows interaction webhook responses without guild_id", () => {
    expect(
      discordInteractionMessageToRef(client, {
        channel_id: "channel-1",
        id: "message-1",
      }),
    ).toEqual({
      conversation: {
        conversationId: "channel-1",
        workspace: {
          client,
          workspaceId: "",
        },
      },
      messageId: "message-1",
    });
  });
});
