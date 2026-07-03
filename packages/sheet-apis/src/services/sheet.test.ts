import type { sheets_v4 } from "@googleapis/sheets";
import { describe, expect, it } from "@effect/vitest";
import { Effect, HashMap, Option, Predicate, Context } from "effect";
import type { BreakSchedule, Schedule } from "sheet-ingress-api/schemas/sheet";
import { ScheduleConfig } from "sheet-ingress-api/schemas/sheetConfig";
import { GoogleSheets } from "./google/sheets";
import { SheetConfigService } from "./sheetConfig";
import { SheetService } from "./sheet";

type GoogleSheetsApi = Context.Service.Shape<typeof GoogleSheets>;
type SheetConfigServiceApi = Context.Service.Shape<typeof SheetConfigService>;

const scheduleSheet = "Schedule";

const makeCell = (
  formattedValue?: string,
  options?: {
    effectiveBold?: boolean;
    userEnteredBold?: boolean;
  },
): sheets_v4.Schema$CellData => ({
  ...(formattedValue === undefined ? {} : { formattedValue }),
  ...(typeof options?.effectiveBold === "boolean"
    ? { effectiveFormat: { textFormat: { bold: options.effectiveBold } } }
    : {}),
  ...(typeof options?.userEnteredBold === "boolean"
    ? { userEnteredFormat: { textFormat: { bold: options.userEnteredBold } } }
    : {}),
});

const makeRow = (...values: sheets_v4.Schema$CellData[]): sheets_v4.Schema$RowData => ({
  values,
});

const makeRange = (range: string) => `'${scheduleSheet}'!${range}`;

const makeScheduleConfig = (encType: "none" | "regex" | "bold") =>
  new ScheduleConfig({
    channel: Option.some("main"),
    day: Option.some(1),
    sheet: Option.some(scheduleSheet),
    hourRange: Option.some("A1:A1"),
    breakRange: Option.some("B1:B1"),
    monitorRange: Option.none(),
    encType: Option.some(encType),
    fillRange: Option.some("C1:G1"),
    overfillRange: Option.some("H1:H1"),
    standbyRange: Option.some("I1:I1"),
    screenshotRange: Option.none(),
    noteRange: Option.none(),
    visibleCell: Option.some("J1:J1"),
    draft: Option.none(),
  });

const makeSheetConfigService = (encType: "none" | "regex" | "bold") =>
  ({
    getScheduleConfig: () => Effect.succeed([makeScheduleConfig(encType)]),
    getRunnerConfig: () => Effect.succeed([]),
  }) as unknown as SheetConfigServiceApi;

const makeGoogleSheets = (ranges: Record<string, sheets_v4.Schema$RowData[]>) =>
  ({
    getRowDatasHashMap: <K>(requestedRanges: HashMap.HashMap<K, string>) =>
      Effect.succeed(HashMap.map(requestedRanges, (range) => ranges[range] ?? [])),
  }) as unknown as GoogleSheetsApi;
const isSchedule = Predicate.isTagged("Schedule");

const getSchedule = (schedules: ReadonlyArray<BreakSchedule | Schedule>) => {
  const schedule = schedules.find(
    (candidate) => isSchedule(candidate) && Option.isSome(candidate.hour),
  );
  expect(schedule?._tag).toBe("Schedule");

  if (schedule == null || !isSchedule(schedule) || Option.isNone(schedule.hour)) {
    throw new Error("Expected a schedule row");
  }

  return schedule;
};

const getFill = (schedule: ReturnType<typeof getSchedule>, index: number) => {
  const fill = schedule.fills[index];
  expect(fill).toBeDefined();

  if (fill == null || Option.isNone(fill)) {
    throw new Error(`Expected fill ${index} to be populated`);
  }

  return fill.value;
};

const runGetAllSchedules = ({
  encType,
  fills,
  overfills,
  standbys,
}: {
  encType: "none" | "regex" | "bold";
  fills: sheets_v4.Schema$CellData[];
  overfills?: string;
  standbys?: string;
}) =>
  Effect.gen(function* () {
    const sheetService = yield* SheetService.make;
    return yield* sheetService.getAllSchedules("sheet-1");
  }).pipe(
    Effect.provideService(
      GoogleSheets,
      makeGoogleSheets({
        [makeRange("A1:A1")]: [makeRow(makeCell("1"))],
        [makeRange("B1:B1")]: [makeRow(makeCell("FALSE"))],
        [makeRange("C1:G1")]: [makeRow(...fills)],
        [makeRange("H1:H1")]: [makeRow(makeCell(overfills))],
        [makeRange("I1:I1")]: [makeRow(makeCell(standbys))],
        [makeRange("J1:J1")]: [makeRow(makeCell("TRUE"))],
      }),
    ),
    Effect.provideService(SheetConfigService, makeSheetConfigService(encType)),
  );

describe("SheetService schedule enc parsing", () => {
  it.effect("marks a bold fill from effective format", () =>
    runGetAllSchedules({
      encType: "bold",
      fills: [
        makeCell("Alice", { effectiveBold: true }),
        makeCell("Bob"),
        makeCell(),
        makeCell(),
        makeCell(),
      ],
    }).pipe(
      Effect.map((schedules) => {
        const schedule = getSchedule(schedules);

        expect(getFill(schedule, 0)).toMatchObject({ player: "Alice", enc: true });
        expect(getFill(schedule, 1)).toMatchObject({ player: "Bob", enc: false });
      }),
    ),
  );

  it.effect("falls back to user-entered format when effective format is absent", () =>
    runGetAllSchedules({
      encType: "bold",
      fills: [
        makeCell("Alice", { userEnteredBold: true }),
        makeCell(),
        makeCell(),
        makeCell(),
        makeCell(),
      ],
    }).pipe(
      Effect.map((schedules) => {
        const schedule = getSchedule(schedules);
        expect(getFill(schedule, 0)).toMatchObject({ player: "Alice", enc: true });
      }),
    ),
  );

  it.effect(
    "leaves all fills non-enc in bold mode when no cell is bold, even with suffix text",
    () =>
      runGetAllSchedules({
        encType: "bold",
        fills: [makeCell("Alice (enc)"), makeCell("Bob"), makeCell(), makeCell(), makeCell()],
        overfills: "Carol (e), Dana",
        standbys: "Erin (enc), Finn",
      }).pipe(
        Effect.map((schedules) => {
          const schedule = getSchedule(schedules);

          expect(getFill(schedule, 0)).toMatchObject({ player: "Alice (enc)", enc: false });
          expect(getFill(schedule, 1)).toMatchObject({ player: "Bob", enc: false });
          expect(schedule.overfills).toMatchObject([
            { player: "Carol (e)", enc: false },
            { player: "Dana", enc: false },
          ]);
          expect(schedule.standbys).toMatchObject([
            { player: "Erin (enc)", enc: false },
            { player: "Finn", enc: false },
          ]);
        }),
      ),
  );

  it.effect("marks every bold fill as enc in bold mode", () =>
    runGetAllSchedules({
      encType: "bold",
      fills: [
        makeCell("Alice", { effectiveBold: true }),
        makeCell("Bob"),
        makeCell("Carol", { userEnteredBold: true }),
        makeCell(),
        makeCell(),
      ],
    }).pipe(
      Effect.map((schedules) => {
        const schedule = getSchedule(schedules);

        expect(getFill(schedule, 0)).toMatchObject({ player: "Alice", enc: true });
        expect(getFill(schedule, 1)).toMatchObject({ player: "Bob", enc: false });
        expect(getFill(schedule, 2)).toMatchObject({ player: "Carol", enc: true });
      }),
    ),
  );

  it.effect("keeps regex enc parsing for fills, overfills, and standbys", () =>
    runGetAllSchedules({
      encType: "regex",
      fills: [makeCell("Alice (enc)"), makeCell("Bob"), makeCell(), makeCell(), makeCell()],
      overfills: "Carol (e), Dana",
      standbys: "Erin (enc), Finn",
    }).pipe(
      Effect.map((schedules) => {
        const schedule = getSchedule(schedules);

        expect(getFill(schedule, 0)).toMatchObject({ player: "Alice (enc)", enc: true });
        expect(getFill(schedule, 1)).toMatchObject({ player: "Bob", enc: false });
        expect(schedule.overfills).toMatchObject([
          { player: "Carol (e)", enc: true },
          { player: "Dana", enc: false },
        ]);
        expect(schedule.standbys).toMatchObject([
          { player: "Erin (enc)", enc: true },
          { player: "Finn", enc: false },
        ]);
      }),
    ),
  );

  it.effect("disables enc parsing entirely when encType is none", () =>
    runGetAllSchedules({
      encType: "none",
      fills: [
        makeCell("Alice (enc)", { effectiveBold: true }),
        makeCell(),
        makeCell(),
        makeCell(),
        makeCell(),
      ],
      overfills: "Carol (e)",
      standbys: "Erin (enc)",
    }).pipe(
      Effect.map((schedules) => {
        const schedule = getSchedule(schedules);

        expect(getFill(schedule, 0)).toMatchObject({ player: "Alice (enc)", enc: false });
        expect(schedule.overfills).toMatchObject([{ player: "Carol (e)", enc: false }]);
        expect(schedule.standbys).toMatchObject([{ player: "Erin (enc)", enc: false }]);
      }),
    ),
  );
});
