import { DateTime } from "effect";

type FillParticipant = {
  readonly key: string;
  readonly name: string;
};

export type RoomOrderContentEntry = {
  readonly position: number;
  readonly team: string;
  readonly tags: ReadonlyArray<string>;
  readonly effectValue: number;
};

const formatEffectValue = (effectValue: number): string => {
  const rounded = Math.round(effectValue * 10) / 10;
  const formatted = rounded % 1 === 0 ? rounded.toString() : rounded.toFixed(1);
  return `+${formatted}%`;
};

const formatDiscordTimestamp = (dateTime: DateTime.DateTime): string =>
  `<t:${Math.floor(DateTime.toEpochMillis(dateTime) / 1000)}:f>`;

const diffFillParticipants = (
  previousParticipants: ReadonlyArray<FillParticipant>,
  participants: ReadonlyArray<FillParticipant>,
) => {
  const previousKeys = new Set(previousParticipants.map((participant) => participant.key));
  const keys = new Set(participants.map((participant) => participant.key));

  return {
    in: participants.filter((participant) => !previousKeys.has(participant.key)),
    out: previousParticipants.filter((participant) => !keys.has(participant.key)),
  };
};

export const buildRoomOrderContent = (
  hour: number,
  start: DateTime.DateTime,
  end: DateTime.DateTime,
  monitor: string | null,
  previousParticipants: ReadonlyArray<FillParticipant>,
  participants: ReadonlyArray<FillParticipant>,
  entries: ReadonlyArray<RoomOrderContentEntry>,
) => {
  const fillMovement = diffFillParticipants(previousParticipants, participants);

  return [
    `**Hour ${hour}** ${formatDiscordTimestamp(start)} - ${formatDiscordTimestamp(end)}`,
    ...(monitor === null ? [] : [`\`Monitor:\` ${monitor}`]),
    "",
    ...entries.map(({ position, team, tags, effectValue }) => {
      const hasTiererTag = tags.includes("tierer");
      const effectParts = hasTiererTag
        ? []
        : [
            formatEffectValue(effectValue),
            ...(tags.includes("enc") ? ["enc"] : []),
            ...(tags.includes("not_enc") ? ["not enc"] : []),
          ];

      const effectStr = effectParts.length > 0 ? ` (${effectParts.join(", ")})` : "";
      return `\`P${position + 1}:\`  ${team}${effectStr}`;
    }),
    "",
    `\`In:\` ${fillMovement.in.length > 0 ? fillMovement.in.map(({ name }) => name).join(", ") : "(none)"}`,
    `\`Out:\` ${fillMovement.out.length > 0 ? fillMovement.out.map(({ name }) => name).join(", ") : "(none)"}`,
  ].join("\n");
};
