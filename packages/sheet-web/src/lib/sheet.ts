import { Atom, Result, useAtomSuspense } from "@effect-atom/atom-react";
import { Sheet, Google, SheetConfig, Middlewares } from "sheet-apis/schema";
import { SheetApisClient } from "#/lib/sheetApis";
import { Effect, Schema } from "effect";
import {
  catchParseErrorAsValidationError,
  QueryResultError,
  ValidationError,
} from "typhoon-core/error";
import { RequestError, ResponseError } from "#/lib/error";
import { useMemo } from "react";

// Private atom for fetching event config (includes startTime)
const _eventConfigAtom = Atom.family((guildId: string) =>
  SheetApisClient.query("sheet", "getEventConfig", { urlParams: { guildId } }),
);

// Error type for event config requests - must match all possible errors including ParserFieldError from catchParseErrorAsValidationError
const EventConfigError = Schema.Union(
  ValidationError,
  QueryResultError,
  Google.GoogleSheetsError,
  Sheet.ParserFieldError,
  SheetConfig.SheetConfigError,
  Middlewares.Unauthorized,
  RequestError,
  ResponseError,
);

// Serializable atom for event config
export const eventConfigAtom = Atom.family((guildId: string) =>
  Atom.make(
    Effect.fnUntraced(function* (get) {
      return yield* get.result(_eventConfigAtom(guildId)).pipe(
        catchParseErrorAsValidationError,
        Effect.catchTags({
          RequestError: (error) => Effect.fail(RequestError.make(error)),
          ResponseError: (error) => Effect.fail(ResponseError.make(error)),
        }),
      );
    }),
  ).pipe(
    Atom.serializable({
      key: `sheet.getEventConfig.${guildId}`,
      schema: Result.Schema({
        success: SheetConfig.EventConfig,
        error: EventConfigError,
      }),
    }),
  ),
);

// Hook to use event config (includes startTime)
export const useEventConfig = (guildId: string) => {
  const atom = useMemo(() => eventConfigAtom(guildId), [guildId]);
  const result = useAtomSuspense(atom, {
    suspendOnWaiting: true,
    includeFailure: false,
  });
  return result.value;
};
