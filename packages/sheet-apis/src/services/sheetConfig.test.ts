import { describe, expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Layer, Metric, Option } from "effect";
import { GoogleSheets } from "./google/sheets";
import { hourRangeParser, sheetConfigRejectedRows, SheetConfigService } from "./sheetConfig";

type GoogleSheetsApi = Context.Service.Shape<typeof GoogleSheets>;

const makeGoogleSheets = (encType: string) =>
  ({
    get: () =>
      Effect.succeed({
        data: {
          valueRanges: [
            {
              values: [
                [
                  "main",
                  "1",
                  "Schedule",
                  "A1:A1",
                  "B1:B1",
                  null,
                  encType,
                  "C1:G1",
                  "H1:H1",
                  "I1:I1",
                  null,
                  null,
                  "J1:J1",
                  null,
                ],
              ],
            },
          ],
        },
      }),
  }) as unknown as GoogleSheetsApi;

const makeGoogleSheetsWithRows = (values: unknown[][]) =>
  Layer.succeed(GoogleSheets, {
    get: () =>
      Effect.succeed({
        data: {
          valueRanges: [{ values }],
        },
      }),
  } as unknown as GoogleSheetsApi);

const firstFailure = <E>(exit: Exit.Exit<unknown, E>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

describe("SheetConfigService", () => {
  it.effect(
    "accepts bold as a schedule encType",
    Effect.fnUntraced(
      function* () {
        const sheetConfigService = yield* SheetConfigService.make;
        const [config] = yield* sheetConfigService.getScheduleConfig("sheet-1");

        expect(config).toBeDefined();
        expect(config?.encType).toEqual(Option.some("bold"));
      },
      Effect.provideService(GoogleSheets, makeGoogleSheets("bold")),
    ),
  );

  it.effect(
    "accepts underline as a schedule encType",
    Effect.fnUntraced(
      function* () {
        const sheetConfigService = yield* SheetConfigService.make;
        const [config] = yield* sheetConfigService.getScheduleConfig("sheet-1");

        expect(config).toBeDefined();
        expect(config?.encType).toEqual(Option.some("underline"));
      },
      Effect.provideService(GoogleSheets, makeGoogleSheets("underline")),
    ),
  );

  it.effect(
    "fails a schedule config load with accumulated row coordinates instead of dropping rows",
    () =>
      Effect.gen(function* () {
        const sheetConfigService = yield* SheetConfigService.make;
        const exit = yield* Effect.exit(sheetConfigService.getScheduleConfig("spreadsheet-1"));
        const error = firstFailure(exit);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(error?.message).toContain('spreadsheet "spreadsheet-1"');
        expect(error?.message).toContain('sheet="Thee\'s Sheet Settings" range="R8:AE" row=8');
        expect(error?.message).toContain('sheet="Thee\'s Sheet Settings" range="R8:AE" row=9');
        expect(error?.message).toContain("encType");
      }).pipe(
        Effect.provide(
          makeGoogleSheetsWithRows([
            ["main", "1", "Schedule", "A1:A1", "B1:B1", null, "invalid-one"],
            ["backup", "2", "Schedule", "A2:A2", "B2:B2", null, "invalid-two"],
          ]),
        ),
      ),
  );

  it.effect("increments the rejected-row metric with sheet, range, and reason", () =>
    Effect.gen(function* () {
      const rejectedRowMetric = Metric.withAttributes(sheetConfigRejectedRows, {
        sheet: "Thee's Sheet Settings",
        range: "R8:AE",
        reason: "schema_validation",
      });
      const before = yield* Metric.value(rejectedRowMetric);
      const sheetConfigService = yield* SheetConfigService.make;

      const exit = yield* Effect.exit(sheetConfigService.getScheduleConfig("spreadsheet-metric"));

      expect(Exit.isFailure(exit)).toBe(true);
      const after = yield* Metric.value(rejectedRowMetric);
      expect(after.count - before.count).toBe(1);
    }).pipe(
      Effect.provide(
        makeGoogleSheetsWithRows([["main", "1", "Schedule", "A1:A1", "B1:B1", null, "invalid"]]),
      ),
    ),
  );

  it.effect("reports an invalid runner hour range with its row and field", () =>
    Effect.gen(function* () {
      const sheetConfigService = yield* SheetConfigService.make;
      const exit = yield* Effect.exit(sheetConfigService.getRunnerConfig("spreadsheet-runner"));
      const error = firstFailure(exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(error?.message).toContain('range="AG8:AH" row=8');
      expect(error?.message).toContain("field=hours[0]");
      expect(error?.message).toContain("between 0 and 23");
    }).pipe(Effect.provide(makeGoogleSheetsWithRows([["runner", "1-24"]]))),
  );

  it.effect("accepts key-only rows when optional range values are blank", () =>
    Effect.gen(function* () {
      const sheetConfigService = yield* SheetConfigService.make;
      const config = yield* sheetConfigService.getRangesConfig("spreadsheet-ranges");

      expect(config.userIds).toBe("A1:A");
      expect(config.userSheetNames).toBe("B1:B");
      expect(config.userNotes).toEqual(Option.none());
    }).pipe(
      Effect.provide(
        makeGoogleSheetsWithRows([
          ["User IDs", "A1:A"],
          [],
          ["User Sheet Names", "B1:B"],
          ["User Notes"],
          ["Moni IDs"],
          ["Moni Names"],
          ["Oshis"],
        ]),
      ),
    ),
  );
});

describe("hourRangeParser", () => {
  it("parses valid hour ranges", () => {
    expect(hourRangeParser("1-2")).toMatchObject({ start: 1, end: 2 });
  });

  it("rejects malformed, missing, and non-numeric hour ranges", () => {
    for (const range of ["1-", "-2", "foo-2", "1-foo", "1-2-3"]) {
      expect(() => hourRangeParser(range)).toThrow(`Invalid hour range: ${range}`);
    }
  });

  it("rejects values outside the 0-23 hour bounds", () => {
    for (const range of ["-1-2", "1-24", "1-9007199254740993"]) {
      expect(() => hourRangeParser(range)).toThrow(`Invalid hour range: ${range}`);
    }
  });

  it("rejects a start after the end", () => {
    expect(() => hourRangeParser("12-11")).toThrow("end must be greater than or equal to start");
  });
});
