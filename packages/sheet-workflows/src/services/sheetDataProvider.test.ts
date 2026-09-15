import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { renderPlainText } from "sheet-message-content/text";
import { AutoCheckinTestProvider } from "@/workflows/checkins/autoTestProvider";
import { UserScheduleProvider } from "@/workflows/schedules/provider";
import { WorkspaceId } from "sheet-workflow-contracts";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import {
  makeSheetDataProvider,
  resolveScheduleMonitorAccountId,
  resolveSchedulePlayerAccountIds,
  scheduleTimeReferenceMetadataForScheduleProjection,
  selectCheckinTemplate,
} from "./sheetDataProvider";

const timestampEpochMs = (value: unknown): ReadonlyArray<number> => {
  if (Array.isArray(value)) return value.flatMap(timestampEpochMs);
  if (typeof value !== "object" || value === null) return [];
  const part = value as {
    readonly type?: unknown;
    readonly epochMs?: unknown;
    readonly parts?: unknown;
  };
  if (part.type === "timestamp" && typeof part.epochMs === "number") return [part.epochMs];
  return Array.isArray(part.parts) ? timestampEpochMs(part.parts) : [];
};

describe("selected autonomous check-in generation", () => {
  it.effect("keeps the selected hour and timing across check-in and room-order generation", () =>
    Effect.gen(function* () {
      const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("workspace-1");
      const chapterStart = Date.UTC(2026, 8, 9, 3);
      const hour82Start = Date.UTC(2026, 8, 10, 12);
      const persistence = {
        workspaces: {
          getWorkspaceConfigByWorkspaceId: () =>
            Effect.succeed(
              Option.some({
                workspaceId,
                sheetId: "sheet-1",
                autoCheckin: true,
                monitorConversationId: null,
                createdAt: 0,
                updatedAt: 0,
                deletedAt: null,
              }),
            ),
          getWorkspaceConversations: () =>
            Effect.succeed([
              {
                workspaceId,
                conversationId: "conversation-main",
                name: "main",
                running: true,
                roleId: null,
                checkinConversationId: null,
                createdAt: 0,
                updatedAt: 0,
                deletedAt: null,
              },
            ]),
        },
        sheetConfiguration: {
          getSheetConfiguration: () =>
            Effect.succeed(
              Option.some({
                source: {
                  kind: "legacy",
                  binding: {
                    status: "bound",
                    expectedTitle: "Thee's Sheet Settings",
                    spreadsheetId: "sheet-1",
                    sheetId: 1,
                    scheduleTimeReference: {
                      kind: "chapter-start",
                      instantEpochMs: chapterStart,
                      hour: 49,
                    },
                  },
                },
              }),
            ),
        },
      } as unknown as TrustedSheetPersistence["Service"];
      const checkinProvider = {
        loadCheckin: () =>
          Effect.succeed({
            eventStartEpochMs: chapterStart,
            schedules: [
              { hour: 81, fills: [], overfillCount: 0, monitor: null },
              {
                hour: 82,
                fills: [{ accountId: "player-1", name: "Player" }],
                overfillCount: 0,
                monitor: null,
              },
            ],
          }),
        loadLegacyScheduleTimeReference: () => Effect.die("unused"),
        loadRoomOrder: () =>
          Effect.succeed({
            eventStartEpochMs: chapterStart,
            schedules: [
              {
                hour: 81,
                fills: [{ accountId: "player-0", name: "Previous Player", enc: false }],
                monitor: "Miku",
              },
              {
                hour: 82,
                fills: [{ accountId: "player-1", name: "Player", enc: false }],
                monitor: "Airi",
              },
            ],
            teamsByPlayerName: new Map([
              [
                "Player",
                [
                  {
                    playerId: "player-1",
                    playerName: "Player",
                    teamName: "Team",
                    tags: [],
                    lead: 1,
                    backline: 1,
                    talent: 1,
                    encable: false,
                    tierer: false,
                  },
                ],
              ],
            ]),
          }),
      } as typeof AutoCheckinTestProvider.Service;
      const scheduleProvider = {
        load: () => Effect.die("unused"),
        loadAll: () => Effect.die("unused"),
      } as typeof UserScheduleProvider.Service;
      const provider = makeSheetDataProvider(
        persistence,
        checkinProvider,
        scheduleProvider,
        "discord-main",
      );

      const generatedCheckin = yield* provider.generateCheckin({
        workspaceId,
        conversationName: "main",
        hour: 82,
        template: "{{mentionsString}} {{hourString}} {{timeStampString}}",
      });
      const generatedRoomOrder = yield* provider.generateRoomOrder({
        workspaceId,
        conversationName: "main",
        hour: 82,
      });

      expect(generatedCheckin.hour).toBe(82);
      expect(timestampEpochMs(generatedCheckin.initialMessage)).toEqual([hour82Start]);
      expect(generatedRoomOrder.hour).toBe(82);
      expect(timestampEpochMs(generatedRoomOrder.content)).toEqual([
        hour82Start,
        hour82Start + 3_600_000,
      ]);
      expect(generatedRoomOrder.monitor).toBe("Airi");
      expect(generatedRoomOrder.previousMonitor).toBe("Miku");
      expect(generatedRoomOrder.previousMonitorHistoryKnown).toBe(true);
      expect(renderPlainText(generatedRoomOrder.content)).toContain("Monis: In Airi · Out Miku");
    }),
  );
});

describe("resolveSchedulePlayerAccountIds", () => {
  it("resolves known schedule names and leaves unknown names unlinked", () => {
    expect(
      resolveSchedulePlayerAccountIds(
        [{ accountId: "account-theerie", name: "Theerie" }],
        ["Theerie", "Missing"],
      ),
    ).toEqual(["account-theerie", null]);
  });

  it("does not guess when duplicate sheet names have different accounts", () => {
    expect(
      resolveSchedulePlayerAccountIds(
        [
          { accountId: "account-one", name: "Shared" },
          { accountId: "account-two", name: "Shared" },
        ],
        ["Shared"],
      ),
    ).toEqual([null]);
  });
});

describe("resolveScheduleMonitorAccountId", () => {
  it("projects an unambiguous monitor identity", () => {
    expect(
      resolveScheduleMonitorAccountId([{ accountId: "monitor-1", name: "Miku" }], "Miku"),
    ).toBe("monitor-1");
  });

  it("leaves missing and ambiguous monitor identities unresolved", () => {
    const monitors = [
      { accountId: "monitor-1", name: "Miku" },
      { accountId: "monitor-2", name: "Miku" },
    ];
    expect(resolveScheduleMonitorAccountId(monitors, "Miku")).toBeUndefined();
    expect(resolveScheduleMonitorAccountId(monitors, "Missing")).toBeUndefined();
    expect(resolveScheduleMonitorAccountId(monitors, null)).toBeUndefined();
  });
});

describe("selectCheckinTemplate", () => {
  it("preserves a defined manual template, including blank text", () => {
    expect(
      selectCheckinTemplate({
        explicitTemplate: "  ",
        savedTemplate: "saved",
        fallbackTemplate: "random",
      }),
    ).toBe("  ");
  });

  it("uses saved nonblank content before the randomized fallback", () => {
    expect(
      selectCheckinTemplate({
        explicitTemplate: undefined,
        savedTemplate: "  saved  ",
        fallbackTemplate: "random",
      }),
    ).toBe("  saved  ");
    expect(
      selectCheckinTemplate({
        explicitTemplate: undefined,
        savedTemplate: "  ",
        fallbackTemplate: "random",
      }),
    ).toBe("random");
  });
});

describe("scheduleTimeReferenceMetadataForScheduleProjection", () => {
  const chapterStartEpochMs = Date.UTC(2026, 8, 9, 3);

  it("infers a legacy chapter reference from complete schedule evidence", () => {
    expect(
      scheduleTimeReferenceMetadataForScheduleProjection({
        eventStartEpochMs: chapterStartEpochMs,
        scheduleHours: [193, null, 49, 82],
        establishedReference: undefined,
      }),
    ).toEqual({
      kind: "chapter-start",
      instantEpochMs: chapterStartEpochMs,
      hour: 49,
    });
  });

  it("keeps the established reference stable when rows change", () => {
    const establishedReference = {
      kind: "event-start" as const,
      instantEpochMs: Date.UTC(2026, 8, 7, 3),
      hour: 1 as const,
    };

    expect(
      scheduleTimeReferenceMetadataForScheduleProjection({
        eventStartEpochMs: chapterStartEpochMs,
        scheduleHours: [49, 82],
        establishedReference,
      }),
    ).toBe(establishedReference);
  });
});
