import { describe, expect, it } from "@effect/vitest";
import { makeGuildWelcomeWorkflowRequest } from "./guildWelcome";

describe("makeGuildWelcomeWorkflowRequest", () => {
  const startupEpochMs = Date.parse("2026-05-31T12:00:00.000Z");

  it("builds a payload for a recent guild join", () => {
    const request = makeGuildWelcomeWorkflowRequest(
      {
        id: "guild-1",
        name: "Guild One",
        joined_at: "2026-05-31T11:55:00.000Z",
        system_channel_id: "system-channel",
      },
      startupEpochMs,
    );

    expect(request).not.toBeNull();
    expect(request?.input).toEqual({
      workspaceId: "guild-1",
      workspaceName: "Guild One",
      joinedAt: new Date("2026-05-31T11:55:00.000Z"),
      systemConversationId: "system-channel",
    });
    expect(request?.invocationId).toBe(
      makeGuildWelcomeWorkflowRequest(
        {
          id: "guild-1",
          name: "Renamed guild",
          joined_at: "2026-05-31T11:55:00.000Z",
        },
        startupEpochMs,
      )?.invocationId,
    );
  });

  it("ignores startup replay, unavailable guilds, and invalid join timestamps", () => {
    expect(
      makeGuildWelcomeWorkflowRequest(
        {
          id: "guild-1",
          name: "Guild One",
          joined_at: "2026-05-31T11:49:59.999Z",
        },
        startupEpochMs,
      ),
    ).toBeNull();
    expect(
      makeGuildWelcomeWorkflowRequest(
        {
          id: "guild-1",
          name: "Guild One",
          joined_at: "2026-05-31T11:55:00.000Z",
          unavailable: true,
        },
        startupEpochMs,
      ),
    ).toBeNull();
    expect(
      makeGuildWelcomeWorkflowRequest(
        {
          id: "guild-1",
          name: "Guild One",
          joined_at: "not-a-date",
        },
        startupEpochMs,
      ),
    ).toBeNull();
  });
});
