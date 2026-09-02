import { Option, Predicate } from "effect";
import type { BotTextPart } from "sheet-bot-api";
import * as MessageText from "sheet-message-content/text";

export type CheckinParticipant = {
  readonly name: string;
  readonly userId?: string;
};

const renderStaticTemplateSegment = (value: string): ReadonlyArray<BotTextPart> =>
  value
    .split("~~")
    .flatMap((segment, index) =>
      segment.length === 0
        ? []
        : index % 2 === 0
          ? [MessageText.text(segment)]
          : [{ type: "strikethrough" as const, parts: [MessageText.text(segment)] }],
    );

export const renderTemplate = (
  template: string,
  context: Readonly<Record<string, ReadonlyArray<BotTextPart>>>,
): ReadonlyArray<BotTextPart> => {
  const result: Array<BotTextPart> = [];
  const pattern = /(?<!\{)(\{\{|\{\{\{)(\w+)(\}\}|\}\}\})(?!\})/gu;
  let lastIndex = 0;
  for (const match of template.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex)
      result.push(...renderStaticTemplateSegment(template.slice(lastIndex, index)));
    if (match[1]?.length !== match[3]?.length) {
      result.push(...renderStaticTemplateSegment(match[0]));
      lastIndex = index + match[0].length;
      continue;
    }
    const key = match[2] ?? "";
    const replacement = Object.hasOwn(context, key) ? context[key] : undefined;
    result.push(...(replacement ?? renderStaticTemplateSegment(match[0])));
    lastIndex = index + match[0].length;
  }
  if (lastIndex < template.length)
    result.push(...renderStaticTemplateSegment(template.slice(lastIndex)));
  return result;
};

export const renderParticipantMentions = (
  participants: ReadonlyArray<CheckinParticipant>,
): ReadonlyArray<BotTextPart> =>
  participants.flatMap((participant, index) =>
    MessageText.parts(
      index === 0 ? undefined : MessageText.text(" "),
      Predicate.isString(participant.userId)
        ? MessageText.userMention(participant.userId)
        : MessageText.text(participant.name),
    ),
  );

export const missingParticipantIdMessage = (
  fills: ReadonlyArray<{ readonly accountId: string | null; readonly name: string }>,
): Option.Option<string> => {
  const lookupFailures = fills.flatMap(({ accountId, name }) =>
    Predicate.isNull(accountId) ? [name] : [],
  );
  return lookupFailures.length === 0
    ? Option.none<string>()
    : Option.some(
        `Cannot look up ID for ${lookupFailures.join(", ")}. They would need to check in manually.`,
      );
};

export const monitorFailureMessage = (
  current:
    | {
        readonly monitor: {
          readonly accountId: string | null;
          readonly name: string;
        } | null;
      }
    | undefined,
): ReadonlyArray<BotTextPart> | null =>
  Predicate.isUndefined(current)
    ? null
    : Predicate.isNull(current.monitor)
      ? [MessageText.text("Cannot ping monitor: monitor not assigned for this hour.")]
      : Predicate.isNull(current.monitor.accountId)
        ? [
            MessageText.text(
              `Cannot ping monitor: monitor "${current.monitor.name}" is missing an ID in the sheet.`,
            ),
          ]
        : null;
