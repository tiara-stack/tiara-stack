import { DateTime } from "effect";
import type { BotTextPart } from "sheet-bot-api/message";
import { inlineCode, joinText, parts, strong, text, timestamp } from "./text";

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

export type RoomOrderMonitorHandoff = {
  readonly currentMonitor: string | null;
  readonly previousMonitor: string | null;
  readonly previousMonitorHistoryKnown: boolean;
};

type RoomOrderMonitorInput = RoomOrderMonitorHandoff | string | null;

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
): BotTextPart[] =>
  parts(
    strong([text(`Hour ${hour}`)]),
    text(" "),
    timestamp(DateTime.toEpochMillis(start)),
    text(" - "),
    timestamp(DateTime.toEpochMillis(end)),
  );

const monitorLine = ({
  currentMonitor,
  previousMonitor,
  previousMonitorHistoryKnown,
}: RoomOrderMonitorHandoff): BotTextPart[] | null => {
  if (currentMonitor === null && (previousMonitor === null || !previousMonitorHistoryKnown)) {
    return null;
  }
  if (!previousMonitorHistoryKnown || previousMonitor === currentMonitor) {
    return currentMonitor === null ? null : parts(inlineCode("Monis:"), text(` ${currentMonitor}`));
  }
  if (previousMonitor === null) {
    return parts(inlineCode("Monis:"), text(` In ${currentMonitor}`));
  }
  if (currentMonitor === null) {
    return parts(inlineCode("Monis:"), text(` Out ${previousMonitor}`));
  }
  return parts(inlineCode("Monis:"), text(` In ${currentMonitor} · Out ${previousMonitor}`));
};

const roomOrderMonitorLine = (monitor: RoomOrderMonitorInput): BotTextPart[] | null =>
  monitor !== null && typeof monitor === "object"
    ? monitorLine(monitor)
    : monitor === null
      ? null
      : parts(inlineCode("Monitor:"), text(` ${monitor}`));

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
}: RoomOrderContentEntry): BotTextPart[] => {
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
  monitor: RoomOrderMonitorInput,
  previousParticipants: ReadonlyArray<FillParticipant>,
  participants: ReadonlyArray<FillParticipant>,
  entries: ReadonlyArray<RoomOrderContentEntry>,
): BotTextPart[] => {
  const fillMovement = diffFillParticipants(previousParticipants, participants);
  const maybeMonitorLine = roomOrderMonitorLine(monitor);

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
