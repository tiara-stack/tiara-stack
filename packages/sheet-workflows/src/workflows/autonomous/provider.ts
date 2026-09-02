import { Context, Data, Effect, Layer } from "effect";
import type { WebSheetConfiguration } from "sheet-domain";
import { makeRunnerLocalSheetsClient } from "../shared/runnerLocalSheets";
import { readConfiguredEventStart } from "../shared/webConfigurationSheets";

export class AutonomousTriggerProviderError extends Data.TaggedError(
  "AutonomousTriggerProviderError",
)<{
  readonly operation: "create-client" | "read-event-configuration";
  readonly cause: unknown;
}> {}

interface AutonomousTriggerProviderShape {
  readonly loadEventStart: (
    spreadsheetId: string,
    configuration?: WebSheetConfiguration | null,
  ) => Effect.Effect<number, AutonomousTriggerProviderError>;
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
    Effect.map((client) => ({
      loadEventStart: (spreadsheetId: string, configuration?: WebSheetConfiguration | null) =>
        readConfiguredEventStart({
          client,
          spreadsheetId,
          configuration,
          makeError: makeProviderError("read-event-configuration"),
        }),
    })),
  ),
);
