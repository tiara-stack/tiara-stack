import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  formatSheetConfigurationSummary,
  inspectSheetConfigurationFile,
  inspectSheetConfigurationFileText,
  isSheetConfigurationFileInspectionValid,
  makeSheetConfigurationFile,
  serializeSheetConfigurationFile,
} from "./configurationFile";

const configuration = {
  schemaVersion: 1 as const,
  spreadsheetId: "spreadsheet-1",
  users: {
    userIds: {
      sheetId: 2,
      startRow: 7,
      endRow: 12,
      startColumn: 1,
      endColumn: 3,
    },
    userSheetNames: {
      sheetId: 2,
      startRow: 7,
      endRow: 12,
      startColumn: 3,
      endColumn: 5,
    },
  },
  teams: [],
  event: { startTimeEpochMs: 1_700_000_000_000 },
  schedules: [],
  runners: [],
};

describe("portable Sheet Configuration files", () => {
  it("formats configuration counts with the correct singular forms", () => {
    const range = {
      startRow: 7,
      endRow: 12,
      startColumn: 1,
      endColumn: 3,
    } as const;
    const populated = {
      ...configuration,
      teams: [
        {
          entryId: "team-1",
          sheetId: 2,
          teamName: range,
          userNames: range,
          isv: { kind: "combined" as const, range },
          tags: { kind: "constants" as const, values: ["tag"] },
        },
      ],
      schedules: [
        {
          entryId: "schedule-1",
          channel: "main",
          day: 1,
          sheetId: 2,
          hourRange: range,
          breakRange: "auto" as const,
          encoding: "none" as const,
          fillRange: range,
          overfillRange: range,
          standbyRange: range,
          visibleCell: range,
        },
      ],
      runners: [{ entryId: "runner-1", name: "Miku", hours: [{ start: 1, end: 2 }] }],
    };

    expect(formatSheetConfigurationSummary(configuration)).toBe("0 teams, 0 schedules, 0 runners");
    expect(formatSheetConfigurationSummary(populated)).toBe("1 team, 1 schedule, 1 runner");
  });

  it("serializes a versioned envelope without workspace metadata", () => {
    const file = makeSheetConfigurationFile(configuration);
    const decoded: unknown = JSON.parse(serializeSheetConfigurationFile(configuration));

    expect(file).toEqual({
      format: "tiarastack.sheet-configuration",
      version: 1,
      configuration,
    });
    expect(decoded).toEqual(file);
    expect(decoded).not.toHaveProperty("workspaceId");
    expect(decoded).not.toHaveProperty("revisionId");
  });

  it.effect("accepts a valid exported file", () =>
    Effect.gen(function* () {
      const inspection = yield* inspectSheetConfigurationFile(
        makeSheetConfigurationFile(configuration),
      );

      expect(isSheetConfigurationFileInspectionValid(inspection)).toBe(true);
      expect(inspection.configuration).toEqual(configuration);
      expect(inspection.diagnostics).toEqual([]);
    }),
  );

  it.effect("reports malformed envelopes before persistence", () =>
    Effect.gen(function* () {
      const inspection = yield* inspectSheetConfigurationFile({
        format: "tiarastack.sheet-configuration",
        version: 1,
        configuration: { ...configuration, unexpected: true },
      });

      expect(inspection.configuration).toBeNull();
      expect(inspection.diagnostics).toEqual([
        expect.objectContaining({ code: "InvalidSchema", path: "file", severity: "error" }),
      ]);
    }),
  );

  it.effect("reports invalid JSON and oversized text before persistence", () =>
    Effect.gen(function* () {
      const invalidJson = yield* inspectSheetConfigurationFileText("not-json");
      const oversized = yield* inspectSheetConfigurationFileText("x".repeat(1_048_577));

      expect(invalidJson).toMatchObject({
        configuration: null,
        diagnostics: [
          expect.objectContaining({
            code: "InvalidSchema",
            message: "The configuration file is not valid JSON.",
          }),
        ],
      });
      expect(oversized).toMatchObject({
        configuration: null,
        diagnostics: [
          expect.objectContaining({
            code: "InvalidSchema",
            message: "Configuration files must be 1 MiB or smaller.",
          }),
        ],
      });
    }),
  );

  it.effect("keeps cross-field diagnostics attached to an otherwise decoded file", () =>
    Effect.gen(function* () {
      const invalid = {
        ...configuration,
        users: {
          ...configuration.users,
          monitors: {
            ids: {
              sheetId: 2,
              startRow: 7,
              endRow: 12,
              startColumn: 1,
              endColumn: 3,
            },
          },
        },
      };
      const inspection = yield* inspectSheetConfigurationFile(makeSheetConfigurationFile(invalid));

      expect(inspection.configuration).toEqual(invalid);
      expect(inspection.diagnostics).toEqual([
        expect.objectContaining({ code: "MissingPairedRange", path: "users.monitors" }),
      ]);
      expect(isSheetConfigurationFileInspectionValid(inspection)).toBe(false);
    }),
  );
});
