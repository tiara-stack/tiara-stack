import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { sendTentativeRoomOrder } from "./tentativeRoomOrder";

describe("sendTentativeRoomOrder", () => {
  it("persists auto check-in room orders as tentative", async () => {
    const persisted: unknown[] = [];

    await Effect.runPromise(
      sendTentativeRoomOrder({
        workspaceId: "guild-1",
        runningConversationId: "channel-1",
        hour: 20,
        fillCount: 5,
        createdByUserId: "user-1",
        roomOrderService: {
          generate: () =>
            Effect.succeed({
              content: [{ type: "text", text: "Room order content" }],
              range: { minRank: 0, maxRank: 1 },
              rank: 0,
              hour: 20,
              monitor: "monitor-1",
              previousFills: ["old-fill"],
              fills: ["fill-1"],
              entries: [
                {
                  rank: 0,
                  position: 0,
                  hour: 20,
                  team: "Team A",
                  tags: ["fill"],
                  effectValue: 100,
                },
              ],
            }),
        },
        messageRoomOrderService: {
          persistMessageRoomOrder: (_messageId, payload) =>
            Effect.sync(() => {
              persisted.push(payload);
            }),
        },
        sender: {
          createMessage: () =>
            Effect.succeed({
              id: "message-1",
              channel_id: "channel-1",
            } as never),
          updateMessage: () => Effect.succeed({} as never),
        },
      }),
    );

    expect(persisted).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          tentative: true,
        }),
      }),
    ]);
  });
});
