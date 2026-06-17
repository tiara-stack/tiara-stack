import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Context } from "effect";
import { GoogleSheets } from "./google/sheets";
import { SheetConfigService } from "./sheetConfig";

type GoogleSheetsApi = Context.Service.Shape<typeof GoogleSheets>;

const makeGoogleSheets = (
  valueRanges: readonly unknown[][] = [
    [
      "main",
      "1",
      "Schedule",
      "A1:A1",
      "B1:B1",
      null,
      "bold",
      "C1:G1",
      "H1:H1",
      "I1:I1",
      null,
      null,
      "J1:J1",
      null,
    ],
  ],
) =>
  ({
    get: () =>
      Effect.succeed({
        data: {
          valueRanges: [
            {
              values: valueRanges,
            },
          ],
        },
      }),
  }) as unknown as GoogleSheetsApi;

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
      Effect.provideService(GoogleSheets, makeGoogleSheets()),
    ),
  );

  it.effect(
    "treats missing optional monitor ranges as none",
    Effect.fnUntraced(
      function* () {
        const sheetConfigService = yield* SheetConfigService.make;
        const config = yield* sheetConfigService.getRangesConfig("sheet-1");

        expect(config.userIds).toBe("'Teams'!C2:C");
        expect(config.userSheetNames).toBe("'Teams'!A2:A");
        expect(config.userNotes).toEqual(Option.some("'Teams'!H2:H"));
        expect(config.monitorIds).toEqual(Option.none());
        expect(config.monitorNames).toEqual(Option.none());
      },
      Effect.provideService(
        GoogleSheets,
        makeGoogleSheets([
          ["User IDs", "'Teams'!C2:C"],
          ["User Sheet Names", "'Teams'!A2:A"],
          ["User Notes", "'Teams'!H2:H"],
        ]),
      ),
    ),
  );
});
