// fallow-ignore-next-line unresolved-import
import { describe, expect, it } from "vitest";
import { makeUpdateAnnouncementDispatchPayloads, updateAnnouncements } from "./updateAnnouncements";

describe("makeUpdateAnnouncementDispatchPayloads", () => {
  it("builds a payload for an announcement after the bot joined", () => {
    expect(
      makeUpdateAnnouncementDispatchPayloads({
        id: "guild-1",
        name: "Guild One",
        joined_at: "2026-06-04T16:59:59.999Z",
        system_channel_id: "system-channel",
      }),
    ).toEqual([
      {
        dispatchRequestId: "discord-update-announcement:guild-1:update-announcements-2026-06-05",
        guildId: "guild-1",
        guildName: "Guild One",
        joinedAt: "2026-06-04T16:59:59.999Z",
        systemChannelId: "system-channel",
        announcement: updateAnnouncements[0],
      },
    ]);
  });

  it("keeps multiple payloads in announcement order", () => {
    const announcements = [
      {
        id: "first",
        publishedAt: "2026-06-04T17:00:00.000Z",
        title: "First",
        description: "First update",
      },
      {
        id: "second",
        publishedAt: "2026-06-05T17:00:00.000Z",
        title: "Second",
        description: "Second update",
      },
    ];

    expect(
      makeUpdateAnnouncementDispatchPayloads(
        {
          id: "guild-1",
          name: "Guild One",
          joined_at: "2026-06-04T16:00:00.000Z",
        },
        announcements,
      ).map((payload) => payload.announcement.id),
    ).toEqual(["first", "second"]);
  });

  it("skips announcements dated before or equal to the guild join timestamp", () => {
    expect(
      makeUpdateAnnouncementDispatchPayloads({
        id: "guild-1",
        name: "Guild One",
        joined_at: updateAnnouncements[0].publishedAt,
      }),
    ).toEqual([]);
  });

  it("ignores unavailable guilds and invalid join timestamps", () => {
    expect(
      makeUpdateAnnouncementDispatchPayloads({
        id: "guild-1",
        name: "Guild One",
        joined_at: "2026-06-04T16:59:59.999Z",
        unavailable: true,
      }),
    ).toEqual([]);
    expect(
      makeUpdateAnnouncementDispatchPayloads({
        id: "guild-1",
        name: "Guild One",
        joined_at: "not-a-date",
      }),
    ).toEqual([]);
  });
});
