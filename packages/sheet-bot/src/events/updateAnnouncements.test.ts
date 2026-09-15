import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber, Logger } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { makeSheetWorkflowHttpClients } from "sheet-workflow-http-client";
import {
  makeUpdateAnnouncementsHandler,
  makeUpdateAnnouncementWorkflowRequests,
  makeUpdateAnnouncements,
  updateAnnouncements,
} from "./updateAnnouncements";
import { makeSheetWorkflowHttpClientShape } from "../services/sheetWorkflowHttp";

describe("makeUpdateAnnouncementWorkflowRequests", () => {
  // fallow-ignore-next-line complexity
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
    expect(pathPrefixedAnnouncements[7]?.description).toContain("/slot remove");
    expect(pathPrefixedAnnouncements[8]?.description).toContain("/feature_flag");
    expect(pathPrefixedAnnouncements[8]?.description).toContain(
      "https://host/sheetweb/docs/tiarabot/command-reference",
    );
    expect(pathPrefixedAnnouncements[9]?.description).toContain("/sheet import");
    expect(pathPrefixedAnnouncements[9]?.description).toContain(
      "https://host/sheetweb/docs/sheetweb/sheet-configuration",
    );
    expect(pathPrefixedAnnouncements[10]?.description).toContain("/checkin saved");
    expect(pathPrefixedAnnouncements[10]?.description).toContain(
      "https://host/sheetweb/docs/tiarabot/monitors/check-in-messages",
    );
    expect(pathPrefixedAnnouncements[11]?.description).toContain("/fillers list");
    expect(pathPrefixedAnnouncements[11]?.description).toContain(
      "raw Discord mention tokens in a code block",
    );
    expect(pathPrefixedAnnouncements[11]?.description).toContain(
      "Large results or unresolved names containing code fences use a fillers.txt attachment",
    );
    expect(pathPrefixedAnnouncements[11]?.description).toContain("fillers.txt");
    expect(pathPrefixedAnnouncements[11]?.description).toContain(
      "https://host/sheetweb/docs/tiarabot/command-reference",
    );
    expect(pathPrefixedAnnouncements[12]?.description).toContain(
      "/server set announcement_channel",
    );
    expect(pathPrefixedAnnouncements[12]?.description).toContain(
      "/server unset announcement_channel",
    );
    expect(pathPrefixedAnnouncements[12]?.description).toContain(
      "https://host/sheetweb/docs/tiarabot/monitors/update-announcements",
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
      {
        workspaceId: "guild-1",
        workspaceName: "Guild One",
        joinedAt: new Date("2026-06-04T16:59:59.999Z"),
        systemConversationId: "system-channel",
        announcement: {
          ...updateAnnouncements[6],
          publishedAt: new Date(updateAnnouncements[6].publishedAt),
        },
      },
      {
        workspaceId: "guild-1",
        workspaceName: "Guild One",
        joinedAt: new Date("2026-06-04T16:59:59.999Z"),
        systemConversationId: "system-channel",
        announcement: {
          ...updateAnnouncements[7],
          publishedAt: new Date(updateAnnouncements[7].publishedAt),
        },
      },
      {
        workspaceId: "guild-1",
        workspaceName: "Guild One",
        joinedAt: new Date("2026-06-04T16:59:59.999Z"),
        systemConversationId: "system-channel",
        announcement: {
          ...updateAnnouncements[8],
          publishedAt: new Date(updateAnnouncements[8].publishedAt),
        },
      },
      {
        workspaceId: "guild-1",
        workspaceName: "Guild One",
        joinedAt: new Date("2026-06-04T16:59:59.999Z"),
        systemConversationId: "system-channel",
        announcement: {
          ...updateAnnouncements[9],
          publishedAt: new Date(updateAnnouncements[9].publishedAt),
        },
      },
      {
        workspaceId: "guild-1",
        workspaceName: "Guild One",
        joinedAt: new Date("2026-06-04T16:59:59.999Z"),
        systemConversationId: "system-channel",
        announcement: {
          ...updateAnnouncements[10],
          publishedAt: new Date(updateAnnouncements[10].publishedAt),
        },
      },
      {
        workspaceId: "guild-1",
        workspaceName: "Guild One",
        joinedAt: new Date("2026-06-04T16:59:59.999Z"),
        systemConversationId: "system-channel",
        announcement: {
          ...updateAnnouncements[11],
          publishedAt: new Date(updateAnnouncements[11].publishedAt),
        },
      },
      {
        workspaceId: "guild-1",
        workspaceName: "Guild One",
        joinedAt: new Date("2026-06-04T16:59:59.999Z"),
        systemConversationId: "system-channel",
        announcement: {
          ...updateAnnouncements[12],
          publishedAt: new Date(updateAnnouncements[12].publishedAt),
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

describe("makeUpdateAnnouncementsHandler", () => {
  it.effect("lets the protected client own recovery and catches an exhausted enqueue", () => {
    const logMessages: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      logMessages.push(message);
    });

    return Effect.gen(function* () {
      const requestRecords: Array<{ readonly input: unknown; readonly invocationId: string }> = [];
      const userHttpClient = HttpClient.make(() => Effect.die("user principal was selected"));
      const serviceHttpClient = HttpClient.make((request) =>
        Effect.sync(() => {
          const payload =
            request.body._tag === "Uint8Array"
              ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
                  readonly input: unknown;
                  readonly invocationId: string;
                })
              : undefined;
          if (payload !== undefined) {
            requestRecords.push(payload);
          }
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }));
        }),
      );
      const protectedClient = makeSheetWorkflowHttpClientShape(
        makeSheetWorkflowHttpClients(userHttpClient, {
          baseUrl: "https://workflows.example.test",
        }),
        makeSheetWorkflowHttpClients(serviceHttpClient, {
          baseUrl: "https://workflows.example.test",
        }),
      );
      let enqueueCalls = 0;
      const handler = makeUpdateAnnouncementsHandler({
        clientId: "discord-main",
        announcements: [
          {
            id: "announcement-1",
            publishedAt: "2026-09-15T17:00:00.000Z",
            title: "Announcement",
            description: "Description",
          },
        ],
        enqueue: (input, options) => {
          enqueueCalls += 1;
          return protectedClient.enqueueAnnouncementsDeliverUpdate(input, options);
        },
      });
      const fiber = yield* handler({
        id: "guild-1",
        name: "Guild One",
        joined_at: "2026-09-15T16:55:00.000Z",
        system_channel_id: "system-channel",
      }).pipe(Effect.exit, Effect.forkChild);

      yield* TestClock.adjust(Duration.minutes(2));
      const exit = yield* Fiber.join(fiber);

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(enqueueCalls).toBe(1);
      expect(requestRecords).toHaveLength(26);
      expect(new Set(requestRecords.map(({ invocationId }) => invocationId)).size).toBe(1);
      expect(requestRecords[0]?.input).toEqual(requestRecords[25]?.input);
      expect(requestRecords[0]?.input).toMatchObject({
        workspaceId: "guild-1",
        workspaceName: "Guild One",
        systemConversationId: "system-channel",
        announcement: {
          id: "announcement-1",
        },
      });
      expect(
        logMessages.some((message) =>
          JSON.stringify(message).includes("Failed to enqueue update announcement workflow"),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([logger])));
  });
});
