import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  looksLikeTeamSubmissionContent,
  makeTeamSubmissionDispatchPayload,
  makeTeamSubmissionMessageHandler,
} from "./teamSubmissionMonitor";

const message = {
  id: "message-1",
  type: 0,
  channel_id: "channel-1",
  guild_id: "guild-1",
  content: "ff: 150/700",
  author: {
    id: "user-1",
    username: "alice",
    global_name: "Alice",
    bot: false,
  },
  member: { nick: "Sheet Alice" },
  edited_timestamp: null,
  pinned: false,
} as const;

describe("looksLikeTeamSubmissionContent", () => {
  it.each([
    "150/700",
    "ff 150/700",
    "H: 100/650",
    "main: Cool Team",
    "||alt 150/740||",
    "1. 150/690 325k",
    "### **4* heal:** 80/650",
  ])("accepts team-shaped content: %s", (content) => {
    expect(looksLikeTeamSubmissionContent(content)).toBe(true);
  });

  it.each([
    "will do!",
    "added bp",
    "updates :]",
    "main reason",
    "heal up",
    "oshi: Rin",
    "> ff: 150/700",
    "```\nff: 150/700\n```",
  ])("rejects conversation and examples: %s", (content) => {
    expect(looksLikeTeamSubmissionContent(content)).toBe(false);
  });

  it("does not leave the scanner inside a same-line code fence", () => {
    expect(looksLikeTeamSubmissionContent(["```ff: 140/700```", "ff: 150/700"].join("\n"))).toBe(
      true,
    );
  });
});

describe("makeTeamSubmissionDispatchPayload", () => {
  it("builds create and update payloads for unpinned team messages", () => {
    expect(makeTeamSubmissionDispatchPayload(message)).toMatchObject({
      dispatchRequestId: "discord-team-submission:guild-1:channel-1:message-1:create",
      authorDisplayName: "Sheet Alice",
      content: "ff: 150/700",
    });
    expect(
      makeTeamSubmissionDispatchPayload({
        ...message,
        edited_timestamp: "2026-07-21T08:00:00.000Z",
      }),
    ).toMatchObject({
      dispatchRequestId:
        "discord-team-submission:guild-1:channel-1:message-1:2026-07-21T08:00:00.000Z",
    });
    expect(makeTeamSubmissionDispatchPayload({ ...message, pinned: undefined })).not.toBeNull();
  });

  it("rejects pinned, bot-authored, direct, empty, and conversational messages", () => {
    expect(makeTeamSubmissionDispatchPayload({ ...message, pinned: true })).toBeNull();
    expect(
      makeTeamSubmissionDispatchPayload({
        ...message,
        author: { ...message.author, bot: true },
      }),
    ).toBeNull();
    expect(makeTeamSubmissionDispatchPayload({ ...message, guild_id: null })).toBeNull();
    expect(makeTeamSubmissionDispatchPayload({ ...message, content: " " })).toBeNull();
    expect(makeTeamSubmissionDispatchPayload({ ...message, content: "will do!" })).toBeNull();
  });
});

describe("makeTeamSubmissionMessageHandler", () => {
  const makeHandler = (enabled: boolean) => {
    const availabilityLookups: Array<readonly [string, string]> = [];
    const dispatches: unknown[] = [];
    const handleMessage = makeTeamSubmissionMessageHandler({
      clientId: "discord-main",
      isTeamSubmissionEnabled: (workspaceId, conversationId) =>
        Effect.sync(() => {
          availabilityLookups.push([workspaceId, conversationId]);
          return enabled;
        }),
      dispatch: (payload) =>
        Effect.sync(() => {
          dispatches.push(payload);
        }),
    });
    return { availabilityLookups, dispatches, handleMessage };
  };

  it.effect("dispatches team-shaped messages when the feature is enabled", () =>
    Effect.gen(function* () {
      const { availabilityLookups, dispatches, handleMessage } = makeHandler(true);

      yield* handleMessage(message);

      expect(availabilityLookups).toEqual([["guild-1", "channel-1"]]);
      expect(dispatches).toHaveLength(1);
    }),
  );

  it.effect("does not dispatch team-shaped messages when the feature is disabled", () =>
    Effect.gen(function* () {
      const { availabilityLookups, dispatches, handleMessage } = makeHandler(false);

      yield* handleMessage(message);

      expect(availabilityLookups).toEqual([["guild-1", "channel-1"]]);
      expect(dispatches).toEqual([]);
    }),
  );

  it.effect("does not look up availability for messages without team shape", () =>
    Effect.gen(function* () {
      const { availabilityLookups, dispatches, handleMessage } = makeHandler(true);

      yield* handleMessage({ ...message, content: "will do!" });

      expect(availabilityLookups).toEqual([]);
      expect(dispatches).toEqual([]);
    }),
  );

  it.effect("does not throw or dispatch for malformed events", () =>
    Effect.gen(function* () {
      const { availabilityLookups, dispatches, handleMessage } = makeHandler(true);

      yield* handleMessage({});

      expect(availabilityLookups).toEqual([]);
      expect(dispatches).toEqual([]);
    }),
  );

  it.live("does not dispatch when the availability lookup fails", () =>
    Effect.gen(function* () {
      const dispatches: unknown[] = [];
      const handleMessage = makeTeamSubmissionMessageHandler({
        clientId: "discord-main",
        isTeamSubmissionEnabled: () => Effect.fail("lookup failed"),
        dispatch: (payload) =>
          Effect.sync(() => {
            dispatches.push(payload);
          }),
      });

      yield* handleMessage(message);

      expect(dispatches).toEqual([]);
    }),
  );

  it.live("retries a transient availability failure", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const dispatches: unknown[] = [];
      const handleMessage = makeTeamSubmissionMessageHandler({
        clientId: "discord-main",
        isTeamSubmissionEnabled: () =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1 ? Effect.fail("lookup failed") : Effect.succeed(true);
          }),
        dispatch: (payload) =>
          Effect.sync(() => {
            dispatches.push(payload);
          }),
      });

      yield* handleMessage(message);

      expect(attempts).toBe(2);
      expect(dispatches).toHaveLength(1);
    }),
  );

  it.live("does not reject when workflow dispatch fails", () =>
    Effect.gen(function* () {
      const handleMessage = makeTeamSubmissionMessageHandler({
        clientId: "discord-main",
        isTeamSubmissionEnabled: () => Effect.succeed(true),
        dispatch: () => Effect.fail("dispatch failed"),
      });

      yield* handleMessage(message);
    }),
  );

  it.live("retries a transient workflow dispatch failure", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const handleMessage = makeTeamSubmissionMessageHandler({
        clientId: "discord-main",
        isTeamSubmissionEnabled: () => Effect.succeed(true),
        dispatch: () =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1 ? Effect.fail("dispatch failed") : Effect.void;
          }),
      });

      yield* handleMessage(message);

      expect(attempts).toBe(2);
    }),
  );
});
