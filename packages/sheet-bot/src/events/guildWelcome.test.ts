import { describe, expect, it } from "@effect/vitest";
import { makeGuildWelcomeDispatchPayload } from "./guildWelcome";

describe("makeGuildWelcomeDispatchPayload", () => {
  const startupEpochMs = Date.parse("2026-05-31T12:00:00.000Z");

  it("builds a payload for a recent guild join", () => {
    expect(
      makeGuildWelcomeDispatchPayload(
        {
          id: "guild-1",
          name: "Guild One",
          joined_at: "2026-05-31T11:55:00.000Z",
          system_channel_id: "system-channel",
        },
        startupEpochMs,
      ),
    ).toEqual({
      dispatchRequestId: "discord-guild-create:guild-1:2026-05-31T11:55:00.000Z",
      guildId: "guild-1",
      guildName: "Guild One",
      joinedAt: "2026-05-31T11:55:00.000Z",
      systemChannelId: "system-channel",
    });
  });

  it("ignores startup replay, unavailable guilds, and invalid join timestamps", () => {
    expect(
      makeGuildWelcomeDispatchPayload(
        {
          id: "guild-1",
          name: "Guild One",
          joined_at: "2026-05-31T11:49:59.999Z",
        },
        startupEpochMs,
      ),
    ).toBeNull();
    expect(
      makeGuildWelcomeDispatchPayload(
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
      makeGuildWelcomeDispatchPayload(
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
