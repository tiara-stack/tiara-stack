import { describe, expect, it } from "@effect/vitest";
import {
  legacyConfigurationDigest,
  legacyConfigurationRowsFromSnapshot,
  legacySettingsExpectedTitle,
  parseLegacyConfiguration,
} from "./legacyConfiguration";

const tabs = [
  {
    sheetId: 1,
    title: legacySettingsExpectedTitle,
    hidden: false,
    sheetType: "GRID" as const,
    rowCount: 200,
    columnCount: 40,
  },
  {
    sheetId: 2,
    title: "Team Alpha",
    hidden: false,
    sheetType: "GRID" as const,
    rowCount: 100,
    columnCount: 20,
  },
  {
    sheetId: 3,
    title: "Schedule",
    hidden: false,
    sheetType: "GRID" as const,
    rowCount: 100,
    columnCount: 20,
  },
];

const rows = {
  users: [
    ["User IDs", "'Team Alpha'!A2:A"],
    ["User Sheet Names", "'Team Alpha'!B2:B"],
    ["User Notes", "'Team Alpha'!C2:C"],
    ["Moni IDs", "'Team Alpha'!D2:D"],
    ["Moni Names", "'Team Alpha'!E2:E"],
  ],
  teams: [
    [
      "Alpha",
      "Team Alpha",
      "A2:A",
      "B2:B",
      "combined",
      "C2:C",
      "constants",
      "tierer_hint,encable",
      "D2:D",
    ],
  ],
  event: [["Start Time", "1700000000"]],
  schedules: [
    [
      "main",
      "1",
      "Schedule",
      "A2:A",
      "B2:B",
      "C2:C",
      "bold",
      "D2:D",
      "E2:E",
      "F2:F",
      "G2:G",
      "H2:H",
      "I2:I",
      null,
    ],
  ],
  runners: [["Miku", "2-4, 4-6"]],
} as const;

describe("legacy Sheet Configuration migration", () => {
  it("parses the fixed legacy sections into stable canonical values", () => {
    const result = parseLegacyConfiguration({
      spreadsheetId: "spreadsheet-1",
      tabs,
      rows,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.source).toEqual({
      kind: "legacy",
      binding: {
        status: "bound",
        expectedTitle: legacySettingsExpectedTitle,
        spreadsheetId: "spreadsheet-1",
        sheetId: 1,
        layoutVersion: "legacy-settings-layout-v1",
      },
    });
    expect(result.configuration).toMatchObject({
      schemaVersion: 1,
      spreadsheetId: "spreadsheet-1",
      users: {
        userIds: { sheetId: 2, startRow: 1, endRow: "sheet-end", startColumn: 0, endColumn: 1 },
        userSheetNames: {
          sheetId: 2,
          startRow: 1,
          endRow: "sheet-end",
          startColumn: 1,
          endColumn: 2,
        },
        monitors: {
          ids: expect.objectContaining({ sheetId: 2 }),
          names: expect.objectContaining({ sheetId: 2 }),
        },
      },
      teams: [
        expect.objectContaining({
          entryId: expect.stringMatching(/^team-/u),
          sheetId: 2,
          teamName: expect.not.objectContaining({ sheetId: expect.anything() }),
          userNames: expect.not.objectContaining({ sheetId: expect.anything() }),
          isv: {
            kind: "combined",
            range: expect.not.objectContaining({ sheetId: expect.anything() }),
          },
          tags: { kind: "constants", values: ["tierer_hint", "encable"] },
        }),
      ],
      event: { startTimeEpochMs: 1_700_000_000_000 },
      schedules: [
        expect.objectContaining({
          entryId: expect.stringMatching(/^schedule-/u),
          day: 1,
          sheetId: 3,
          encoding: "bold",
          breakRange: expect.not.objectContaining({ sheetId: expect.anything() }),
        }),
      ],
      runners: [
        {
          entryId: expect.stringMatching(/^runner-/u),
          name: "Miku",
          hours: [{ start: 2, end: 6 }],
        },
      ],
    });
  });

  it("keeps the value-only import digest stable and emits review diagnostics", () => {
    const first = parseLegacyConfiguration({
      spreadsheetId: "spreadsheet-1",
      tabs,
      rows,
    });
    const second = parseLegacyConfiguration({
      spreadsheetId: "spreadsheet-1",
      tabs,
      rows: { ...rows, event: [["Start Time", "1700001"]] },
    });

    expect(first.baselineDigest).toBe(legacyConfigurationDigest(rows));
    expect(first.baselineDigest).not.toBe(second.baselineDigest);

    const malformed = parseLegacyConfiguration({
      spreadsheetId: "spreadsheet-1",
      tabs,
      rows: { ...rows, users: [["User IDs", "Missing!A:A"], rows.users[1]!] },
    });
    expect(malformed.configuration).toBeNull();
    expect(malformed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SheetMissing", path: "users.userIds" }),
      ]),
    );
  });

  it.each([
    {
      name: "missing required users labels",
      rows: { ...rows, users: [rows.users[0]!] },
    },
    {
      name: "unrecognized users labels",
      rows: { ...rows, users: [...rows.users, ["Unknown Users Label", "value"]] },
    },
    {
      name: "incorrect users section width",
      rows: { ...rows, users: [[...rows.users[0]!, "unexpected"], rows.users[1]!] },
    },
  ])("rejects $name", ({ rows: malformedRows }) => {
    const result = parseLegacyConfiguration({
      spreadsheetId: "spreadsheet-1",
      tabs,
      rows: malformedRows,
    });

    expect(result.configuration).toBeNull();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "LegacyHeadersChanged" })]),
    );
  });

  it("resolves an existing legacy binding by tab ID after a rename", () => {
    const result = parseLegacyConfiguration({
      spreadsheetId: "spreadsheet-1",
      tabs: tabs.map((tab) => (tab.sheetId === 1 ? { ...tab, title: "Renamed settings" } : tab)),
      rows,
      expectedTitle: legacySettingsExpectedTitle,
      boundSheetId: 1,
    });

    expect(result.source).toMatchObject({
      kind: "legacy",
      binding: { status: "bound", sheetId: 1, expectedTitle: legacySettingsExpectedTitle },
    });
    expect(result.configuration).not.toBeNull();
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "LegacySourceChanged" })]),
    );
  });

  it("rejects signed schedule days before extracting digits", () => {
    const result = parseLegacyConfiguration({
      spreadsheetId: "spreadsheet-1",
      tabs,
      rows: {
        ...rows,
        schedules: [rows.schedules[0]!.map((value, index) => (index === 1 ? "-1" : value))],
      },
    });

    expect(result.configuration?.schedules).toEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "InvalidSchema", path: "schedules[0].day" }),
      ]),
    );
  });

  it("reports when an existing legacy binding tab is removed", () => {
    const result = parseLegacyConfiguration({
      spreadsheetId: "spreadsheet-1",
      tabs: tabs.filter((tab) => tab.sheetId !== 1),
      rows,
      expectedTitle: legacySettingsExpectedTitle,
      boundSheetId: 1,
    });

    expect(result.configuration).toBeNull();
    expect(result.source).toMatchObject({
      kind: "legacy",
      binding: { status: "bound", sheetId: 1 },
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "LegacySourceChanged", path: "source.binding" }),
      ]),
    );
  });

  it("accepts legacy ranges with an apostrophe in a quoted tab title", () => {
    const result = parseLegacyConfiguration({
      spreadsheetId: "spreadsheet-1",
      tabs: [
        ...tabs,
        {
          sheetId: 4,
          title: "Thee's Teams v1.0",
          hidden: false,
          sheetType: "GRID" as const,
          rowCount: 100,
          columnCount: 20,
        },
      ],
      rows: {
        ...rows,
        users: [
          ["User IDs", "'Thee''s Teams v1.0'!D12:D"],
          ["User Sheet Names", "'Thee''s Teams v1.0'!B12:B"],
        ],
      },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.configuration?.users.userIds).toMatchObject({
      sheetId: 4,
      startRow: 11,
      endRow: "sheet-end",
      startColumn: 3,
      endColumn: 4,
    });
  });

  it("rejects an unescaped apostrophe in a quoted tab title", () => {
    const result = parseLegacyConfiguration({
      spreadsheetId: "spreadsheet-1",
      tabs,
      rows: {
        ...rows,
        users: [
          ["User IDs", "'Thee's Teams v1.0'!D12:D"],
          ["User Sheet Names", "'Team Alpha'!B12:B"],
        ],
      },
    });

    expect(result.configuration).toBeNull();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "InvalidRange", path: "users.userIds" }),
      ]),
    );
  });

  it("rejects independently qualified local team and schedule ranges", () => {
    const result = parseLegacyConfiguration({
      spreadsheetId: "spreadsheet-1",
      tabs,
      rows: {
        ...rows,
        teams: [rows.teams[0]!.map((value, index) => (index === 2 ? "Schedule!A2:A" : value))],
      },
    });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "InvalidRange", path: "teams[0].userNames" }),
      ]),
    );
  });

  it("does not duplicate an ISV schema error when a valid grammar has an invalid range", () => {
    const result = parseLegacyConfiguration({
      spreadsheetId: "spreadsheet-1",
      tabs,
      rows: {
        ...rows,
        teams: [rows.teams[0]!.map((value, index) => (index === 5 ? "B2:B1" : value))],
      },
    });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "InvalidRange", path: "teams[0].isv.range" }),
      ]),
    );
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "InvalidSchema", path: "teams[0].isv" }),
      ]),
    );
  });

  it("projects sparse absolute cells into the legacy sections", () => {
    const cells = [
      { row: 7, column: 1, formattedValue: "User IDs" },
      { row: 7, column: 2, formattedValue: "Team Alpha!A2:A" },
      { row: 7, column: 17, formattedValue: "main" },
      { row: 7, column: 18, formattedValue: "1" },
    ];

    const projected = legacyConfigurationRowsFromSnapshot(cells);

    expect(projected.users[0]).toEqual(["User IDs", "Team Alpha!A2:A"]);
    expect(projected.schedules[0]?.slice(0, 2)).toEqual(["main", "1"]);
  });
});
