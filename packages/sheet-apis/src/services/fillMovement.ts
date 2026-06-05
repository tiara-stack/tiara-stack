import { Option, Predicate } from "effect";
import {
  type PopulatedSchedulePlayer,
  type PopulatedScheduleResult,
} from "sheet-ingress-api/schemas/sheet";

export type FillParticipant = {
  key: string;
  label: string;
  name: string;
};

const isPlayer = Predicate.isTagged("Player");
const isPopulatedSchedule = Predicate.isTagged("PopulatedSchedule");

const dedupeParticipants = (
  participants: ReadonlyArray<FillParticipant>,
): ReadonlyArray<FillParticipant> => {
  const seen = new Set<string>();
  return participants.filter((participant) => {
    if (seen.has(participant.key)) {
      return false;
    }

    seen.add(participant.key);
    return true;
  });
};

export const getScheduleFills = (
  schedule: PopulatedScheduleResult | null | undefined,
): ReadonlyArray<PopulatedSchedulePlayer> =>
  schedule != null && isPopulatedSchedule(schedule)
    ? schedule.fills.flatMap((fill) => (Option.isSome(fill) ? [fill.value] : []))
    : [];

export const toFillParticipant = (schedulePlayer: PopulatedSchedulePlayer): FillParticipant =>
  isPlayer(schedulePlayer.player)
    ? {
        key: `player:${schedulePlayer.player.id}`,
        label: `<@${schedulePlayer.player.id}>`,
        name: schedulePlayer.player.name,
      }
    : {
        key: `name:${schedulePlayer.player.name}`,
        label: schedulePlayer.player.name,
        name: schedulePlayer.player.name,
      };

export const diffFillParticipants = (
  previousParticipants: ReadonlyArray<FillParticipant>,
  currentParticipants: ReadonlyArray<FillParticipant>,
): {
  out: ReadonlyArray<FillParticipant>;
  stay: ReadonlyArray<FillParticipant>;
  in: ReadonlyArray<FillParticipant>;
} => {
  const previous = dedupeParticipants(previousParticipants);
  const current = dedupeParticipants(currentParticipants);
  const previousKeys = new Set(previous.map(({ key }) => key));
  const currentKeys = new Set(current.map(({ key }) => key));

  return {
    out: previous.filter(({ key }) => !currentKeys.has(key)),
    stay: current.filter(({ key }) => previousKeys.has(key)),
    in: current.filter(({ key }) => !previousKeys.has(key)),
  };
};
