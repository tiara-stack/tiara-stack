import { describe, expect, it } from "@effect/vitest";
import { DateTime } from "effect";
import type { ServicesStatusResponse } from "sheet-ingress-api/sheet-apis-rpc";
import {
  areUpdateAnnouncementServicesHealthy,
  makeUpdateAnnouncementDispatchPayloads,
  updateAnnouncements,
} from "./updateAnnouncements";

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
        client: { platform: "discord", clientId: "discord-main" },
        dispatchRequestId: "discord-update-announcement:guild-1:update-announcements-2026-06-05",
        workspaceId: "guild-1",
        workspaceName: "Guild One",
        joinedAt: "2026-06-04T16:59:59.999Z",
        systemConversationId: "system-channel",
        announcement: updateAnnouncements[0],
      },
      {
        client: { platform: "discord", clientId: "discord-main" },
        dispatchRequestId: "discord-update-announcement:guild-1:auth-update-2026-06-12",
        workspaceId: "guild-1",
        workspaceName: "Guild One",
        joinedAt: "2026-06-04T16:59:59.999Z",
        systemConversationId: "system-channel",
        announcement: updateAnnouncements[1],
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
    const announcements = [
      {
        id: "joined-at-announcement",
        publishedAt: "2026-06-04T17:00:00.000Z",
        title: "Joined at announcement",
        description: "Joined at update",
      },
    ];

    expect(
      makeUpdateAnnouncementDispatchPayloads(
        {
          id: "guild-1",
          name: "Guild One",
          joined_at: announcements[0].publishedAt,
        },
        announcements,
      ),
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

describe("areUpdateAnnouncementServicesHealthy", () => {
  const makeStatus = (
    overallStatus: ServicesStatusResponse["overallStatus"],
    serviceStatuses: ReadonlyArray<ServicesStatusResponse["services"][number]["status"]>,
  ) => {
    const checkedAt = DateTime.makeUnsafe("2026-06-06T00:00:00.000Z");

    return {
      overallStatus,
      checkedAt,
      services: serviceStatuses.map((status, index) => ({
        name: `service-${index}`,
        url: `http://service-${index}/ready`,
        status,
        httpStatus: status === "ok" ? 200 : 503,
        latencyMs: 1,
        checkedAt,
        error: status === "ok" ? null : "HTTP 503",
      })),
    } satisfies ServicesStatusResponse;
  };

  it("requires the overall status and every dependency to be healthy", () => {
    expect(areUpdateAnnouncementServicesHealthy(makeStatus("ok", ["ok", "ok"]))).toBe(true);
    expect(areUpdateAnnouncementServicesHealthy(makeStatus("degraded", ["ok", "ok"]))).toBe(false);
    expect(areUpdateAnnouncementServicesHealthy(makeStatus("ok", ["ok", "down"]))).toBe(false);
  });
});
