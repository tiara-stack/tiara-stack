import { Context, Data, Effect, Layer } from "effect";
import { type ScheduleTimeReference, type WebSheetConfiguration } from "sheet-domain";
import { makeRunnerLocalSheetsClient } from "../shared/runnerLocalSheets";
import { readConfiguredEventStart } from "../shared/webConfigurationSheets";
import { loadLegacyScheduleTimeReference } from "../shared/legacyScheduleTimeReference";

export class AutonomousTriggerProviderError extends Data.TaggedError(
  "AutonomousTriggerProviderError",
)<{
  readonly operation: "create-client" | "read-event-configuration" | "read-schedule-configuration";
  readonly cause: unknown;
}> {}

interface AutonomousTriggerProviderShape {
  readonly loadEventStart: (
    spreadsheetId: string,
    configuration?: WebSheetConfiguration | null,
  ) => Effect.Effect<number, AutonomousTriggerProviderError>;
  /** Collects all configured legacy rows before resolving one explicit timing reference. */
  readonly loadLegacyScheduleTimeReference: (options: {
    readonly spreadsheetId: string;
    readonly referenceInstantEpochMs: number;
    readonly configuration?: WebSheetConfiguration | null;
  }) => Effect.Effect<ScheduleTimeReference | undefined, AutonomousTriggerProviderError>;
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
        loadLegacyScheduleTimeReference: ({
          spreadsheetId,
          referenceInstantEpochMs,
          configuration,
        }) =>
          loadLegacyScheduleTimeReference({
            client,
            spreadsheetId,
            referenceInstantEpochMs,
            configuration,
            makeError: makeProviderError("read-schedule-configuration"),
          }),
      };
    }),
  ),
);
