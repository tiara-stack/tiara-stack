import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { discordInteractionMessageToRef, makeUpdateConversationHandler } from "./http";

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

describe("updateConversation handler", () => {
  const conversation = {
    workspace: { client, workspaceId: "guild-1" },
    conversationId: "channel-1",
  } as const;
  const permissionOverwrites = [
    { id: "role-1", type: 0, allow: "330752", deny: "0" },
    { id: "guild-1", type: 0, allow: "0", deny: "1024" },
  ] as const;

  it.effect("forwards the exact permission overwrite array to Discord", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const handler = makeUpdateConversationHandler(client.clientId, {
        updateChannel: (channelId, payload) => {
          calls.push({ channelId, payload });
          return Effect.succeed({});
        },
      });

      yield* handler({ payload: { conversation, permissionOverwrites } });

      expect(calls).toEqual([
        {
          channelId: "channel-1",
          payload: { permission_overwrites: permissionOverwrites },
        },
      ]);
    }),
  );

  it.effect("rejects updates for a different configured client", () =>
    Effect.gen(function* () {
      const handler = makeUpdateConversationHandler(client.clientId, {
        updateChannel: () => Effect.die("foreign clients must not reach Discord REST"),
      });

      const exit = yield* Effect.exit(
        handler({
          payload: {
            conversation: {
              ...conversation,
              workspace: {
                ...conversation.workspace,
                client: { platform: "discord", clientId: "discord-alt" },
              },
            },
            permissionOverwrites,
          },
        }),
      );
      const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();

      expect(Option.getOrNull(error)).toMatchObject({
        _tag: "ArgumentError",
        message: "Unknown Discord client discord:discord-alt",
      });
    }),
  );
});
