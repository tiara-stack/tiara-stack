import type { sheets_v4 } from "@googleapis/sheets";
import { Effect } from "effect";
import {
  scheduleTimeReferenceFromLegacy,
  type ScheduleTimeReference,
  type WebSheetConfiguration,
} from "sheet-domain";
import {
  mapScheduleRows,
  parseScheduleConfigurations,
  quotedRange,
  readBatchedSheetsValueRanges,
  scheduleConfigRange,
  scheduleHour,
  valueRowsAt,
} from "./runnerLocalSheets";
import { loadConfigurationValueRanges } from "./webConfigurationSheets";

/**
 * Reads every configured schedule hour range for an unresolved legacy source. This keeps the
 * compatibility adapter workspace-wide instead of allowing a conversation filter to redefine the
 * event clock.
 */
export const loadLegacyScheduleTimeReference = <E extends { readonly cause: unknown }>(options: {
  readonly client: sheets_v4.Sheets;
  readonly spreadsheetId: string;
  readonly referenceInstantEpochMs: number;
  readonly configuration: WebSheetConfiguration | null | undefined;
  readonly makeError: (cause: unknown) => E;
}): Effect.Effect<ScheduleTimeReference | undefined, E> =>
  Effect.gen(function* () {
    const configurationRanges = yield* loadConfigurationValueRanges({
      client: options.client,
      spreadsheetId: options.spreadsheetId,
      configuration: options.configuration,
      legacyRanges: [scheduleConfigRange],
      selectConfiguredRows: ({ schedulesRows }) => [schedulesRows],
      makeError: options.makeError,
    });
    const schedules = yield* parseScheduleConfigurations(valueRowsAt(configurationRanges, 0)).pipe(
      Effect.mapError(options.makeError),
    );
    if (schedules.length === 0) return undefined;
    const values = yield* readBatchedSheetsValueRanges({
      client: options.client,
      spreadsheetId: options.spreadsheetId,
      ranges: schedules.map((schedule) => quotedRange(schedule, schedule.hourRange)),
      makeError: options.makeError,
    });
    const hours = schedules.flatMap((schedule, index) => {
      const rows = valueRowsAt(values, index);
      return mapScheduleRows(rows.length, (rowIndex) => scheduleHour(rows, rowIndex));
    });
    return scheduleTimeReferenceFromLegacy(options.referenceInstantEpochMs, hours);
  });
