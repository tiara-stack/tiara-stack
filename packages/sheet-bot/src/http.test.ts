import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { SemanticFileIdentity } from "sheet-bot-api";
import {
  discordInteractionMessageToRef,
  makeUpdateConversationHandler,
  validateResponseWorkspaceBinding,
} from "./http";
import { deliveryStoreInput } from "./services/botDeliveryBinding";

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

describe("deliveryStoreInput", () => {
  const content = new Uint8Array([1, 2, 3]);

  it("preserves strict raw-byte binding unless a file opts into semantic identity", () => {
    const payload = {
      message: {
        files: [{ name: "strict.bin", contentType: "application/octet-stream", content }],
      },
    };

    expect(deliveryStoreInput(payload)).toBe(payload);
  });

  it("removes only opted-in file bytes while retaining the strict logical binding", () => {
    const semanticIdentity = Schema.decodeUnknownSync(SemanticFileIdentity)("semantic-file-1");
    const strict = { name: "strict.bin", contentType: "application/octet-stream", content };
    const semantic = {
      name: "screenshot.png",
      contentType: "image/png",
      content: new Uint8Array([9, 8, 7]),
      deliveryBinding: {
        semanticIdentity,
        logicalRequest: '["workspace-1","alpha",2]',
      },
    };

    expect(deliveryStoreInput({ message: { files: [strict, semantic] } })).toEqual({
      message: {
        files: [
          strict,
          {
            name: semantic.name,
            contentType: semantic.contentType,
            deliveryBinding: semantic.deliveryBinding,
          },
        ],
      },
    });
  });
});

describe("validateResponseWorkspaceBinding", () => {
  it.effect("accepts legacy unbound calls and exact workspace bindings", () =>
    Effect.gen(function* () {
      yield* validateResponseWorkspaceBinding({}, undefined);
      yield* validateResponseWorkspaceBinding(
        { workspaceId: "workspace-1" },
        { workspaceId: "workspace-1" },
      );
    }),
  );

  it.effect("rejects missing and foreign response workspace bindings", () =>
    Effect.gen(function* () {
      for (const response of [{}, { workspaceId: "workspace-2" }]) {
        const exit = yield* Effect.exit(
          validateResponseWorkspaceBinding(response, { workspaceId: "workspace-1" }),
        );
        const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();

        expect(Option.getOrNull(error)).toMatchObject({
          _tag: "BotRequestRejected",
          message: "Response Reference does not match the requested workspace",
        });
      }
    }),
  );
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
