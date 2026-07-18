import { Option, Predicate } from "effect";
import type { SheetOutboundMessage, SheetTextPart } from "sheet-ingress-api/schemas/client";
import { makeEmbed } from "./rendering";
import * as MessageText from "./text";

type Participant = {
  readonly name: string;
  readonly userId?: string;
};

type PlainTextPart = {
  readonly type: "text";
  readonly text: string;
};

type UserMentionPart = {
  readonly type: "userMention";
  readonly userId: string;
};

type MonitorSummaryPart = PlainTextPart | UserMentionPart;

const plainText = (text: string): PlainTextPart => ({ type: "text", text });

const joinSummaryText = (
  values: ReadonlyArray<ReadonlyArray<MonitorSummaryPart>>,
  separator: string,
): MonitorSummaryPart[] =>
  values.flatMap((value, index) => (index === 0 ? [...value] : [plainText(separator), ...value]));

const participantGroup = (
  label: "Out" | "Stay" | "In",
  participants: ReadonlyArray<Participant>,
): MonitorSummaryPart[] =>
  participants.length === 0
    ? [plainText(`${label}: None`)]
    : [
        plainText(`${label}: `),
        ...participants.flatMap((participant, index) => [
          ...(index === 0 ? [] : [plainText(" ")]),
          Predicate.isString(participant.userId)
            ? { type: "userMention" as const, userId: participant.userId }
            : plainText(participant.name),
        ]),
      ];

export const makeMonitorCheckinMessage = ({
  initialMessage,
  empty,
  out,
  stay,
  in: incoming,
  lookupFailedMessage,
}: {
  readonly initialMessage: ReadonlyArray<unknown> | null;
  readonly empty: number;
  readonly out: ReadonlyArray<Participant>;
  readonly stay: ReadonlyArray<Participant>;
  readonly in: ReadonlyArray<Participant>;
  readonly lookupFailedMessage: Option.Option<string>;
}): MonitorSummaryPart[] => {
  const emptySlotMessage = plainText(
    `${empty > 0 ? `+${empty}` : "No"} empty slot${empty === 1 ? "" : "s"}`,
  );
  return Predicate.isNotNull(initialMessage)
    ? joinSummaryText(
        [
          [plainText("Check-in message sent!")],
          [emptySlotMessage],
          participantGroup("Out", out),
          participantGroup("Stay", stay),
          participantGroup("In", incoming),
          ...Option.toArray(Option.map(lookupFailedMessage, (message) => [plainText(message)])),
        ],
        "\n",
      )
    : joinSummaryText(
        [
          [plainText("No check-in message sent, no new players to check in")],
          ...(empty > 0 && empty < 5 ? [[emptySlotMessage]] : []),
        ],
        "\n",
      );
};

export const autoCheckinNotice = "Sent automatically via auto check-in.";

export const formatAutoCheckinContent = (content: ReadonlyArray<SheetTextPart>): SheetTextPart[] =>
  MessageText.lines(content, [MessageText.subtle([MessageText.text(autoCheckinNotice)])]);

export const manualCheckinSummaryMessage = ({
  monitorCheckinMessage,
}: {
  readonly monitorCheckinMessage: ReadonlyArray<SheetTextPart>;
}): SheetOutboundMessage => ({
  content: null,
  embeds: [
    makeEmbed({
      title: [MessageText.text("Check-in summary for monitors")],
      description: monitorCheckinMessage,
    }),
  ],
  allowedMentions: "none",
});

export const autoCheckinSummaryMessage = ({
  monitorUserId,
  monitorCheckinMessage,
  monitorFailureMessage,
}: {
  readonly monitorUserId: string | null;
  readonly monitorCheckinMessage: ReadonlyArray<SheetTextPart>;
  readonly monitorFailureMessage: ReadonlyArray<SheetTextPart> | null;
}): SheetOutboundMessage => ({
  content: Predicate.isString(monitorUserId) ? [MessageText.userMention(monitorUserId)] : undefined,
  embeds: [
    makeEmbed({
      title: [MessageText.text("Auto check-in summary for monitors")],
      description: MessageText.lines(
        monitorCheckinMessage,
        ...(Predicate.isNotNull(monitorFailureMessage)
          ? [[MessageText.subtle(monitorFailureMessage)]]
          : []),
        [MessageText.subtle([MessageText.text(autoCheckinNotice)])],
      ),
    }),
  ],
  allowedMentions: Predicate.isString(monitorUserId) ? "default" : "none",
});
