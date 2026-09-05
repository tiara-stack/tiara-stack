import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  makeSlotsRefreshButtonMessageHandler,
  makeSlotsRefreshButtonWorkflowRequest,
} from "./slotSticky";

const message = {
  id: "message-1",
  type: 0,
  channel_id: "channel-1",
  guild_id: "guild-1",
  author: { bot: false },
} as const;

describe("makeSlotsRefreshButtonWorkflowRequest", () => {
  it("builds a stable channel refresh request for human guild messages", () => {
    const request = makeSlotsRefreshButtonWorkflowRequest(message);

    expect(request?.input).toMatchObject({
      workspaceId: "guild-1",
      conversationId: "channel-1",
      triggerMessageId: "message-1",
    });
    expect(request?.invocationId).toBe(
      makeSlotsRefreshButtonWorkflowRequest(message)?.invocationId,
    );
    expect(
      makeSlotsRefreshButtonWorkflowRequest({ ...message, id: "message-2" })?.invocationId,
    ).not.toBe(request?.invocationId);
    expect(makeSlotsRefreshButtonWorkflowRequest({ ...message, type: 19 })).not.toBeNull();
  });

  it.each([
    { ...message, author: { bot: true } },
    { ...message, guild_id: null },
    { ...message, guild_id: "" },
    { ...message, type: 1 },
  ])("ignores non-human channel events", (event) => {
    expect(makeSlotsRefreshButtonWorkflowRequest(event)).toBeNull();
  });
});

describe("makeSlotsRefreshButtonMessageHandler", () => {
  it.effect("enqueues only when the channel has an active slot button", () =>
    Effect.gen(function* () {
      const lookups: Array<readonly [string, string]> = [];
      const dispatches: unknown[] = [];
      const handleMessage = makeSlotsRefreshButtonMessageHandler({
        clientId: "discord-main",
        hasSlotButton: (workspaceId, conversationId) =>
          Effect.sync(() => {
            lookups.push([workspaceId, conversationId]);
            return true;
          }),
        enqueue: (input, invocationId) =>
          Effect.sync(() => {
            dispatches.push({ input, invocationId });
          }),
      });

      yield* handleMessage(message);

      expect(lookups).toEqual([["guild-1", "channel-1"]]);
      expect(dispatches).toHaveLength(1);
    }),
  );

  it.effect("does not enqueue when the channel has no active slot button", () =>
    Effect.gen(function* () {
      const dispatches: unknown[] = [];
      const handleMessage = makeSlotsRefreshButtonMessageHandler({
        clientId: "discord-main",
        hasSlotButton: () => Effect.succeed(false),
        enqueue: (input, invocationId) =>
          Effect.sync(() => {
            dispatches.push({ input, invocationId });
          }),
      });

      yield* handleMessage(message);

      expect(dispatches).toEqual([]);
    }),
  );

  it.effect("ignores malformed events and bot messages", () =>
    Effect.gen(function* () {
      let lookups = 0;
      let dispatches = 0;
      const handleMessage = makeSlotsRefreshButtonMessageHandler({
        clientId: "discord-main",
        hasSlotButton: () =>
          Effect.sync(() => {
            lookups += 1;
            return true;
          }),
        enqueue: () =>
          Effect.sync(() => {
            dispatches += 1;
          }),
      });

      yield* handleMessage({});
      yield* handleMessage({ ...message, author: { bot: true } });
      yield* handleMessage({ ...message, guild_id: "" });

      expect(lookups).toBe(0);
      expect(dispatches).toBe(0);
    }),
  );
});
