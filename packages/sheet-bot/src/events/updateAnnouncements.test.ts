import { describe, expect, it } from "@effect/vitest";
import {
  makeUpdateAnnouncementWorkflowRequests,
  makeUpdateAnnouncements,
  updateAnnouncements,
} from "./updateAnnouncements";

describe("makeUpdateAnnouncementWorkflowRequests", () => {
  it("uses the configured SheetWeb host for dashboard announcement links", () => {
    const pathPrefixedAnnouncements = makeUpdateAnnouncements(new URL("https://host/sheetweb"));

    expect(
      makeUpdateAnnouncements(new URL("https://schedule.dev.theerapakg.moe"))[4]?.description,
    ).toContain("https://schedule.dev.theerapakg.moe/docs/sheetweb/navigation");
    expect(
      makeUpdateAnnouncements(new URL("https://schedule.theerapakg.moe"))[4]?.description,
    ).toContain("https://schedule.theerapakg.moe/docs/sheetweb/navigation");
    expect(pathPrefixedAnnouncements[3]?.description).toContain(
      "https://host/sheetweb/docs/sheetweb/sheet-configuration",
    );
    expect(pathPrefixedAnnouncements[4]?.description).toContain(
      "https://host/sheetweb/docs/sheetweb/navigation",
    );
    expect(pathPrefixedAnnouncements[5]?.description).toContain(
      "https://host/sheetweb/docs/tiarabot/monitors/post-schedule",
    );
  });

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
      {
        workspaceId: "guild-1",
        workspaceName: "Guild One",
        joinedAt: new Date("2026-06-04T16:59:59.999Z"),
        systemConversationId: "system-channel",
        announcement: {
          ...updateAnnouncements[3],
          publishedAt: new Date(updateAnnouncements[3].publishedAt),
        },
      },
      {
        workspaceId: "guild-1",
        workspaceName: "Guild One",
        joinedAt: new Date("2026-06-04T16:59:59.999Z"),
        systemConversationId: "system-channel",
        announcement: {
          ...updateAnnouncements[4],
          publishedAt: new Date(updateAnnouncements[4].publishedAt),
        },
      },
      {
        workspaceId: "guild-1",
        workspaceName: "Guild One",
        joinedAt: new Date("2026-06-04T16:59:59.999Z"),
        systemConversationId: "system-channel",
        announcement: {
          ...updateAnnouncements[5],
          publishedAt: new Date(updateAnnouncements[5].publishedAt),
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
