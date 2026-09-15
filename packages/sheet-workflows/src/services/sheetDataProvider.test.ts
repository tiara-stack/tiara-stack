import { describe, expect, it } from "@effect/vitest";
import {
  resolveScheduleMonitorAccountId,
  resolveSchedulePlayerAccountIds,
  scheduleTimeReferenceMetadataForScheduleProjection,
  selectCheckinTemplate,
} from "./sheetDataProvider";

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
