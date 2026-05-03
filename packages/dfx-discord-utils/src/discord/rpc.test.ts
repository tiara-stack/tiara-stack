import { DiscordREST } from "dfx";
import { describe, expect, it } from "vitest";
import { Effect, Exit, Result, Schema } from "effect";
import { RpcTest } from "effect/unstable/rpc";
import { ChannelsCache, GuildsCache, MembersCache, RolesCache } from "./cache";
import { DiscordApplication } from "./gateway";
import { DiscordRpcs, discordRpcHandlersLayer } from "./rpc";
import { DiscordInteractionResponseRequestSchema } from "./schema";

const member = {
  user: {
    id: "member-1",
    username: "member",
    avatar: null,
    discriminator: "0000",
    public_flags: 0,
    flags: 0,
    global_name: null,
    primary_guild: null,
  },
  nick: null,
  avatar: null,
  banner: null,
  roles: ["role-1"],
  premium_since: null,
  communication_disabled_until: null,
};

const cacheMiss = {
  _tag: "CacheMissError",
  cacheName: "MembersCache",
  id: "guild-1/member-1",
};

const makeCaches = ({
  memberResult = Effect.succeed(member),
  guildSize = Effect.succeed(2),
}: {
  readonly memberResult?: Effect.Effect<typeof member, unknown, never>;
  readonly guildSize?: Effect.Effect<number, unknown, never>;
} = {}) => ({
  guilds: {
    size: guildSize,
  },
  channels: {},
  roles: {},
  members: {
    get: () => memberResult,
  },
});

const makeRest = ({
  createMessage = () =>
    Effect.succeed({
      id: "message-1",
      channel_id: "channel-1",
      content: "hello",
    }),
  createInteractionResponse = () =>
    Effect.succeed({
      interaction: { id: "interaction-1", type: 2 },
      resource: {
        type: 4,
        message: {
          id: "message-1",
          channel_id: "channel-1",
        },
      },
    }),
  updateMessage = () =>
    Effect.succeed({
      id: "message-1",
      channel_id: "channel-1",
      content: "updated",
    }),
  updateOriginalWebhookMessage = () =>
    Effect.succeed({
      id: "message-1",
      channel_id: "channel-1",
      content: "updated",
    }),
  createPin = () => Effect.succeed({}),
  addGuildMemberRole = () => Effect.succeed({}),
}: {
  readonly createMessage?: (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>;
  readonly createInteractionResponse?: (
    ...args: ReadonlyArray<unknown>
  ) => Effect.Effect<unknown, unknown>;
  readonly updateMessage?: (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>;
  readonly updateOriginalWebhookMessage?: (
    ...args: ReadonlyArray<unknown>
  ) => Effect.Effect<unknown, unknown>;
  readonly createPin?: (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>;
  readonly addGuildMemberRole?: (
    ...args: ReadonlyArray<unknown>
  ) => Effect.Effect<unknown, unknown>;
} = {}) => ({
  createMessage,
  createInteractionResponse,
  updateMessage,
  updateOriginalWebhookMessage,
  createPin,
  addGuildMemberRole,
});

const run = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  caches: ReturnType<typeof makeCaches> = makeCaches(),
  rest: ReturnType<typeof makeRest> = makeRest(),
) => {
  const provided = effect.pipe(
    Effect.provide(discordRpcHandlersLayer),
    Effect.provideService(DiscordApplication, {
      id: "app-1",
      owner: { id: "owner-1" },
    } as never),
    Effect.provideService(GuildsCache, caches.guilds as never),
    Effect.provideService(ChannelsCache, caches.channels as never),
    Effect.provideService(RolesCache, caches.roles as never),
    Effect.provideService(MembersCache, caches.members as never),
    Effect.provideService(DiscordREST, rest as never),
  ) as Effect.Effect<A, E, never>;

  return Effect.runPromise(Effect.scoped(provided));
};

const makeClient = RpcTest.makeClient(DiscordRpcs, { flatten: true });

describe("DiscordRpcs handlers", () => {
  it("validates interaction response callback variants by Discord callback type", () => {
    const decode = Schema.decodeUnknownExit(DiscordInteractionResponseRequestSchema);

    expect(Exit.isFailure(decode({ type: 8 }))).toBe(true);
    expect(Exit.isFailure(decode({ type: 9 }))).toBe(true);
    expect(Exit.isFailure(decode({ type: 1, data: {} }))).toBe(true);
    expect(Exit.isFailure(decode({ type: 10, data: {} }))).toBe(true);
    expect(Exit.isFailure(decode({ type: 12, data: {} }))).toBe(true);
    expect(Exit.isFailure(decode({ type: 13 }))).toBe(true);
    expect(Exit.isFailure(decode({ type: 8, data: {} }))).toBe(true);

    expect(Exit.isSuccess(decode({ type: 1 }))).toBe(true);
    expect(Exit.isSuccess(decode({ type: 8, data: { choices: [] } }))).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: 9,
          data: {
            custom_id: "modal-1",
            title: "Modal",
            components: [],
          },
        }),
      ),
    ).toBe(true);
    expect(Exit.isSuccess(decode({ type: 10 }))).toBe(true);
    expect(Exit.isSuccess(decode({ type: 12 }))).toBe(true);
    expect(Exit.isSuccess(decode({ type: 13, data: { eligible: true } }))).toBe(true);
  });

  it("rejects unsupported callback data for variants with no data", () => {
    const decode = Schema.decodeUnknownExit(DiscordInteractionResponseRequestSchema);

    expect(
      Exit.isFailure(
        decode({
          type: 6,
          data: {
            content: "not valid for deferred update",
          },
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decode({
          type: 5,
          data: null,
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decode({
          type: 5,
          data: {
            content: "not valid for deferred reply",
          },
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: 5,
          data: {
            flags: 64,
          },
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: 7,
          data: {
            content: "valid update",
          },
        }),
      ),
    ).toBe(true);
  });

  it("cache.getMember returns { value }", async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        return yield* client("cache.getMember", {
          params: { parentId: "guild-1", resourceId: "member-1" },
        });
      }),
    );

    expect(result).toEqual({ value: member });
  });

  it("cache.getMember converts cache misses to CacheNotFoundError", async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        return yield* Effect.result(
          client("cache.getMember", {
            params: { parentId: "guild-1", resourceId: "member-1" },
          }),
        );
      }),
      makeCaches({ memberResult: Effect.fail(cacheMiss) }),
    );

    Result.match(result, {
      onFailure: (error) => expect(error._tag).toBe("CacheNotFoundError"),
      onSuccess: () => expect.fail("Expected cache.getMember to fail"),
    });
  });

  it("cache.getGuildSize returns { size }", async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        return yield* client("cache.getGuildSize", undefined);
      }),
    );

    expect(result).toEqual({ size: 2 });
  });

  it("application.getApplication returns { ownerId }", async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        return yield* client("application.getApplication", undefined);
      }),
    );

    expect(result).toEqual({ ownerId: "owner-1" });
  });

  it("bot.sendMessage calls Discord REST createMessage", async () => {
    const calls: Array<ReadonlyArray<unknown>> = [];
    const result = await run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        return yield* client("bot.sendMessage", {
          params: { channelId: "channel-1" },
          payload: { content: "hello" },
        });
      }),
      makeCaches(),
      makeRest({
        createMessage: (...args) => {
          calls.push(args);
          return Effect.succeed({
            id: "message-1",
            channel_id: "channel-1",
            content: "hello",
          });
        },
      }),
    );

    expect(calls).toEqual([
      [
        "channel-1",
        {
          content: "hello",
          allowed_mentions: { parse: [] },
        },
      ],
    ]);
    expect(result).toEqual({ id: "message-1", channel_id: "channel-1", content: "hello" });
  });

  it("bot.createPin calls Discord REST createPin", async () => {
    const calls: Array<ReadonlyArray<unknown>> = [];
    const result = await run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        return yield* client("bot.createPin", {
          params: { channelId: "channel-1", messageId: "message-1" },
        });
      }),
      makeCaches(),
      makeRest({
        createPin: (...args) => {
          calls.push(args);
          return Effect.succeed({});
        },
      }),
    );

    expect(calls).toEqual([["channel-1", "message-1"]]);
    expect(result).toEqual({});
  });

  it("bot.addGuildMemberRole calls Discord REST addGuildMemberRole", async () => {
    const calls: Array<ReadonlyArray<unknown>> = [];
    const result = await run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        return yield* client("bot.addGuildMemberRole", {
          params: { guildId: "guild-1", userId: "user-1", roleId: "role-1" },
        });
      }),
      makeCaches(),
      makeRest({
        addGuildMemberRole: (...args) => {
          calls.push(args);
          return Effect.succeed({});
        },
      }),
    );

    expect(calls).toEqual([["guild-1", "user-1", "role-1"]]);
    expect(result).toEqual({});
  });

  it("bot.createInteractionResponse requests a response body by default", async () => {
    const calls: Array<ReadonlyArray<unknown>> = [];
    const result = await run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        return yield* client("bot.createInteractionResponse", {
          interactionId: "interaction-1",
          interactionToken: "token-1",
          payload: { type: 4, data: { content: "hello" } },
        });
      }),
      makeCaches(),
      makeRest({
        createInteractionResponse: (...args) => {
          calls.push(args);
          return Effect.succeed({
            interaction: { id: "interaction-1", type: 2 },
          });
        },
      }),
    );

    expect(calls).toEqual([
      [
        "interaction-1",
        "token-1",
        {
          params: { with_response: true },
          payload: {
            type: 4,
            data: {
              content: "hello",
              allowed_mentions: { parse: [] },
            },
          },
        },
      ],
    ]);
    expect(result).toEqual({ interaction: { id: "interaction-1", type: 2 } });
  });

  it("bot.createInteractionResponse strips response resources from the RPC result", async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        return yield* client("bot.createInteractionResponse", {
          interactionId: "interaction-1",
          interactionToken: "token-1",
          payload: { type: 4, data: { content: "hello" } },
        });
      }),
    );

    expect(result).toEqual({ interaction: { id: "interaction-1", type: 2 } });
  });

  it("bot.updateMessage updates a channel message", async () => {
    const calls: Array<ReadonlyArray<unknown>> = [];
    const result = await run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        return yield* client("bot.updateMessage", {
          params: { channelId: "channel-1", messageId: "message-1" },
          payload: { content: "updated" },
        });
      }),
      makeCaches(),
      makeRest({
        updateMessage: (...args) => {
          calls.push(args);
          return Effect.succeed({
            id: "message-1",
            channel_id: "channel-1",
            content: "updated",
          });
        },
      }),
    );

    expect(calls).toEqual([
      [
        "channel-1",
        "message-1",
        {
          content: "updated",
          allowed_mentions: { parse: [] },
        },
      ],
    ]);
    expect(result).toEqual({ id: "message-1", channel_id: "channel-1", content: "updated" });
  });

  it("bot.updateOriginalInteractionResponse updates the original webhook message", async () => {
    const calls: Array<ReadonlyArray<unknown>> = [];
    const result = await run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        return yield* client("bot.updateOriginalInteractionResponse", {
          params: { interactionToken: "token-1" },
          payload: { content: "updated" },
        });
      }),
      makeCaches(),
      makeRest({
        updateOriginalWebhookMessage: (...args) => {
          calls.push(args);
          return Effect.succeed({
            id: "message-1",
            channel_id: "channel-1",
            content: "updated",
          });
        },
      }),
    );

    expect(calls).toEqual([
      [
        "app-1",
        "token-1",
        {
          payload: {
            content: "updated",
            allowed_mentions: { parse: [] },
          },
        },
      ],
    ]);
    expect(result).toEqual({ id: "message-1", channel_id: "channel-1", content: "updated" });
  });

  it("bot.createInteractionResponse converts malformed REST responses to a typed error", async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        return yield* Effect.result(
          client("bot.createInteractionResponse", {
            interactionId: "interaction-1",
            interactionToken: "token-1",
            payload: { type: 1 },
          }),
        );
      }),
      makeCaches(),
      makeRest({
        createInteractionResponse: () => Effect.succeed(null),
      }),
    );

    Result.match(result, {
      onFailure: (error) => {
        expect(error._tag).toBe("DiscordBotUpstreamError");
        expect(error.status).toBeUndefined();
      },
      onSuccess: () => expect.fail("Expected bot.createInteractionResponse to fail"),
    });
  });

  it("bot REST errors map Discord client statuses to non-502 RPC errors", async () => {
    for (const [status, tag] of [
      [401, "DiscordBotUnauthorizedError"],
      [403, "DiscordBotForbiddenError"],
      [429, "DiscordBotRateLimitedError"],
    ] as const) {
      const result = await run(
        Effect.gen(function* () {
          const client = yield* makeClient;
          return yield* Effect.result(
            client("bot.sendMessage", {
              params: { channelId: "channel-1" },
              payload: { content: "hello" },
            }),
          );
        }),
        makeCaches(),
        makeRest({
          createMessage: () =>
            Effect.fail({
              response: { status },
              data: { message: "Discord REST error" },
            }),
        }),
      );

      Result.match(result, {
        onFailure: (error) => {
          expect(error._tag).toBe(tag);
          expect(error.status).toBe(status);
        },
        onSuccess: () => expect.fail("Expected bot.sendMessage to fail"),
      });
    }
  });

  it("bot write endpoints suppress explicit broad mentions", async () => {
    const calls: Array<ReadonlyArray<unknown>> = [];
    await run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        yield* client("bot.sendMessage", {
          params: { channelId: "channel-1" },
          payload: {
            content: "@everyone",
            allowed_mentions: { parse: ["everyone"] },
          },
        });
        yield* client("bot.createInteractionResponse", {
          interactionId: "interaction-1",
          interactionToken: "token-1",
          payload: {
            type: 4,
            data: {
              content: "@everyone",
              allowed_mentions: { parse: ["everyone"] },
            },
          },
        });
        yield* client("bot.updateMessage", {
          params: { channelId: "channel-1", messageId: "message-1" },
          payload: {
            content: "@everyone",
            allowed_mentions: { parse: ["everyone"] },
          },
        });
        yield* client("bot.updateOriginalInteractionResponse", {
          params: { interactionToken: "token-1" },
          payload: {
            content: "@everyone",
            allowed_mentions: { parse: ["everyone"] },
          },
        });
      }),
      makeCaches(),
      makeRest({
        createMessage: (...args) => {
          calls.push(args);
          return Effect.succeed({ id: "message-1", channel_id: "channel-1" });
        },
        createInteractionResponse: (...args) => {
          calls.push(args);
          return Effect.succeed({ interaction: { id: "interaction-1", type: 2 } });
        },
        updateMessage: (...args) => {
          calls.push(args);
          return Effect.succeed({ id: "message-1", channel_id: "channel-1" });
        },
        updateOriginalWebhookMessage: (...args) => {
          calls.push(args);
          return Effect.succeed({ id: "message-1", channel_id: "channel-1" });
        },
      }),
    );

    expect(calls).toEqual([
      [
        "channel-1",
        {
          content: "@everyone",
          allowed_mentions: { parse: [] },
        },
      ],
      [
        "interaction-1",
        "token-1",
        {
          params: { with_response: true },
          payload: {
            type: 4,
            data: {
              content: "@everyone",
              allowed_mentions: { parse: [] },
            },
          },
        },
      ],
      [
        "channel-1",
        "message-1",
        {
          content: "@everyone",
          allowed_mentions: { parse: [] },
        },
      ],
      [
        "app-1",
        "token-1",
        {
          payload: {
            content: "@everyone",
            allowed_mentions: { parse: [] },
          },
        },
      ],
    ]);
  });

  it("bot.createInteractionResponse does not add message fields to non-message callbacks", async () => {
    const calls: Array<ReadonlyArray<unknown>> = [];
    await run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        yield* client("bot.createInteractionResponse", {
          interactionId: "interaction-1",
          interactionToken: "token-1",
          payload: { type: 5 },
        });
      }),
      makeCaches(),
      makeRest({
        createInteractionResponse: (...args) => {
          calls.push(args);
          return Effect.succeed({ interaction: { id: "interaction-1", type: 2 } });
        },
      }),
    );

    expect(calls).toEqual([
      [
        "interaction-1",
        "token-1",
        {
          params: { with_response: true },
          payload: { type: 5 },
        },
      ],
    ]);
  });

  it("bot.createInteractionResponse does not add allowed_mentions to deferred callback data", async () => {
    const calls: Array<ReadonlyArray<unknown>> = [];
    await run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        yield* client("bot.createInteractionResponse", {
          interactionId: "interaction-1",
          interactionToken: "token-1",
          payload: { type: 5, data: { flags: 64 } },
        });
      }),
      makeCaches(),
      makeRest({
        createInteractionResponse: (...args) => {
          calls.push(args);
          return Effect.succeed({ interaction: { id: "interaction-1", type: 2 } });
        },
      }),
    );

    expect(calls).toEqual([
      [
        "interaction-1",
        "token-1",
        {
          params: { with_response: true },
          payload: { type: 5, data: { flags: 64 } },
        },
      ],
    ]);
  });
});
