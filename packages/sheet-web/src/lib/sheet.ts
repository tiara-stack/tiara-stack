import { useAtomSuspense } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { Sheet, Google, SheetConfig } from "sheet-apis/schema";
import { SheetApisClient } from "#/lib/sheetApis";
import { Schema } from "effect";
import { SchemaError } from "typhoon-core/error";
import { QueryResultAppError, QueryResultParseError } from "typhoon-zero/error";
import { useMemo } from "react";

// Private atom for fetching event config (includes startTime)
const _eventConfigAtom = Atom.family((guildId: string) =>
  SheetApisClient.query("sheet", "getEventConfig", { query: { workspaceId: guildId } }),
);

type EventConfig = Schema.Schema.Type<typeof SheetConfig.EventConfig>;
type EventConfigError =
  | Schema.SchemaError
  | QueryResultAppError
  | QueryResultParseError
  | Google.GoogleSheetsError
  | Sheet.ParserFieldError
  | SheetConfig.SheetConfigError;

const EventConfigErrorSchema: Schema.Codec<EventConfigError, any> = Schema.revealCodec(
  Schema.Union([
    SchemaError,
    QueryResultAppError,
    QueryResultParseError,
    Google.GoogleSheetsError,
    Sheet.ParserFieldError,
    SheetConfig.SheetConfigError,
  ]),
);

const EventConfigAsyncResultSchema: Schema.Codec<
  AsyncResult.AsyncResult<EventConfig, EventConfigError>,
  any
> = Schema.revealCodec(
  AsyncResult.Schema({
    success: SheetConfig.EventConfig,
    error: EventConfigErrorSchema,
  }),
);

// Serializable atom for event config
export const eventConfigAtom = Atom.family((guildId: string) =>
  _eventConfigAtom(guildId).pipe(
    Atom.serializable({
      key: `sheet.getEventConfig.${guildId}`,
      schema: EventConfigAsyncResultSchema,
    }),
  ),
);

// Hook to use event config (includes startTime)
export const useEventConfig = (guildId: string) => {
  const atom = useMemo(() => eventConfigAtom(guildId), [guildId]);
  const result = useAtomSuspense(atom, {
    suspendOnWaiting: false,
    includeFailure: false,
  });
  return result.value;
};
