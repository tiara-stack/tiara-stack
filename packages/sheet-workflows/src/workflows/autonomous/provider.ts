import { Context, Data, Effect, Layer, Predicate } from "effect";
import { scheduleHourOrigin, type WebSheetConfiguration } from "sheet-domain";
import {
  mapScheduleRows,
  makeRunnerLocalSheetsClient,
  parseScheduleConfigurations,
  quotedRange,
  readBatchedSheetsValueRanges,
  scheduleConfigRange,
  scheduleHour,
  type ValueRows,
  valueRowsAt,
} from "../shared/runnerLocalSheets";
import {
  loadConfigurationValueRanges,
  readConfiguredEventStart,
} from "../shared/webConfigurationSheets";

export class AutonomousTriggerProviderError extends Data.TaggedError(
  "AutonomousTriggerProviderError",
)<{
  readonly operation: "create-client" | "read-event-configuration" | "read-schedule-configuration";
  readonly cause: unknown;
}> {}

export const scheduleHourOriginFor = (
  schedules: ReadonlyArray<{ readonly hour: number | null }>,
): number | undefined => {
  const hours = schedules.flatMap(({ hour }) => (Predicate.isNull(hour) ? [] : [hour]));
  return hours.length === 0 ? undefined : scheduleHourOrigin(hours);
};

interface AutonomousTriggerProviderShape {
  readonly loadEventStart: (
    spreadsheetId: string,
    configuration?: WebSheetConfiguration | null,
  ) => Effect.Effect<number, AutonomousTriggerProviderError>;
  readonly loadScheduleHourOrigin: (
    spreadsheetId: string,
    configuration?: WebSheetConfiguration | null,
  ) => Effect.Effect<number | undefined, AutonomousTriggerProviderError>;
}

export class AutonomousTriggerProvider extends Context.Service<
  AutonomousTriggerProvider,
  AutonomousTriggerProviderShape
>()("sheet-workflows/AutonomousTriggerProvider") {}

const makeProviderError =
  (operation: AutonomousTriggerProviderError["operation"]) => (cause: unknown) =>
    new AutonomousTriggerProviderError({ operation, cause });

export const autonomousTriggerProviderLayer = Layer.effect(
  AutonomousTriggerProvider,
  makeRunnerLocalSheetsClient(makeProviderError("create-client")).pipe(
    Effect.map((client) => {
      return {
        loadEventStart: (spreadsheetId: string, configuration?: WebSheetConfiguration | null) =>
          readConfiguredEventStart({
            client,
            spreadsheetId,
            configuration,
            makeError: makeProviderError("read-event-configuration"),
          }),
        loadScheduleHourOrigin: (
          spreadsheetId: string,
          configuration?: WebSheetConfiguration | null,
        ) =>
          Effect.gen(function* () {
            const configurationRanges = yield* loadConfigurationValueRanges({
              client,
              spreadsheetId,
              configuration,
              legacyRanges: [scheduleConfigRange],
              selectConfiguredRows: ({ schedulesRows }) => [schedulesRows],
              makeError: makeProviderError("read-schedule-configuration"),
            });
            const schedules = yield* parseScheduleConfigurations(
              valueRowsAt(configurationRanges, 0),
            ).pipe(Effect.mapError(makeProviderError("read-schedule-configuration")));
            if (schedules.length === 0) return undefined;
            const values = yield* readBatchedSheetsValueRanges({
              client,
              spreadsheetId,
              ranges: schedules.map((schedule) => quotedRange(schedule, schedule.hourRange)),
              makeError: makeProviderError("read-schedule-configuration"),
            });
            const hourRows = schedules.flatMap((schedule, index) => {
              const rows: ValueRows = valueRowsAt(values, index);
              return mapScheduleRows(rows.length, (rowIndex) => ({
                channel: schedule.channel,
                hour: scheduleHour(rows, rowIndex),
              }));
            });
            return scheduleHourOriginFor(hourRows);
          }),
      };
    }),
  ),
);
