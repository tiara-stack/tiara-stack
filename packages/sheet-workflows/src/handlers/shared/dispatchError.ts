import type { Schema } from "effect";
import {
  ArgumentError,
  makeUnknownError,
  SchemaError,
  Unauthorized,
  UnknownError,
} from "typhoon-core/error";
import type { QueryResultError } from "typhoon-zero/error";
import type { GoogleSheetsError } from "sheet-ingress-api/schemas/google";
import type { ParserFieldError } from "sheet-ingress-api/schemas/sheet/error";
import type { SheetConfigError } from "sheet-ingress-api/schemas/sheetConfig";

type DispatchError =
  | GoogleSheetsError
  | ParserFieldError
  | SheetConfigError
  | Schema.Schema.Type<typeof SchemaError>
  | QueryResultError
  | ArgumentError
  | Unauthorized
  | UnknownError;

const knownDispatchErrorTags = new Set([
  "GoogleSheetsError",
  "ParserFieldError",
  "SheetConfigError",
  "SchemaError",
  "QueryResultAppError",
  "QueryResultParseError",
  "ArgumentError",
  "Unauthorized",
  "UnknownError",
]);

export const normalizeDispatchError =
  (message: string): ((error: unknown) => DispatchError) =>
  (error) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      typeof error._tag === "string" &&
      knownDispatchErrorTags.has(error._tag)
    ) {
      return error as DispatchError;
    }

    return makeUnknownError(message, error);
  };
