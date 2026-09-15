import type { sheets_v4 } from "@googleapis/sheets";
import { Context, Data, Effect, Layer, Predicate } from "effect";
import type { ScheduleTimeReference, WebSheetConfiguration } from "sheet-domain";
import {
  eventConfigRange,
  makeRunnerLocalSheetsClient,
  parseEventStart,
  readSheetsValueRanges,
  valueRowsAt,
} from "../shared/runnerLocalSheets";
import { loadWebConfigurationSheetAdapter } from "../shared/webConfigurationSheets";
import { loadLegacyScheduleTimeReference } from "../shared/legacyScheduleTimeReference";

export class RoomOrderNavigationProviderError extends Data.TaggedError(
  "RoomOrderNavigationProviderError",
)<{
  readonly operation: "create-client" | "read-event-configuration" | "read-schedule-configuration";
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

const makeRoomOrderNavigationProvider = (
  client: sheets_v4.Sheets,
): RoomOrderNavigationProviderShape => ({
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
});

export const roomOrderNavigationProviderLayer = Layer.effect(
  RoomOrderNavigationProvider,
  makeRunnerLocalSheetsClient(makeProviderError("create-client")).pipe(
    Effect.map(makeRoomOrderNavigationProvider),
  ),
);
