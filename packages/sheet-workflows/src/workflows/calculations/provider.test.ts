import type { sheets_v4 } from "@googleapis/sheets";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import {
  CalculationProjectionWriteError,
  makeCalculationProvider,
  sameCalculationRows,
} from "./provider";
import { maximumPersistedCalculationRows } from "./schema";
import { calculationProjectionWidth } from "../shared/calculationRange";

const rowsBeyondPersistedRowLimit = (): Array<ReadonlyArray<number>> => {
  const rows: Array<ReadonlyArray<number>> = [];
  rows.length = maximumPersistedCalculationRows + 1;
  return rows;
};

const rowsBeyondPersistedCellLimit = (): Array<ReadonlyArray<number>> => {
  const row = Array.from({ length: calculationProjectionWidth + 1 }, () => 0);
  return Array.from({ length: maximumPersistedCalculationRows }, () => row);
};

describe("sheet recalculation provider", () => {
  it.effect("groups target, configuration, projection, and team source reads", () =>
    Effect.gen(function* () {
      const valueCalls: Array<ReadonlyArray<string>> = [];
      const client = {
        spreadsheets: {
          get: () =>
            Promise.resolve({
              data: { sheets: [{ properties: { sheetId: 42, title: "Calculation" } }] },
            }),
          values: {
            batchGet: ({ ranges }: { readonly ranges: ReadonlyArray<string> }) => {
              valueCalls.push(ranges);
              if (valueCalls.length === 1) {
                return Promise.resolve({
                  data: {
                    valueRanges: [
                      {
                        values: [
                          ["User IDs", "Users!A2:A"],
                          ["User Sheet Names", "Users!B2:B"],
                        ],
                      },
                      {
                        values: [
                          [
                            "Unit",
                            "Teams",
                            "A2:A",
                            "B2:B",
                            "split",
                            "C2:C,D2:D,E2:E",
                            "ranges",
                            "F2:F",
                          ],
                        ],
                      },
                      { values: [[6, "old"], ["stale"]] },
                    ],
                  },
                });
              }
              return Promise.resolve({
                data: {
                  valueRanges: ranges.map((range) => ({ range, values: [[range]] })),
                },
              });
            },
          },
        },
      } as unknown as sheets_v4.Sheets;
      const provider = makeCalculationProvider(client);
      const snapshot = yield* provider.load({
        spreadsheetId: "spreadsheet-1",
        sheetTitle: "Calculation",
        canonicalSheetRef: "Calculation!AX30:CC",
      });
      expect(valueCalls).toHaveLength(2);
      expect(valueCalls[0]).toEqual([
        "'Thee''s Sheet Settings'!B8:C",
        "'Thee''s Sheet Settings'!E8:M",
        "Calculation!AX30:CC",
      ]);
      expect(valueCalls[1]).toEqual([
        "Users!A2:A",
        "Users!B2:B",
        "'Teams'!A2:A",
        "'Teams'!B2:B",
        "'Teams'!C2:C",
        "'Teams'!D2:D",
        "'Teams'!E2:E",
        "'Teams'!F2:F",
      ]);
      expect(snapshot).toMatchObject({
        sheetId: 42,
        sheetTitle: "Calculation",
        canonicalSheetRef: "Calculation!AX30:CC",
        preWriteProjection: [[6, "old"], ["stale"]],
      });
      expect(snapshot.sourceRanges.map(({ range }) => range)).toEqual(valueCalls[1]);
    }),
  );

  it.effect("atomically replaces row 30 and clears every stale trailing cell", () =>
    Effect.gen(function* () {
      let captured: unknown;
      const client = {
        spreadsheets: {
          get: () =>
            Promise.resolve({
              data: { sheets: [{ properties: { sheetId: 42, title: "Calculation" } }] },
            }),
          batchUpdate: (request: unknown) => {
            captured = request;
            return Promise.resolve({ data: {} });
          },
          values: {
            batchGet: () =>
              Promise.resolve({
                data: { valueRanges: [{ values: [[6, "old"], [1], [2], [3]] }] },
              }),
          },
        },
      } as unknown as sheets_v4.Sheets;
      const provider = makeCalculationProvider(client);
      yield* provider.replaceProjection({
        spreadsheetId: "spreadsheet-1",
        sheetId: 42,
        sheetTitle: "Calculation",
        canonicalSheetRef: "Calculation!AX30:CC",
        desiredRows: [
          [7, ""],
          [100, 11, "Alpha Team"],
        ],
        preWriteRows: [[6, "old"], [1], [2], [3]],
      });
      expect(captured).toMatchObject({
        spreadsheetId: "spreadsheet-1",
        requestBody: {
          requests: [
            {
              updateCells: {
                range: {
                  sheetId: 42,
                  startRowIndex: 29,
                  endRowIndex: 33,
                  startColumnIndex: 49,
                  endColumnIndex: 81,
                },
                fields: "userEnteredValue",
              },
            },
          ],
        },
      });
      const request = captured as {
        readonly requestBody: {
          readonly requests: ReadonlyArray<{
            readonly updateCells: {
              readonly rows: ReadonlyArray<{ readonly values: ReadonlyArray<unknown> }>;
            };
          }>;
        };
      };
      const rows = request.requestBody.requests[0]!.updateCells.rows;
      expect(rows).toHaveLength(4);
      expect(rows.every(({ values }) => values.length === 32)).toBe(true);
      expect(rows[0]?.values.slice(0, 2)).toEqual([
        { userEnteredValue: { numberValue: 7 } },
        { userEnteredValue: { stringValue: "" } },
      ]);
      expect(rows[1]?.values.slice(0, 3)).toEqual([
        { userEnteredValue: { numberValue: 100 } },
        { userEnteredValue: { numberValue: 11 } },
        { userEnteredValue: { stringValue: "Alpha Team" } },
      ]);
      expect(rows[2]?.values.every((value) => JSON.stringify(value) === "{}")).toBe(true);
      expect(rows[3]?.values.every((value) => JSON.stringify(value) === "{}")).toBe(true);
    }),
  );

  it.effect("rejects a changed sheet identity before issuing a write", () =>
    Effect.gen(function* () {
      let writes = 0;
      const client = {
        spreadsheets: {
          get: () =>
            Promise.resolve({
              data: { sheets: [{ properties: { sheetId: 42, title: "Renamed" } }] },
            }),
          batchUpdate: () => {
            writes++;
            return Promise.resolve({ data: {} });
          },
          values: {
            batchGet: () => Promise.resolve({ data: { valueRanges: [{ values: [[6]] }] } }),
          },
        },
      } as unknown as sheets_v4.Sheets;
      const exit = yield* Effect.exit(
        makeCalculationProvider(client).replaceProjection({
          spreadsheetId: "spreadsheet-1",
          sheetId: 42,
          sheetTitle: "Calculation",
          canonicalSheetRef: "Calculation!AX30:CC",
          desiredRows: [[7]],
          preWriteRows: [[6]],
        }),
      );
      expect(writes).toBe(0);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "CalculationProjectionWriteError",
          ambiguous: false,
          conflicting: true,
        });
      }
    }),
  );

  it.effect("classifies deterministic write errors as non-ambiguous", () =>
    Effect.gen(function* () {
      const client = {
        spreadsheets: {
          get: () =>
            Promise.resolve({
              data: { sheets: [{ properties: { sheetId: 42, title: "Calculation" } }] },
            }),
          batchUpdate: () =>
            Promise.reject(
              Object.assign(new Error("invalid request"), { code: "ERR_INVALID_ARG_TYPE" }),
            ),
          values: {
            batchGet: () => Promise.resolve({ data: { valueRanges: [{}] } }),
          },
        },
      } as unknown as sheets_v4.Sheets;
      const provider = makeCalculationProvider(client);
      const exit = yield* Effect.exit(
        provider.replaceProjection({
          spreadsheetId: "spreadsheet-1",
          sheetId: 42,
          sheetTitle: "Calculation",
          canonicalSheetRef: "Calculation!AX30:CC",
          desiredRows: [[7]],
          preWriteRows: [],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        expect(error).toBeInstanceOf(CalculationProjectionWriteError);
        expect(error).toMatchObject({ ambiguous: false });
      }
    }),
  );

  it.effect("classifies retryable transport and server errors as ambiguous", () =>
    Effect.gen(function* () {
      for (const cause of [
        Object.assign(new Error("rate limited"), { response: { status: 429 } }),
        Object.assign(new Error("project quota exceeded"), {
          response: { status: 403, data: { error: { errors: [{ reason: "rateLimitExceeded" }] } } },
        }),
        Object.assign(new Error("user quota exceeded"), {
          response: {
            status: 403,
            data: { error: { errors: [{ reason: "userRateLimitExceeded" }] } },
          },
        }),
        Object.assign(new Error("backend error"), { response: { status: 500 } }),
        Object.assign(new Error("numeric backend error"), { code: 503 }),
        Object.assign(new Error("dns retry"), { code: "EAI_AGAIN" }),
        Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
        Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
        Object.assign(new Error("dns lookup failed"), { code: "ENOTFOUND" }),
        Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }),
        new Error("unknown write outcome"),
      ]) {
        const client = {
          spreadsheets: {
            get: () =>
              Promise.resolve({
                data: { sheets: [{ properties: { sheetId: 42, title: "Calculation" } }] },
              }),
            batchUpdate: () => Promise.reject(cause),
            values: {
              batchGet: () => Promise.resolve({ data: { valueRanges: [{}] } }),
            },
          },
        } as unknown as sheets_v4.Sheets;
        const exit = yield* Effect.exit(
          makeCalculationProvider(client).replaceProjection({
            spreadsheetId: "spreadsheet-1",
            sheetId: 42,
            sheetTitle: "Calculation",
            canonicalSheetRef: "Calculation!AX30:CC",
            desiredRows: [[7]],
            preWriteRows: [],
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
            ambiguous: true,
          });
        }
      }
    }),
  );

  it.effect("classifies numeric deterministic provider codes as non-ambiguous", () =>
    Effect.gen(function* () {
      for (const code of [400, 404]) {
        const client = {
          spreadsheets: {
            get: () =>
              Promise.resolve({
                data: { sheets: [{ properties: { sheetId: 42, title: "Calculation" } }] },
              }),
            batchUpdate: () =>
              Promise.reject(Object.assign(new Error("request rejected"), { code })),
            values: {
              batchGet: () => Promise.resolve({ data: { valueRanges: [{}] } }),
            },
          },
        } as unknown as sheets_v4.Sheets;
        const exit = yield* Effect.exit(
          makeCalculationProvider(client).replaceProjection({
            spreadsheetId: "spreadsheet-1",
            sheetId: 42,
            sheetTitle: "Calculation",
            canonicalSheetRef: "Calculation!AX30:CC",
            desiredRows: [[7]],
            preWriteRows: [],
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
            ambiguous: false,
          });
        }
      }
    }),
  );

  it.effect("rejects a changed live projection before issuing a write", () =>
    Effect.gen(function* () {
      let writes = 0;
      const client = {
        spreadsheets: {
          get: () =>
            Promise.resolve({
              data: { sheets: [{ properties: { sheetId: 42, title: "Calculation" } }] },
            }),
          batchUpdate: () => {
            writes++;
            return Promise.resolve({ data: {} });
          },
          values: {
            batchGet: () => Promise.resolve({ data: { valueRanges: [{ values: [[9]] }] } }),
          },
        },
      } as unknown as sheets_v4.Sheets;
      const provider = makeCalculationProvider(client);
      const exit = yield* Effect.exit(
        provider.replaceProjection({
          spreadsheetId: "spreadsheet-1",
          sheetId: 42,
          sheetTitle: "Calculation",
          canonicalSheetRef: "Calculation!AX30:CC",
          desiredRows: [[7]],
          preWriteRows: [[6]],
        }),
      );
      expect(writes).toBe(0);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "CalculationProjectionWriteError",
          ambiguous: false,
          conflicting: true,
        });
      }
    }),
  );

  it.effect("rejects desired rows wider than the projection range", () =>
    Effect.gen(function* () {
      let writes = 0;
      const client = {
        spreadsheets: {
          get: () =>
            Promise.resolve({
              data: { sheets: [{ properties: { sheetId: 42, title: "Calculation" } }] },
            }),
          batchUpdate: () => {
            writes++;
            return Promise.resolve({ data: {} });
          },
          values: {
            batchGet: () => Promise.resolve({ data: { valueRanges: [{ values: [[9]] }] } }),
          },
        },
      } as unknown as sheets_v4.Sheets;
      const provider = makeCalculationProvider(client);
      const exit = yield* Effect.exit(
        provider.replaceProjection({
          spreadsheetId: "spreadsheet-1",
          sheetId: 42,
          sheetTitle: "Calculation",
          canonicalSheetRef: "Calculation!AX30:CC",
          desiredRows: [Array.from({ length: 33 }, () => 1)],
          preWriteRows: [[9]],
        }),
      );
      expect(writes).toBe(0);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "CalculationProjectionWriteError",
          ambiguous: false,
        });
        expect((error as CalculationProjectionWriteError).conflicting).toBeUndefined();
      }
    }),
  );

  it.effect("rejects desired rows beyond the persisted row limit", () =>
    Effect.gen(function* () {
      let writes = 0;
      const client = {
        spreadsheets: {
          get: () =>
            Promise.resolve({
              data: { sheets: [{ properties: { sheetId: 42, title: "Calculation" } }] },
            }),
          batchUpdate: () => {
            writes++;
            return Promise.resolve({ data: {} });
          },
          values: {
            batchGet: () => Promise.resolve({ data: { valueRanges: [{ values: [[]] }] } }),
          },
        },
      } as unknown as sheets_v4.Sheets;
      const exit = yield* Effect.exit(
        makeCalculationProvider(client).replaceProjection({
          spreadsheetId: "spreadsheet-1",
          sheetId: 42,
          sheetTitle: "Calculation",
          canonicalSheetRef: "Calculation!AX30:CC",
          desiredRows: rowsBeyondPersistedRowLimit(),
          preWriteRows: [],
        }),
      );
      expect(writes).toBe(0);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "CalculationProjectionWriteError",
          ambiguous: false,
        });
        expect(error.conflicting).toBeUndefined();
      }
    }),
  );

  it.effect("rejects pre-write rows beyond the persisted cell limit", () =>
    Effect.gen(function* () {
      let writes = 0;
      const client = {
        spreadsheets: {
          get: () =>
            Promise.resolve({
              data: { sheets: [{ properties: { sheetId: 42, title: "Calculation" } }] },
            }),
          batchUpdate: () => {
            writes++;
            return Promise.resolve({ data: {} });
          },
          values: {
            batchGet: () => Promise.resolve({ data: { valueRanges: [{ values: [[]] }] } }),
          },
        },
      } as unknown as sheets_v4.Sheets;
      const exit = yield* Effect.exit(
        makeCalculationProvider(client).replaceProjection({
          spreadsheetId: "spreadsheet-1",
          sheetId: 42,
          sheetTitle: "Calculation",
          canonicalSheetRef: "Calculation!AX30:CC",
          desiredRows: [[7]],
          preWriteRows: rowsBeyondPersistedCellLimit(),
        }),
      );
      expect(writes).toBe(0);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "CalculationProjectionWriteError",
          ambiguous: false,
        });
        expect(error.conflicting).toBeUndefined();
        expect((error as CalculationProjectionWriteError).cause).toContain("persisted cell limit");
      }
    }),
  );

  it.effect("classifies a pre-write projection read failure as non-ambiguous", () =>
    Effect.gen(function* () {
      let writes = 0;
      const client = {
        spreadsheets: {
          get: () =>
            Promise.resolve({
              data: { sheets: [{ properties: { sheetId: 42, title: "Calculation" } }] },
            }),
          batchUpdate: () => {
            writes++;
            return Promise.resolve({ data: {} });
          },
          values: {
            batchGet: () => Promise.reject(new Error("projection read failed")),
          },
        },
      } as unknown as sheets_v4.Sheets;
      const exit = yield* Effect.exit(
        makeCalculationProvider(client).replaceProjection({
          spreadsheetId: "spreadsheet-1",
          sheetId: 42,
          sheetTitle: "Calculation",
          canonicalSheetRef: "Calculation!AX30:CC",
          desiredRows: [[7]],
          preWriteRows: [[6]],
        }),
      );
      expect(writes).toBe(0);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "CalculationProjectionWriteError",
          ambiguous: false,
        });
      }
    }),
  );

  it("treats provider-omitted trailing blank cells as exact desired state", () => {
    expect(
      sameCalculationRows(
        [[7], [1, 2]],
        [
          [7, ""],
          [1, 2, null, ""],
        ],
      ),
    ).toBe(true);
    expect(sameCalculationRows([[7, null, 9]], [[7, "", 9]])).toBe(true);
    expect(sameCalculationRows([[7], [1, 2]], [[7], [1, 2], [], ["", null]])).toBe(true);
    expect(sameCalculationRows([[7], [1, 2]], [[7], [1, 3]])).toBe(false);
    expect(sameCalculationRows([[7], [1, 2]], [[7], [1, 2], [3]])).toBe(false);
  });
});
