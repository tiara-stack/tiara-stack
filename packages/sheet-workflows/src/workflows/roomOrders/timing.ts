import { Effect, Option } from "effect";
import type { ScheduleTimeReference } from "sheet-domain";
import {
  establishedScheduleTimeReferenceFor,
  type AuthoritativeSheetConfiguration,
} from "@/services/authoritativeSheetConfiguration";

export const resolveRoomOrderScheduleTimeReference = <E>(
  active: AuthoritativeSheetConfiguration,
  loadLegacy: Effect.Effect<ScheduleTimeReference | undefined, E>,
): Effect.Effect<ScheduleTimeReference | undefined, E> =>
  Option.match(establishedScheduleTimeReferenceFor(active), {
    onSome: Effect.succeed,
    onNone: () => loadLegacy,
  });
