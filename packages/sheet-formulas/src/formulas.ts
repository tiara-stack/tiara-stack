import {
  Array,
  Effect,
  HashMap,
  Option,
  Number,
  pipe,
  Schema,
  Match,
  DateTime,
  Duration,
  String,
  SchemaGetter,
} from "effect";
import { HttpClient } from "effect/unstable/http";
import { layer as AppsScriptHttpClientLayer } from "effect-platform-apps-script";
import { makeWorkflowInvocationId } from "sheet-workflow-http-client";
import { SpreadsheetId, SheetReference } from "sheet-workflow-contracts";
import {
  calculationStatus,
  calculationStatusForError,
  makeAppsScriptWorkflowEnqueueClients,
  makeCalculationInvocationId,
  makeCalculationSheetReference,
  submitCalculation,
  type CalculationStatus,
  workflowHttpConfiguration,
} from "./calculationWorkflow";

const SETTING_SHEET_NAME = "Thee's Sheet Settings";

const cellValueValidator = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Date,
]);
type CellValue = typeof cellValueValidator.Type;

const calcConfigValidator = Schema.Struct({
  cc: Schema.Boolean,
  considerEnc: Schema.Boolean,
  healNeeded: Schema.Number,
});

function parsePlayers(players: CellValue[][]) {
  return pipe(
    players,
    Schema.decodeUnknownEffect(
      Schema.Array(
        pipe(
          Schema.Tuple([Schema.String, Schema.Boolean]),
          Schema.decodeTo(Schema.Struct({ name: Schema.String, encable: Schema.Boolean }), {
            decode: SchemaGetter.transform(([name, encable]) => ({ name, encable })),
            encode: SchemaGetter.transform(({ name, encable }) => [name, encable] as const),
          }),
        ),
      ),
    ),
  );
}

function parseFixedTeams(fixedTeams: CellValue[][]) {
  return pipe(
    fixedTeams,
    Schema.decodeUnknownEffect(
      pipe(
        Schema.Array(Schema.Tuple([Schema.String, Schema.Boolean])),
        Schema.decodeTo(
          Schema.Array(Schema.Struct({ name: Schema.String, heal: Schema.Boolean })),
          {
            decode: SchemaGetter.transform(Array.map(([name, heal]) => ({ name, heal }))),
            encode: SchemaGetter.transform(Array.map(({ name, heal }) => [name, heal] as const)),
          },
        ),
      ),
    ),
  );
}

export function THEECALC(
  _url: string,
  _config: CellValue[][],
  _p1: CellValue[][],
  _p2: CellValue[][],
  _p3: CellValue[][],
  _p4: CellValue[][],
  _p5: CellValue[][],
) {
  return [["The legacy formula-based calc is sunsetted. Use the button menu version instead."]];
}

export function theeCalc(calcSheet: GoogleAppsScript.Spreadsheet.Sheet) {
  const writeCalculationStatus = (hour: number, status: CalculationStatus) =>
    Effect.try({
      try: () => calcSheet.getRange(`AX30:AY30`).setValues([[hour, status]]),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) => Effect.logError(error)),
      Effect.asVoid,
    );
  const writeCalculationStatusOnly = (status: CalculationStatus) =>
    Effect.try({
      try: () => calcSheet.getRange("AY30").setValue(status),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) => Effect.logError(error)),
      Effect.asVoid,
    );
  const readCalculationHour = () =>
    Effect.try({
      try: () => calcSheet.getRange("D23").getValue(),
      catch: (error) => error,
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Number)));

  return Effect.runSync(
    pipe(
      Effect.Do,
      Effect.bind("hour", readCalculationHour),
      Effect.flatMap(({ hour }) =>
        pipe(
          Effect.Do,
          Effect.let("hour", () => hour),
          Effect.bind("config", () =>
            pipe(
              calcSheet.getRange("U30:V32").getValues(),
              Schema.decodeUnknownEffect(
                Schema.Array(Schema.Tuple([cellValueValidator, cellValueValidator])),
              ),
              Effect.map(HashMap.fromIterable),
              Effect.flatMap((config) =>
                pipe(
                  Effect.Do,
                  Effect.bind("cc", () => HashMap.get(config, "cc").pipe(Effect.fromOption)),
                  Effect.bind("considerEnc", () =>
                    HashMap.get(config, "consider_enc").pipe(Effect.fromOption),
                  ),
                  Effect.bind("healNeeded", () =>
                    HashMap.get(config, "heal_needed").pipe(Effect.fromOption),
                  ),
                ),
              ),
              Effect.flatMap(Schema.decodeUnknownEffect(calcConfigValidator)),
            ),
          ),
          Effect.bind("players", () =>
            pipe(
              calcSheet.getRange("AQ30:AR34").getValues(),
              Array.filter(([name]) => name !== ""),
              parsePlayers,
            ),
          ),
          Effect.bind("fixedTeams", () =>
            pipe(
              calcSheet.getRange("AU30:AV45").getValues(),
              Array.filter(([name]) => name !== ""),
              parseFixedTeams,
            ),
          ),
          Effect.bind("properties", () =>
            Effect.sync(() => PropertiesService.getDocumentProperties()),
          ),
          Effect.bind("spreadsheetId", () =>
            pipe(calcSheet.getParent().getId(), Schema.decodeUnknownEffect(SpreadsheetId)),
          ),
          Effect.bind("sheetRef", () =>
            pipe(
              makeCalculationSheetReference(calcSheet.getName()),
              Schema.decodeUnknownEffect(SheetReference),
            ),
          ),
          Effect.let("input", ({ config, fixedTeams, hour, players, sheetRef, spreadsheetId }) => ({
            spreadsheetId,
            sheetRef,
            hour,
            config,
            players,
            fixedTeams,
          })),
          Effect.bind("invocationId", ({ input, properties }) =>
            makeCalculationInvocationId(properties, input, () =>
              makeWorkflowInvocationId(() => Utilities.getUuid()),
            ),
          ),
          Effect.bind("workflowConfiguration", ({ properties, spreadsheetId }) =>
            workflowHttpConfiguration(properties, spreadsheetId),
          ),
          Effect.bind("httpClient", () => Effect.service(HttpClient.HttpClient)),
          Effect.bind("clients", ({ httpClient, workflowConfiguration }) =>
            Effect.succeed(makeAppsScriptWorkflowEnqueueClients(httpClient, workflowConfiguration)),
          ),
          Effect.flatMap(({ hour, invocationId, clients, input, properties }) =>
            pipe(
              submitCalculation({
                properties,
                client: clients.calculations.recalculateSheet,
                input,
                invocationId,
                beforeRequest: writeCalculationStatus(hour, calculationStatus.submitting),
              }),
              Effect.tap(() => writeCalculationStatus(hour, calculationStatus.queued)),
            ),
          ),
          Effect.tapError((error) =>
            pipe(
              Effect.logError(error),
              Effect.andThen(
                calculationStatusForError(error) === calculationStatus.submitting
                  ? Effect.void
                  : writeCalculationStatus(hour, calculationStatus.didNotStart),
              ),
            ),
          ),
          Effect.catch(() => Effect.void),
        ),
      ),
      Effect.asVoid,
      Effect.provide(AppsScriptHttpClientLayer),
      Effect.catch((error) =>
        pipe(
          Effect.logError(error),
          Effect.andThen(writeCalculationStatusOnly(calculationStatus.didNotStart)),
        ),
      ),
    ),
  );
}

export function copyRange({
  sourceSheet,
  targetSheet,
  rows,
  sourceRowStart,
  sourceColumnStart,
  sourceColumnEnd,
  targetRowStart,
  targetColumnStart,
  targetColumnEnd,
}: {
  sourceSheet: GoogleAppsScript.Spreadsheet.Sheet;
  targetSheet: GoogleAppsScript.Spreadsheet.Sheet;
  rows: number;
  sourceRowStart: number;
  sourceColumnStart: string;
  sourceColumnEnd: string;
  targetRowStart: number;
  targetColumnStart: string;
  targetColumnEnd: string;
}) {
  const sourceRange = sourceSheet.getRange(
    `${sourceColumnStart}${sourceRowStart}:${sourceColumnEnd}${sourceRowStart + rows}`,
  );
  const targetRange = targetSheet.getRange(
    `${targetColumnStart}${targetRowStart}:${targetColumnEnd}${targetRowStart + rows}`,
  );

  targetRange.setValues(sourceRange.getValues());
  targetRange.setFontWeights(sourceRange.getFontWeights());
}

export function TZSHORTSTAMPS(start: CellValue, tzs: CellValue[][], hours: CellValue[][]) {
  return Effect.runSync(
    pipe(
      Effect.Do,
      Effect.bind("start", () =>
        pipe(
          start,
          Schema.decodeUnknownEffect(
            pipe(
              Schema.Number,
              Schema.decodeTo(Schema.Number, {
                decode: SchemaGetter.transform(Number.multiply(1000)),
                encode: SchemaGetter.transform(Number.divideUnsafe(1000)),
              }),
              Schema.decodeTo(Schema.DateTimeUtcFromMillis, {
                decode: SchemaGetter.passthrough(),
                encode: SchemaGetter.passthrough(),
              }),
            ),
          ),
        ),
      ),
      Effect.bind("tzs", () =>
        pipe(tzs, Array.flatten, Schema.decodeUnknownEffect(Schema.Array(Schema.String))),
      ),
      Effect.bind("hours", () =>
        pipe(hours, Array.flatten, Schema.decodeUnknownEffect(Schema.Array(Schema.Number))),
      ),
      Effect.andThen(({ start, tzs, hours }) =>
        pipe(
          hours,
          Effect.forEach((hour) =>
            pipe(
              Effect.Do,
              Effect.let("startTime", () =>
                pipe(start, DateTime.addDuration(Duration.hours(hour - 1))),
              ),
              Effect.map(({ startTime }) =>
                pipe(
                  tzs,
                  Array.map((tz) =>
                    pipe(
                      Option.Do,
                      Option.bind("startTimeTz", () =>
                        DateTime.makeZoned(startTime, { timeZone: tz }),
                      ),
                      Option.let("startTimeTzHours", ({ startTimeTz }) =>
                        pipe(
                          startTimeTz,
                          DateTime.getPart("hour"),
                          (n) => n.toString(),
                          String.padStart(2, "0"),
                        ),
                      ),
                      Option.let("startTimeTzMinutes", ({ startTimeTz }) =>
                        pipe(
                          startTimeTz,
                          DateTime.getPart("minute"),
                          (n) => n.toString(),
                          String.padStart(2, "0"),
                        ),
                      ),
                      Option.map(
                        ({ startTimeTzHours, startTimeTzMinutes }) =>
                          `${startTimeTzHours}:${startTimeTzMinutes}`,
                      ),
                      Option.getOrElse(() => ""),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
      Effect.orDie,
    ),
  );
}

export function TZLONGSTAMPS(start: CellValue, tzs: CellValue[][], hours: CellValue[][]) {
  return Effect.runSync(
    pipe(
      Effect.Do,
      Effect.bind("start", () =>
        pipe(
          start,
          Schema.decodeUnknownEffect(
            pipe(
              Schema.Number,
              Schema.decodeTo(Schema.Number, {
                decode: SchemaGetter.transform(Number.multiply(1000)),
                encode: SchemaGetter.transform(Number.divideUnsafe(1000)),
              }),
              Schema.decodeTo(Schema.DateTimeUtcFromMillis, {
                decode: SchemaGetter.passthrough(),
                encode: SchemaGetter.passthrough(),
              }),
            ),
          ),
        ),
      ),
      Effect.bind("tzs", () =>
        pipe(tzs, Array.flatten, Schema.decodeUnknownEffect(Schema.Array(Schema.String))),
      ),
      Effect.bind("hours", () =>
        pipe(hours, Array.flatten, Schema.decodeUnknownEffect(Schema.Array(Schema.Number))),
      ),
      Effect.andThen(({ start, tzs, hours }) =>
        pipe(
          hours,
          Effect.forEach((hour) =>
            pipe(
              Effect.Do,
              Effect.let("startTime", () =>
                pipe(start, DateTime.addDuration(Duration.hours(hour - 1))),
              ),
              Effect.let("endTime", () => pipe(start, DateTime.addDuration(Duration.hours(hour)))),
              Effect.map(({ startTime, endTime }) =>
                pipe(
                  tzs,
                  Array.map((tz) =>
                    pipe(
                      Option.Do,
                      Option.bind("startTimeTz", () =>
                        DateTime.makeZoned(startTime, { timeZone: tz }),
                      ),
                      Option.bind("endTimeTz", () => DateTime.makeZoned(endTime, { timeZone: tz })),
                      Option.let("startTimeTzHours", ({ startTimeTz }) =>
                        pipe(
                          startTimeTz,
                          DateTime.getPart("hour"),
                          (n) => n.toString(),
                          String.padStart(2, "0"),
                        ),
                      ),
                      Option.let("startTimeTzMinutes", ({ startTimeTz }) =>
                        pipe(
                          startTimeTz,
                          DateTime.getPart("minute"),
                          (n) => n.toString(),
                          String.padStart(2, "0"),
                        ),
                      ),
                      Option.let("endTimeTzHours", ({ endTimeTz }) =>
                        pipe(
                          endTimeTz,
                          DateTime.getPart("hour"),
                          (n) => n.toString(),
                          String.padStart(2, "0"),
                        ),
                      ),
                      Option.let("endTimeTzMinutes", ({ endTimeTz }) =>
                        pipe(
                          endTimeTz,
                          DateTime.getPart("minute"),
                          (n) => n.toString(),
                          String.padStart(2, "0"),
                        ),
                      ),
                      Option.map(
                        ({
                          startTimeTzHours,
                          startTimeTzMinutes,
                          endTimeTzHours,
                          endTimeTzMinutes,
                        }) =>
                          `${startTimeTzHours}:${startTimeTzMinutes} - ${endTimeTzHours}:${endTimeTzMinutes}`,
                      ),
                      Option.getOrElse(() => ""),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
      Effect.orDie,
    ),
  );
}

export function tzLongStamps({
  sheet,
  tzsRow,
  tzsColumnStart,
  tzsColumnEnd,
  hoursColumn,
  hoursRowStart,
  hoursRowEnd,
}: {
  sheet: GoogleAppsScript.Spreadsheet.Sheet;
  tzsRow: number;
  tzsColumnStart: string;
  tzsColumnEnd: string;
  hoursColumn: string;
  hoursRowStart: number;
  hoursRowEnd: number;
}) {
  return Effect.runSync(
    pipe(
      Effect.all(
        {
          settingSheet: Option.fromNullishOr(
            SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SETTING_SHEET_NAME),
          ).pipe(Effect.fromOption),
        },
        { concurrency: "unbounded" },
      ),
      Effect.bind("start", ({ settingSheet }) =>
        pipe(
          settingSheet.getRange("P8").getValue(),
          Schema.decodeUnknownEffect(
            pipe(
              Schema.Number,
              Schema.decodeTo(Schema.Number, {
                decode: SchemaGetter.transform(Number.multiply(1000)),
                encode: SchemaGetter.transform(Number.divideUnsafe(1000)),
              }),
              Schema.decodeTo(Schema.DateTimeUtcFromMillis, {
                decode: SchemaGetter.passthrough(),
                encode: SchemaGetter.passthrough(),
              }),
            ),
          ),
        ),
      ),
      Effect.bind("tzsLookup", ({ settingSheet }) =>
        pipe(
          settingSheet.getRange("AL8:AM").getValues(),
          Schema.decodeUnknownEffect(Schema.Array(Schema.Tuple([Schema.String, Schema.String]))),
          Effect.map(HashMap.fromIterable),
        ),
      ),
      Effect.bind("tzs", ({ tzsLookup }) =>
        pipe(
          sheet.getRange(`${tzsColumnStart}${tzsRow}:${tzsColumnEnd}${tzsRow}`).getValues(),
          Array.flatten,
          Schema.decodeUnknownEffect(Schema.Array(Schema.String)),
          Effect.map(
            Array.map((tz) =>
              pipe(
                HashMap.get(tzsLookup, tz),
                Option.getOrElse(() => tz),
              ),
            ),
          ),
        ),
      ),
      Effect.bind("hours", () =>
        pipe(
          sheet.getRange(`${hoursColumn}${hoursRowStart}:${hoursColumn}${hoursRowEnd}`).getValues(),
          Array.flatten,
          Schema.decodeUnknownEffect(Schema.Array(Schema.Number)),
        ),
      ),
      Effect.andThen(({ start, tzs, hours }) =>
        Effect.forEach(hours, (hour) =>
          pipe(
            Effect.Do,
            Effect.let("startTime", () =>
              pipe(start, DateTime.addDuration(Duration.hours(hour - 1))),
            ),
            Effect.let("endTime", () => pipe(start, DateTime.addDuration(Duration.hours(hour)))),
            Effect.map(({ startTime, endTime }) =>
              Array.map(tzs, (tz) =>
                pipe(
                  Option.Do,
                  Option.bind("startTimeTz", () => DateTime.makeZoned(startTime, { timeZone: tz })),
                  Option.bind("endTimeTz", () => DateTime.makeZoned(endTime, { timeZone: tz })),
                  Option.let("startTimeTzHours", ({ startTimeTz }) =>
                    pipe(
                      startTimeTz,
                      DateTime.getPart("hour"),
                      (n) => n.toString(),
                      String.padStart(2, "0"),
                    ),
                  ),
                  Option.let("startTimeTzMinutes", ({ startTimeTz }) =>
                    pipe(
                      startTimeTz,
                      DateTime.getPart("minute"),
                      (n) => n.toString(),
                      String.padStart(2, "0"),
                    ),
                  ),
                  Option.let("endTimeTzHours", ({ endTimeTz }) =>
                    pipe(
                      endTimeTz,
                      DateTime.getPart("hour"),
                      (n) => n.toString(),
                      String.padStart(2, "0"),
                    ),
                  ),
                  Option.let("endTimeTzMinutes", ({ endTimeTz }) =>
                    pipe(
                      endTimeTz,
                      DateTime.getPart("minute"),
                      (n) => n.toString(),
                      String.padStart(2, "0"),
                    ),
                  ),
                  Option.map(
                    ({ startTimeTzHours, startTimeTzMinutes, endTimeTzHours, endTimeTzMinutes }) =>
                      `${startTimeTzHours}:${startTimeTzMinutes} - ${endTimeTzHours}:${endTimeTzMinutes}`,
                  ),
                  Option.getOrElse(() => ""),
                ),
              ),
            ),
          ),
        ),
      ),
      Effect.andThen((result) =>
        Effect.sync(() =>
          sheet
            .getRange(`${tzsColumnStart}${hoursRowStart}:${tzsColumnEnd}${hoursRowEnd}`)
            .setValues(result),
        ),
      ),
      Effect.orDie,
    ),
  );
}

export function onEditInstallable(e: GoogleAppsScript.Events.SheetsOnEdit) {
  pipe(
    Match.value({
      template: e.range.getSheet().getRange("A2").getValue(),
      toyaTemplate: e.range.getSheet().getRange("A1").getValue(),
      name: e.range.getSheet().getName(),
      cell: e.range.getA1Notation(),
    }),
    Match.whenOr(
      {
        template: "Template: UniversalTeamCalc v1.17 on TheeCalc v7.0",
        cell: "B27",
      },
      {
        template: "Template: UniversalTeamCalc v1.17 on TheeCalc v8.0",
        cell: "B27",
      },
      () => {
        theeCalc(e.range.getSheet());
      },
    ),
    Match.when(
      {
        toyaTemplate: "Template: Toya Schedule v1.0",
        cell: "D28",
      },
      () => {
        const scheduleSheet = e.range.getSheet();

        tzLongStamps({
          sheet: scheduleSheet,
          tzsRow: 2,
          tzsColumnStart: "D",
          tzsColumnEnd: "H",
          hoursColumn: "J",
          hoursRowStart: 3,
          hoursRowEnd: 26,
        });
      },
    ),
    Match.when(
      {
        template: "Template: Drafter v1.0",
        cell: "S13",
      },
      () => {
        const drafterSheet = e.range.getSheet();
        const rows =
          drafterSheet.getRange("C13").getValue() - drafterSheet.getRange("C12").getValue() + 1;
        const scheduleSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
          drafterSheet.getRange("S12").getValue(),
        );

        if (scheduleSheet) {
          copyRange({
            sourceSheet: drafterSheet,
            targetSheet: scheduleSheet,
            rows,
            sourceRowStart: 16,
            sourceColumnStart: "P",
            sourceColumnEnd: "AJ",
            targetRowStart: 11,
            targetColumnStart: "D",
            targetColumnEnd: "X",
          });
        }
      },
    ),
    Match.when(
      {
        template: "Template: Drafter v1.1",
        cell: "S13",
      },
      () => {
        const drafterSheet = e.range.getSheet();
        const rows =
          drafterSheet.getRange("C13").getValue() - drafterSheet.getRange("C12").getValue() + 1;
        const scheduleSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
          drafterSheet.getRange("S12").getValue(),
        );

        if (scheduleSheet) {
          copyRange({
            sourceSheet: drafterSheet,
            targetSheet: scheduleSheet,
            rows,
            sourceRowStart: 18,
            sourceColumnStart: "P",
            sourceColumnEnd: "AJ",
            targetRowStart: 13,
            targetColumnStart: "D",
            targetColumnEnd: "X",
          });
        }
      },
    ),
    Match.when(
      {
        template: "Template: Drafter v1.1",
        cell: "S15",
      },
      () => {
        const drafterSheet = e.range.getSheet();
        const rows =
          drafterSheet.getRange("C13").getValue() - drafterSheet.getRange("C12").getValue() + 1;

        tzLongStamps({
          sheet: drafterSheet,
          tzsRow: 18,
          tzsColumnStart: "P",
          tzsColumnEnd: "T",
          hoursColumn: "U",
          hoursRowStart: 19,
          hoursRowEnd: 19 + rows - 1,
        });
      },
    ),
    Match.orElse(() => {}),
  );
}
