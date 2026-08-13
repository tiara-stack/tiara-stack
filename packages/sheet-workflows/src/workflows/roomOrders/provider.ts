import type { sheets_v4 } from "@googleapis/sheets";
import { Context, Data, Effect, Layer, Predicate } from "effect";
import {
  eventConfigRange,
  makeRunnerLocalSheetsClient,
  parseEventStart,
  readSheetsValueRanges,
  valueRowsAt,
} from "../shared/runnerLocalSheets";

export class RoomOrderNavigationProviderError extends Data.TaggedError(
  "RoomOrderNavigationProviderError",
)<{
  readonly operation: "create-client" | "read-event-configuration";
  readonly cause: unknown;
}> {}

interface RoomOrderNavigationProviderShape {
  readonly loadEventStart: (
    spreadsheetId: string,
  ) => Effect.Effect<number, RoomOrderNavigationProviderError>;
}

export class RoomOrderNavigationProvider extends Context.Service<
  RoomOrderNavigationProvider,
  RoomOrderNavigationProviderShape
>()("sheet-workflows/RoomOrderNavigationProvider") {}

const makeProviderError =
  (operation: RoomOrderNavigationProviderError["operation"]) => (cause: unknown) =>
    new RoomOrderNavigationProviderError({ operation, cause });

const makeRoomOrderNavigationProvider = (
  client: sheets_v4.Sheets,
): RoomOrderNavigationProviderShape => ({
  loadEventStart: (spreadsheetId) =>
    readSheetsValueRanges({
      client,
      spreadsheetId,
      ranges: [eventConfigRange],
      makeError: makeProviderError("read-event-configuration"),
    }).pipe(
      Effect.flatMap((ranges) => parseEventStart(valueRowsAt(ranges, 0))),
      Effect.mapError((error) =>
        Predicate.isTagged("RoomOrderNavigationProviderError")(error)
          ? error
          : makeProviderError("read-event-configuration")(error),
      ),
    ),
});

export const roomOrderNavigationProviderLayer = Layer.effect(
  RoomOrderNavigationProvider,
  makeRunnerLocalSheetsClient(makeProviderError("create-client")).pipe(
    Effect.map(makeRoomOrderNavigationProvider),
  ),
);
