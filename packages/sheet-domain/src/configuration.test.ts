import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  SheetRange,
  SheetRangeCoordinates,
  WebSheetConfiguration,
  formatSheetRange,
  formatSheetRangeOption,
  normalizeRunnerIntervals,
  parseSheetRange,
  sheetTitleFromRange,
  validateWebSheetConfiguration,
} from "./configuration";

const range = (overrides: Partial<typeof SheetRange.Type> = {}): typeof SheetRange.Type => ({
  sheetId: 2,
  startRow: 7,
  endRow: 12,
  startColumn: 1,
  endColumn: 3,
  ...overrides,
});

const localRange = (
  overrides: Partial<typeof SheetRangeCoordinates.Type> = {},
): typeof SheetRangeCoordinates.Type => ({
  startRow: 7,
  endRow: 12,
  startColumn: 1,
  endColumn: 3,
  ...overrides,
});

const configuration = {
  schemaVersion: 1 as const,
  spreadsheetId: "spreadsheet-1",
  users: {
    userIds: range(),
    userSheetNames: range({ startColumn: 3, endColumn: 5 }),
  },
  teams: [],
  event: { startTimeEpochMs: 1_700_000_000_000 },
  schedules: [],
  runners: [],
};

describe("web-native Sheet Configuration values", () => {
  it("round-trips tab-qualified half-open ranges, including open-ended columns", () => {
    const formatted = formatSheetRange("Thee's Sheet Settings", range({ endRow: "sheet-end" }));

    expect(formatted).toBe("'Thee''s Sheet Settings'!B8:C");
    expect(parseSheetRange(formatted, 2)).toEqual(range({ endRow: "sheet-end" }));
    expect(parseSheetRange("'Schedule Tab'!$D$3:$F$5", 9)).toEqual({
      sheetId: 9,
      startRow: 2,
      endRow: 5,
      startColumn: 3,
      endColumn: 6,
    });
    expect(parseSheetRange("Users!A8:A", 4)).toEqual({
      sheetId: 4,
      startRow: 7,
      endRow: "sheet-end",
      startColumn: 0,
      endColumn: 1,
    });
    expect(sheetTitleFromRange("'Schedule Tab'!$D$3:$F$5")).toBe("Schedule Tab");
    expect(sheetTitleFromRange("'Other''s Tab'!A1:A")).toBe("Other's Tab");
    expect(formatSheetRange("A1", range())).toBe("'A1'!B8:C12");
  });

  it("rejects malformed or empty rectangles before they can become a draft", () => {
    expect(parseSheetRange("Users!B8:B7", 0)).toBeUndefined();
    expect(parseSheetRange("Users!B8:B8", 0)).toEqual({
      sheetId: 0,
      startRow: 7,
      endRow: 8,
      startColumn: 1,
      endColumn: 2,
    });
    expect(parseSheetRange("Users!0:0", 0)).toBeUndefined();
    expect(parseSheetRange("Users!A:A", 0)).toBeUndefined();
    expect(parseSheetRange("Users!A1:B$", 0)).toBeUndefined();
    expect(() => formatSheetRange("Users", range({ endColumn: 1 }))).toThrow(
      "non-empty half-open rectangle",
    );
    expect(formatSheetRangeOption("Users", range({ endColumn: 1 }))).toBeUndefined();
    expect(formatSheetRangeOption("Users", range())).toBe("Users!B8:C12");
    expect(parseSheetRange("Users!ZZZ1:ZZZ2", 0)).toEqual({
      sheetId: 0,
      startRow: 0,
      endRow: 2,
      startColumn: 18_277,
      endColumn: 18_278,
    });
    expect(parseSheetRange("Users!AAAA1:AAAA2", 0)).toBeUndefined();
  });

  it.effect("rejects canonical ranges outside the provider row bound", () =>
    Effect.gen(function* () {
      const diagnostics = yield* validateWebSheetConfiguration({
        ...configuration,
        users: {
          ...configuration.users,
          userIds: range({ startRow: 10_000_000, endRow: 10_000_001 }),
        },
      });

      expect(diagnostics).toEqual([
        expect.objectContaining({ code: "InvalidRange", path: "users.userIds" }),
      ]);
    }),
  );

  it("normalizes runner intervals deterministically", () => {
    expect(
      normalizeRunnerIntervals([
        { start: 8, end: 10 },
        { start: 1, end: 2 },
        { start: 3, end: 4 },
        { start: 10, end: 12 },
      ]),
    ).toEqual([
      { start: 1, end: 4 },
      { start: 8, end: 12 },
    ]);
  });

  it.effect("reports cross-field validation diagnostics", () =>
    Effect.gen(function* () {
      const invalid = {
        ...configuration,
        users: {
          ...configuration.users,
          monitors: { ids: range() },
        },
        schedules: [
          {
            entryId: "schedule-1",
            channel: "main",
            day: 1,
            sheetId: 2,
            hourRange: localRange(),
            breakRange: "auto" as const,
            encoding: "none" as const,
            fillRange: localRange(),
            overfillRange: localRange(),
            standbyRange: localRange(),
            visibleCell: localRange(),
          },
          {
            entryId: "schedule-2",
            channel: "main",
            day: 1,
            sheetId: 2,
            hourRange: localRange(),
            breakRange: "auto" as const,
            encoding: "none" as const,
            fillRange: localRange(),
            overfillRange: localRange(),
            standbyRange: localRange(),
            visibleCell: localRange(),
          },
        ],
      } satisfies typeof WebSheetConfiguration.Type;

      const diagnostics = yield* validateWebSheetConfiguration(invalid);

      expect(diagnostics.map(({ code }) => code)).toEqual([
        "MissingPairedRange",
        "DuplicateScheduleIdentity",
      ]);
    }),
  );

  it.effect("keeps schedule days positive without imposing a calendar upper bound", () =>
    Effect.gen(function* () {
      const diagnostics = yield* validateWebSheetConfiguration({
        ...configuration,
        schedules: [
          {
            entryId: "schedule-1",
            channel: "main",
            day: 31,
            sheetId: 2,
            hourRange: localRange(),
            breakRange: "auto" as const,
            encoding: "none" as const,
            fillRange: localRange(),
            overfillRange: localRange(),
            standbyRange: localRange(),
            visibleCell: localRange(),
          },
        ],
      });

      expect(diagnostics).toEqual([]);
    }),
  );

  it.effect("reports reversed runner intervals", () =>
    Effect.gen(function* () {
      const diagnostics = yield* validateWebSheetConfiguration({
        ...configuration,
        runners: [{ entryId: "runner-1", name: "Miku", hours: [{ start: 8, end: 2 }] }],
      });

      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: "InvalidRunnerInterval",
          path: "runners[0].hours[0]",
        }),
      ]);
    }),
  );

  it("keeps the persisted configuration schema strict", () => {
    expect(() =>
      Schema.decodeUnknownSync(WebSheetConfiguration, { onExcessProperty: "error" })({
        ...configuration,
        unexpected: true,
      }),
    ).toThrow();
  });

  it.effect("includes schema failure details in invalid configuration diagnostics", () =>
    Effect.gen(function* () {
      const diagnostics = yield* validateWebSheetConfiguration({
        ...configuration,
        schemaVersion: 2,
      });

      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: "InvalidSchema",
          path: "configuration",
          message: expect.stringContaining("schemaVersion"),
        }),
      ]);
    }),
  );
});
