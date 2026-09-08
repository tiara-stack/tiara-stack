import { Effect, Predicate, Schema } from "effect";
import {
  SheetConfigurationDiagnostic,
  validateDecodedWebSheetConfiguration,
  WebSheetConfiguration,
} from "./configuration";

export const sheetConfigurationFileFormat = "tiarastack.sheet-configuration" as const;
export const sheetConfigurationFileVersion = 1 as const;
export const maximumSheetConfigurationFileBytes = 1_048_576;

/** The portable, workspace-independent file format for a complete web configuration. */
export const SheetConfigurationFile = Schema.Struct({
  format: Schema.Literal(sheetConfigurationFileFormat),
  version: Schema.Literal(sheetConfigurationFileVersion),
  configuration: WebSheetConfiguration,
});
export type SheetConfigurationFile = Schema.Schema.Type<typeof SheetConfigurationFile>;

export type SheetConfigurationFileInspection = {
  readonly configuration: typeof WebSheetConfiguration.Type | null;
  readonly diagnostics: ReadonlyArray<typeof SheetConfigurationDiagnostic.Type>;
};

const invalidFileDiagnostic = (message: string): typeof SheetConfigurationDiagnostic.Type => ({
  code: "InvalidSchema",
  path: "file",
  message,
  severity: "error",
});

const schemaErrorMessage = (error: unknown): string =>
  Schema.isSchemaError(error)
    ? `The file does not match the Sheet Configuration file format: ${error.message}`
    : "The file does not match the Sheet Configuration file format.";

export const makeSheetConfigurationFile = (
  configuration: typeof WebSheetConfiguration.Type,
): SheetConfigurationFile => ({
  format: sheetConfigurationFileFormat,
  version: sheetConfigurationFileVersion,
  configuration,
});

/** Serializes a complete configuration without workspace or revision metadata. */
export const serializeSheetConfigurationFile = (
  configuration: typeof WebSheetConfiguration.Type,
): string => JSON.stringify(makeSheetConfigurationFile(configuration), null, 2) + "\n";

export const formatSheetConfigurationSummary = (
  configuration: typeof WebSheetConfiguration.Type,
): string =>
  [
    `${configuration.teams.length} team${configuration.teams.length === 1 ? "" : "s"}`,
    `${configuration.schedules.length} schedule${configuration.schedules.length === 1 ? "" : "s"}`,
    `${configuration.runners.length} runner${configuration.runners.length === 1 ? "" : "s"}`,
  ].join(", ");

const invalidTextInspection = (message: string): SheetConfigurationFileInspection => ({
  configuration: null,
  diagnostics: [invalidFileDiagnostic(message)],
});

/**
 * Decodes and validates untrusted file data without throwing. A schema failure has no usable
 * configuration; a cross-field failure keeps the decoded configuration available for diagnostics.
 */
export const inspectSheetConfigurationFile = (
  input: unknown,
): Effect.Effect<SheetConfigurationFileInspection, never> =>
  Schema.decodeUnknownEffect(SheetConfigurationFile)(input, { onExcessProperty: "error" }).pipe(
    Effect.flatMap((file) =>
      Effect.succeed({
        configuration: file.configuration,
        diagnostics: validateDecodedWebSheetConfiguration(file.configuration),
      }),
    ),
    Effect.catch((error) =>
      Effect.succeed({
        configuration: null,
        diagnostics: [invalidFileDiagnostic(schemaErrorMessage(error))],
      }),
    ),
  );

/** Reads raw UTF-8 file text, applies the transport-independent size limit, and validates it. */
export const inspectSheetConfigurationFileText = (
  text: string,
): Effect.Effect<SheetConfigurationFileInspection, never> => {
  if (new TextEncoder().encode(text).byteLength > maximumSheetConfigurationFileBytes) {
    return Effect.succeed(invalidTextInspection("Configuration files must be 1 MiB or smaller."));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return Effect.succeed(invalidTextInspection("The configuration file is not valid JSON."));
  }
  return inspectSheetConfigurationFile(parsed);
};

export const isSheetConfigurationFileInspectionValid = (
  inspection: SheetConfigurationFileInspection,
): inspection is SheetConfigurationFileInspection & {
  readonly configuration: typeof WebSheetConfiguration.Type;
} =>
  Predicate.isNotNull(inspection.configuration) &&
  inspection.diagnostics.every(({ severity }) => severity !== "error");
