import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  looksLikeTeamSubmissionContent,
  makeTeamSubmissionMessageHandler,
  makeTeamSubmissionWorkflowRequest,
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

describe("makeTeamSubmissionWorkflowRequest", () => {
  it("builds stable create and update requests for unpinned team messages", () => {
    const created = makeTeamSubmissionWorkflowRequest(message);
    const edited = makeTeamSubmissionWorkflowRequest({
      ...message,
      edited_timestamp: "2026-07-21T08:00:00.000Z",
    });

    expect(created?.input).toMatchObject({
      authorDisplayName: "Sheet Alice",
      content: "ff: 150/700",
      sourceMessage: {
        conversation: {
          workspace: {
            client: { platform: "discord", clientId: "discord-main" },
            workspaceId: "guild-1",
          },
          conversationId: "channel-1",
        },
        messageId: "message-1",
      },
    });
    expect(created?.invocationId).toBe(makeTeamSubmissionWorkflowRequest(message)?.invocationId);
    expect(edited?.input.editedAt).toEqual(new Date("2026-07-21T08:00:00.000Z"));
    expect(edited?.invocationId).not.toBe(created?.invocationId);
    expect(makeTeamSubmissionWorkflowRequest({ ...message, pinned: undefined })).not.toBeNull();
  });

  it("rejects pinned, bot-authored, direct, empty, and conversational messages", () => {
    expect(makeTeamSubmissionWorkflowRequest({ ...message, pinned: true })).toBeNull();
    expect(
      makeTeamSubmissionWorkflowRequest({
        ...message,
        author: { ...message.author, bot: true },
      }),
    ).toBeNull();
    expect(makeTeamSubmissionWorkflowRequest({ ...message, guild_id: null })).toBeNull();
    expect(makeTeamSubmissionWorkflowRequest({ ...message, content: " " })).toBeNull();
    expect(makeTeamSubmissionWorkflowRequest({ ...message, content: "will do!" })).toBeNull();
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
      enqueue: (input, invocationId) =>
        Effect.sync(() => {
          dispatches.push({ input, invocationId });
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
        enqueue: (input, invocationId) =>
          Effect.sync(() => {
            dispatches.push({ input, invocationId });
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
        enqueue: (input, invocationId) =>
          Effect.sync(() => {
            dispatches.push({ input, invocationId });
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
        enqueue: () => Effect.fail("enqueue failed"),
      });

      yield* handleMessage(message);
    }),
  );

  it.live("retries a transient workflow dispatch failure", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const invocationIds: string[] = [];
      const handleMessage = makeTeamSubmissionMessageHandler({
        clientId: "discord-main",
        isTeamSubmissionEnabled: () => Effect.succeed(true),
        enqueue: (_input, invocationId) =>
          Effect.suspend(() => {
            invocationIds.push(invocationId);
            attempts += 1;
            return attempts === 1 ? Effect.fail("enqueue failed") : Effect.void;
          }),
      });

      yield* handleMessage(message);

      expect(attempts).toBe(2);
      expect(invocationIds[0]).toBe(invocationIds[1]);
    }),
  );
});
