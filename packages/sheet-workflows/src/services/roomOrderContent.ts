// fallow-ignore-file code-duplication
import { DateTime } from "effect";
import type { SheetTextPart } from "sheet-ingress-api/schemas/client";
import { inlineCode, joinText, parts, strong, text, timestamp } from "./messageText";

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

const roomOrderHeaderLine = (
  hour: number,
  start: DateTime.DateTime,
  end: DateTime.DateTime,
): SheetTextPart[] =>
  parts(
    strong([text(`Hour ${hour}`)]),
    text(" "),
    timestamp(DateTime.toEpochMillis(start), "longDate"),
    text(" - "),
    timestamp(DateTime.toEpochMillis(end), "longDate"),
  );

const monitorLine = (monitor: string | null): SheetTextPart[] | null =>
  monitor === null ? null : parts(inlineCode("Monitor:"), text(` ${monitor}`));

const formatEffectValue = (effectValue: number): string => {
  const rounded = Number(effectValue.toFixed(1));
  const suffix = Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1);
  return `+${suffix}%`;
};

const formatEffectLabels = (
  effectValue: number,
  tags: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  tags.includes("tierer")
    ? []
    : [
        formatEffectValue(effectValue),
        ...(tags.includes("enc") ? ["enc"] : []),
        ...(tags.includes("not_enc") ? ["not enc"] : []),
      ];

const roomOrderEntryLine = ({
  position,
  team,
  tags,
  effectValue,
}: RoomOrderContentEntry): SheetTextPart[] => {
  const effectLabels = formatEffectLabels(effectValue, tags);
  const effectText = effectLabels.length === 0 ? "" : ` (${effectLabels.join(", ")})`;
  return parts(inlineCode(`P${position + 1}:`), text(`  ${team}${effectText}`));
};

const participantList = (participants: ReadonlyArray<FillParticipant>): string =>
  participants.length === 0 ? "(none)" : participants.map(({ name }) => name).join(", ");

const fillMovementLines = (fillMovement: ReturnType<typeof diffFillParticipants>) => [
  parts(inlineCode("In:"), text(` ${participantList(fillMovement.in)}`)),
  parts(inlineCode("Out:"), text(` ${participantList(fillMovement.out)}`)),
];

export const buildRoomOrderContent = (
  hour: number,
  start: DateTime.DateTime,
  end: DateTime.DateTime,
  monitor: string | null,
  previousParticipants: ReadonlyArray<FillParticipant>,
  participants: ReadonlyArray<FillParticipant>,
  entries: ReadonlyArray<RoomOrderContentEntry>,
): SheetTextPart[] => {
  const fillMovement = diffFillParticipants(previousParticipants, participants);
  const maybeMonitorLine = monitorLine(monitor);

  return joinText(
    [
      roomOrderHeaderLine(hour, start, end),
      ...(maybeMonitorLine === null ? [] : [maybeMonitorLine]),
      [text("")],
      ...entries.map(roomOrderEntryLine),
      [text("")],
      ...fillMovementLines(fillMovement),
    ],
    "\n",
  );
};
