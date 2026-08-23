import { useAtomSuspense } from "@effect/atom-react";
import { DateTime, Effect, Schema } from "effect";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { SheetConfig } from "sheet-ingress-api/schemas";
import { useMemo } from "react";
import { workspaceScheduleAtom } from "#/lib/schedule";

type EventConfig = Schema.Schema.Type<typeof SheetConfig.EventConfig>;

const EventConfigAsyncResultSchema = Schema.revealCodec(
  AsyncResult.Schema({
    success: SheetConfig.EventConfig,
    error: Schema.Unknown,
  }),
);

export const eventConfigAtom = Atom.family((guildId: string) =>
  Atom.make<EventConfig, unknown>(
    Effect.fnUntraced(function* (get) {
      const schedule = yield* get.result(workspaceScheduleAtom(guildId));
      return new SheetConfig.EventConfig({
        startTime: DateTime.makeUnsafe(schedule.eventConfig.startTimeEpochMs),
      });
    }),
  ).pipe(
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
