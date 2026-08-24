import { describe, expect, it } from "@effect/vitest";
import { makeUpdateAnnouncementWorkflowRequests, updateAnnouncements } from "./updateAnnouncements";

describe("makeUpdateAnnouncementWorkflowRequests", () => {
  it("builds stable workflow requests for announcements after the bot joined", () => {
    const requests = makeUpdateAnnouncementWorkflowRequests({
      id: "guild-1",
      name: "Guild One",
      joined_at: "2026-06-04T16:59:59.999Z",
      system_channel_id: "system-channel",
    });

    expect(requests.map(({ input }) => input)).toEqual([
      {
        workspaceId: "guild-1",
        workspaceName: "Guild One",
        joinedAt: new Date("2026-06-04T16:59:59.999Z"),
        systemConversationId: "system-channel",
        announcement: {
          ...updateAnnouncements[0],
          publishedAt: new Date(updateAnnouncements[0].publishedAt),
        },
      },
      {
        workspaceId: "guild-1",
        workspaceName: "Guild One",
        joinedAt: new Date("2026-06-04T16:59:59.999Z"),
        systemConversationId: "system-channel",
        announcement: {
          ...updateAnnouncements[1],
          publishedAt: new Date(updateAnnouncements[1].publishedAt),
        },
      },
      {
        workspaceId: "guild-1",
        workspaceName: "Guild One",
        joinedAt: new Date("2026-06-04T16:59:59.999Z"),
        systemConversationId: "system-channel",
        announcement: {
          ...updateAnnouncements[2],
          publishedAt: new Date(updateAnnouncements[2].publishedAt),
        },
      },
    ]);
    expect(requests[0]?.invocationId).toBe(
      makeUpdateAnnouncementWorkflowRequests({
        id: "guild-1",
        name: "Renamed Guild",
        joined_at: "2026-06-04T16:59:59.999Z",
      })[0]?.invocationId,
    );
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
      makeUpdateAnnouncementWorkflowRequests(
        {
          id: "guild-1",
          name: "Guild One",
          joined_at: "2026-06-04T16:00:00.000Z",
        },
        announcements,
      ).map((request) => request.input.announcement.id),
    ).toEqual(["first", "second"]);
  });

  it("skips announcements dated before or equal to the guild join timestamp", () => {
    const announcements = [
      {
        id: "joined-at-announcement",
        publishedAt: "2026-06-04T17:00:00.000Z",
        title: "Joined at announcement",
        description: "Joined at update",
      },
    ];

    expect(
      makeUpdateAnnouncementWorkflowRequests(
        {
          id: "guild-1",
          name: "Guild One",
          joined_at: announcements[0]!.publishedAt,
        },
        announcements,
      ),
    ).toEqual([]);
  });

  it("ignores unavailable guilds and invalid join timestamps", () => {
    expect(
      makeUpdateAnnouncementWorkflowRequests({
        id: "guild-1",
        name: "Guild One",
        joined_at: "2026-06-04T16:59:59.999Z",
        unavailable: true,
      }),
    ).toEqual([]);
    expect(
      makeUpdateAnnouncementWorkflowRequests({
        id: "guild-1",
        name: "Guild One",
        joined_at: "not-a-date",
      }),
    ).toEqual([]);
  });
});
