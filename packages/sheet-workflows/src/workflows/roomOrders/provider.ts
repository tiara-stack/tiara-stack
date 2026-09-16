import type { sheets_v4 } from "@googleapis/sheets";
import { Context, Data, Effect, Layer, Predicate } from "effect";
import type { ScheduleTimeReference, WebSheetConfiguration } from "sheet-domain";
import {
  eventConfigRange,
  indexSchedulesByHour,
  makeRunnerLocalSheetsClient,
  parseEventStart,
  readSheetsValueRanges,
  valueRowsAt,
} from "../shared/runnerLocalSheets";
import { loadWebConfigurationSheetAdapter } from "../shared/webConfigurationSheets";
import { loadLegacyScheduleTimeReference } from "../shared/legacyScheduleTimeReference";
import { makeUserScheduleProvider } from "../schedules/provider";

export class RoomOrderNavigationProviderError extends Data.TaggedError(
  "RoomOrderNavigationProviderError",
)<{
  readonly operation:
    | "create-client"
    | "read-event-configuration"
    | "read-schedule-configuration"
    | "read-schedule";
  readonly cause: unknown;
}> {}

interface RoomOrderNavigationProviderShape {
  readonly loadEventStart: (
    spreadsheetId: string,
    configuration?: WebSheetConfiguration | null,
  ) => Effect.Effect<number, RoomOrderNavigationProviderError>;
  readonly loadLegacyScheduleTimeReference: (options: {
    readonly spreadsheetId: string;
    readonly referenceInstantEpochMs: number;
    readonly configuration?: WebSheetConfiguration | null;
  }) => Effect.Effect<ScheduleTimeReference | undefined, RoomOrderNavigationProviderError>;
  readonly loadPreviousMonitor: (options: {
    readonly spreadsheetId: string;
    readonly conversationName: string;
    readonly hour: number;
    readonly configuration?: WebSheetConfiguration | null;
  }) => Effect.Effect<string | null | undefined, RoomOrderNavigationProviderError>;
}

export class RoomOrderNavigationProvider extends Context.Service<
  RoomOrderNavigationProvider,
  RoomOrderNavigationProviderShape
>()("sheet-workflows/RoomOrderNavigationProvider") {
  static readonly testLayer = (service: RoomOrderNavigationProvider["Service"]) =>
    Layer.succeed(RoomOrderNavigationProvider, service);
}

const makeProviderError =
  (operation: RoomOrderNavigationProviderError["operation"]) => (cause: unknown) =>
    new RoomOrderNavigationProviderError({ operation, cause });

export const roomOrderPreviousMonitorFromSchedules = (
  schedules: ReadonlyArray<{
    readonly channel?: string | undefined;
    readonly hour: number | null;
    readonly break: boolean;
    readonly monitor: string | null;
  }>,
  conversationName: string,
  hour: number,
): string | null | undefined => {
  const previous = indexSchedulesByHour(
    schedules.filter(({ channel }) => channel === conversationName),
  ).get(hour - 1);
  return previous === undefined ? undefined : previous.break ? null : previous.monitor;
};

const makeRoomOrderNavigationProvider = (
  client: sheets_v4.Sheets,
): RoomOrderNavigationProviderShape => {
  const scheduleProvider = makeUserScheduleProvider(client);
  return {
    loadEventStart: (spreadsheetId, configuration) =>
      (Predicate.isNullish(configuration)
        ? readSheetsValueRanges({
            client,
            spreadsheetId,
            ranges: [eventConfigRange],
            makeError: makeProviderError("read-event-configuration"),
          }).pipe(Effect.flatMap((ranges) => parseEventStart(valueRowsAt(ranges, 0))))
        : loadWebConfigurationSheetAdapter({
            client,
            spreadsheetId,
            configuration,
            makeError: makeProviderError("read-event-configuration"),
          }).pipe(Effect.flatMap(({ eventRows }) => parseEventStart(eventRows)))
      ).pipe(
        Effect.mapError((error) =>
          Predicate.isTagged("RoomOrderNavigationProviderError")(error)
            ? error
            : makeProviderError("read-event-configuration")(error),
        ),
      ),
    loadLegacyScheduleTimeReference: ({ spreadsheetId, referenceInstantEpochMs, configuration }) =>
      loadLegacyScheduleTimeReference({
        client,
        spreadsheetId,
        referenceInstantEpochMs,
        configuration,
        makeError: makeProviderError("read-schedule-configuration"),
      }),
    loadPreviousMonitor: ({ spreadsheetId, conversationName, hour, configuration }) =>
      scheduleProvider.loadAll(spreadsheetId, configuration).pipe(
        Effect.map(({ schedules }) =>
          roomOrderPreviousMonitorFromSchedules(schedules, conversationName, hour),
        ),
        Effect.mapError((error) => makeProviderError("read-schedule")(error)),
      ),
  };
};

export const roomOrderNavigationProviderLayer = Layer.effect(
  RoomOrderNavigationProvider,
  makeRunnerLocalSheetsClient(makeProviderError("create-client")).pipe(
    Effect.map(makeRoomOrderNavigationProvider),
  ),
);
