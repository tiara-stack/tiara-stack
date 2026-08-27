import { describe, expect, it } from "@effect/vitest";
import { NodeFileSystem, NodeHttpPlatform, NodePath } from "@effect/platform-node";
import { DiscordREST } from "dfx";
import type * as Discord from "dfx/types";
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect";
import * as Etag from "effect/unstable/http/Etag";
import { HttpApiTest } from "effect/unstable/httpapi";
import { DeliveryKey, ResponseReference, SemanticFileIdentity } from "sheet-bot-api";
import { SheetBotApi } from "sheet-bot-api/http";
import {
  botCapabilityDeliveryHandlersLayer,
  discordInteractionMessageToRef,
  validateResponseWorkspaceBinding,
} from "./http";
import { deliveryStoreInput } from "./services/botDeliveryBinding";
import { BotCapabilityStore } from "./services/botCapabilityStore";

const client = { platform: "discord", clientId: "discord-main" } as const;

const makeDeliveryHttpClient = (
  rest: Layer.Layer<DiscordREST>,
  store: typeof BotCapabilityStore.Service,
) =>
  HttpApiTest.groups(SheetBotApi, ["delivery"]).pipe(
    Effect.provide(botCapabilityDeliveryHandlersLayer),
    Effect.provide(rest),
    Effect.provide(Layer.succeed(BotCapabilityStore, store)),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ SHEET_BOT_CLIENT_ID: client.clientId })),
    ),
    Effect.provide(NodeFileSystem.layer),
    Effect.provide(NodeHttpPlatform.layer),
    Effect.provide(NodePath.layer),
    Effect.provide(Etag.layer),
    Effect.scoped,
  );

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

  it.effect("uses the authorized workspace for a valid interaction anchor receipt", () =>
    Effect.gen(function* () {
      const responseReference = Schema.decodeUnknownSync(ResponseReference)("response-1");
      const deliveryKey = Schema.decodeUnknownSync(DeliveryKey)("delivery-1");
      const rest = Layer.succeed(DiscordREST, {
        updateOriginalWebhookMessage: () =>
          Effect.succeed({ id: "message-1", channel_id: "channel-1" } as Discord.MessageResponse),
        withFiles:
          () =>
          <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect,
      } as unknown as typeof DiscordREST.Service);
      const store = {
        resolveResponseReference: () =>
          Effect.succeed({
            applicationId: "application-1",
            client,
            interactionToken: "interaction-token",
            permittedOperations: ["respond"],
            expiresAt: Number.MAX_SAFE_INTEGER,
            workspaceId: "guild-1",
          }),
        executeDelivery: ({
          effect,
        }: {
          readonly effect: Effect.Effect<unknown, unknown, never>;
        }) => effect,
      } as unknown as typeof BotCapabilityStore.Service;
      const httpClient = yield* makeDeliveryHttpClient(rest, store);

      const receipt = yield* httpClient.delivery.respond({
        payload: {
          responseReference,
          deliveryKey,
          message: { content: "hello" },
        },
      });

      expect(receipt).toMatchObject({
        deliveryKey,
        operation: "respond",
        target: {
          _tag: "Response",
          responseReference,
          message: {
            conversation: {
              conversationId: "channel-1",
              workspace: { client, workspaceId: "guild-1" },
            },
            messageId: "message-1",
          },
        },
      });
    }),
  );
});

describe("SheetBotApi permission-overwrite delivery", () => {
  const conversation = {
    conversationId: "channel-1",
    workspace: { client, workspaceId: "guild-1" },
  } as const;

  const permissionOverwrites = [
    { targetId: "role-1", targetKind: "role", allow: "1024", deny: "2048" },
    { targetId: "member-1", targetKind: "member", allow: "4096", deny: "8192" },
  ] as const;

  const makeStore = () =>
    ({
      executeDelivery: ({ effect }: { readonly effect: Effect.Effect<unknown, unknown, never> }) =>
        effect,
    }) as unknown as typeof BotCapabilityStore.Service;

  it.effect("forwards permission overwrites with Discord target types", () =>
    Effect.gen(function* () {
      const updates: Array<unknown> = [];
      const rest = Layer.sync(DiscordREST)(
        () =>
          ({
            updateChannel: (channelId: string, payload: unknown) =>
              Effect.sync(() => {
                updates.push({ channelId, payload });
                return {};
              }),
          }) as unknown as typeof DiscordREST.Service,
      );
      const httpClient = yield* makeDeliveryHttpClient(rest, makeStore());

      const receipt = yield* httpClient.delivery.replaceConversationPermissionOverwrites({
        payload: {
          conversation,
          deliveryKey: Schema.decodeUnknownSync(DeliveryKey)("delivery-1"),
          permissionOverwrites,
        },
      });

      expect(updates).toEqual([
        {
          channelId: "channel-1",
          payload: {
            permission_overwrites: [
              { id: "role-1", type: 0, allow: "1024", deny: "2048" },
              { id: "member-1", type: 1, allow: "4096", deny: "8192" },
            ],
          },
        },
      ]);
      expect(receipt).toMatchObject({
        deliveryKey: "delivery-1",
        operation: "replaceConversationPermissionOverwrites",
        target: { _tag: "Conversation", conversation },
      });
    }),
  );

  it.effect("rejects an unconfigured Discord client before calling REST", () =>
    Effect.gen(function* () {
      const updates: Array<unknown> = [];
      const rest = Layer.sync(DiscordREST)(
        () =>
          ({
            updateChannel: () =>
              Effect.sync(() => {
                updates.push("unexpected update");
                return {};
              }),
          }) as unknown as typeof DiscordREST.Service,
      );
      const httpClient = yield* makeDeliveryHttpClient(rest, makeStore());
      const exit = yield* Effect.exit(
        httpClient.delivery.replaceConversationPermissionOverwrites({
          payload: {
            conversation: {
              ...conversation,
              workspace: {
                ...conversation.workspace,
                client: {
                  ...conversation.workspace.client,
                  clientId: "discord-unconfigured",
                },
              },
            },
            deliveryKey: Schema.decodeUnknownSync(DeliveryKey)("delivery-2"),
            permissionOverwrites,
          },
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) return;
      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: "BotResourceNotFound",
        resource: "client",
      });
      expect(updates).toEqual([]);
    }),
  );
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
  it.effect("accepts unbound responses and exact workspace bindings", () =>
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
