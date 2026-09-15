import { useAtomSuspense } from "@effect/atom-react";
import { DateTime, Effect, Schema } from "effect";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { ScheduleTimeReferenceMetadata } from "sheet-domain";
import { useMemo } from "react";
import {
  scheduleReactivityKey,
  scheduleTimeReferenceMetadataForResponse,
  workspaceScheduleAtom,
} from "#/lib/schedule";

const EventConfig = Schema.Struct({
  startTime: Schema.DateTimeUtcFromMillis,
  scheduleTimeReference: Schema.optional(ScheduleTimeReferenceMetadata),
});
type EventConfig = Schema.Schema.Type<typeof EventConfig>;

const EventConfigAsyncResultSchema = Schema.revealCodec(
  AsyncResult.Schema({
    success: EventConfig,
    error: Schema.Unknown,
  }),
);

export const eventConfigAtom = Atom.family((guildId: string) =>
  Atom.make<EventConfig, unknown>(
    Effect.fnUntraced(function* (get) {
      const schedule = yield* get.result(workspaceScheduleAtom(guildId));
      const scheduleTimeReference = scheduleTimeReferenceMetadataForResponse(
        schedule.eventConfig,
        schedule.populatedSchedules,
      );
      return {
        startTime: DateTime.makeUnsafe(schedule.eventConfig.startTimeEpochMs),
        ...(scheduleTimeReference === undefined ? {} : { scheduleTimeReference }),
      };
    }),
  ).pipe(
    Atom.withReactivity([scheduleReactivityKey(guildId)]),
    Atom.serializable({
      key: `sheet.getEventConfig.v4.${guildId}`,
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
