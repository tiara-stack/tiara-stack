import { describe, expect, it } from "@effect/vitest";
import { Buffer } from "node:buffer";
import { ParentCachePageSize } from "dfx-discord-utils/cache";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import {
  BotCollectionCursor,
  BotRequestRejected,
  maximumBotCollectionPageSize,
} from "sheet-bot-api";
import {
  botConversationPage,
  botMemberPage,
  decodeBotCollectionCursor,
  encodeBotCollectionCursor,
} from "./botCachePagination";

const conversationContext = {
  collection: "conversations",
  platform: "discord",
  clientId: "discord-main",
  workspaceId: "workspace-1",
} as const;

describe("bot cache collection pagination", () => {
  it.effect("round-trips an opaque cursor only in its original collection context", () =>
    Effect.gen(function* () {
      const cursor = encodeBotCollectionCursor(conversationContext, "conversation-100");

      expect(yield* decodeBotCollectionCursor(cursor, conversationContext)).toBe(
        "conversation-100",
      );

      const wrongWorkspace = yield* Effect.exit(
        decodeBotCollectionCursor(cursor, {
          ...conversationContext,
          workspaceId: "workspace-2",
        }),
      );
      const wrongCollection = yield* Effect.exit(
        decodeBotCollectionCursor(cursor, {
          ...conversationContext,
          collection: "members",
        }),
      );
      const malformed = yield* Effect.exit(
        decodeBotCollectionCursor(
          Schema.decodeUnknownSync(BotCollectionCursor)("not-json"),
          conversationContext,
        ),
      );
      const wrongVersion = yield* Effect.exit(
        decodeBotCollectionCursor(
          Schema.decodeUnknownSync(BotCollectionCursor)(
            Buffer.from(
              JSON.stringify({ version: 2, ...conversationContext, after: "conversation-100" }),
              "utf8",
            ).toString("base64url"),
          ),
          conversationContext,
        ),
      );

      for (const exit of [wrongWorkspace, wrongCollection, malformed, wrongVersion]) {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) continue;
        expect(Option.getOrNull(Cause.findErrorOption(exit.cause))).toBeInstanceOf(
          BotRequestRejected,
        );
      }
    }),
  );

  it("keeps the public and cache-driver page-size maxima aligned", () => {
    expect(Schema.decodeUnknownSync(ParentCachePageSize)(maximumBotCollectionPageSize)).toBe(
      maximumBotCollectionPageSize,
    );
    expect(() =>
      Schema.decodeUnknownSync(ParentCachePageSize)(maximumBotCollectionPageSize + 1),
    ).toThrow();
  });

  it.effect("preserves stable page order and deterministic provider-neutral views", () =>
    Effect.gen(function* () {
      const conversations = botConversationPage(conversationContext, {
        entries: new Map([
          ["conversation-001", { type: 0, guild_id: "workspace-1", name: "general", position: 1 }],
          ["conversation-002", { type: 2 }],
        ]),
        nextCursor: "conversation-002",
      });

      expect(conversations.items).toEqual([
        {
          id: "conversation-001",
          type: 0,
          workspaceId: "workspace-1",
          name: "general",
          position: 1,
        },
        { id: "conversation-002", type: 2 },
      ]);
      expect(yield* decodeBotCollectionCursor(conversations.nextCursor, conversationContext)).toBe(
        "conversation-002",
      );

      expect(
        botMemberPage(
          { ...conversationContext, collection: "members" },
          {
            entries: new Map([
              [
                "member-001",
                {
                  roles: ["role-2", "role-1"],
                  user: { global_name: "Global name", username: "username" },
                },
              ],
              [
                "member-002",
                {
                  roles: [],
                  nick: "Nickname",
                  user: { global_name: "Ignored global name" },
                },
              ],
            ]),
          },
        ).items,
      ).toEqual([
        { userId: "member-001", roleIds: ["role-2", "role-1"], displayName: "Global name" },
        { userId: "member-002", roleIds: [], displayName: "Nickname" },
      ]);
    }),
  );
});
