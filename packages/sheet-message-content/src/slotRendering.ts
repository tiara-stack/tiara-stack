import type { BotTextPart } from "sheet-bot-api/message";
import type { PopulatedScheduleResult } from "./schedule";
import * as MessageText from "./text";
import { formatFilledSlot, formatOpenSlot, makeEmbed } from "./rendering";

// Leaves enough room for both slot embed titles and the schedule-link embed under Discord's
// 6,000-character aggregate limit while remaining below the 4,096-character description limit.
const slotDescriptionLimit = 2_900;
const overflowSummary = MessageText.parts(MessageText.text("\n… additional slots omitted"));
const overflowSummaryLength = MessageText.renderPlainText(overflowSummary).length;

const boundSlotRows = (
  rows: ReadonlyArray<ReadonlyArray<BotTextPart>>,
): ReadonlyArray<BotTextPart> => {
  const boundedRows: Array<ReadonlyArray<BotTextPart>> = [];
  let previousText: string | undefined;
  let renderedLength = 0;
  let truncated = false;

  for (const row of rows) {
    if (row.length === 0) continue;
    const plainText = MessageText.renderPlainText(row);
    if (plainText === previousText) continue;
    previousText = plainText;

    // Slot rows currently contain text, strong text, and timestamps. Eight characters per part
    // conservatively covers the Discord markdown wrappers omitted by the plain-text rendering.
    const rowLength = plainText.length + row.length * 8 + (boundedRows.length === 0 ? 0 : 1);
    if (renderedLength + rowLength + overflowSummaryLength > slotDescriptionLimit) {
      truncated = true;
      break;
    }
    boundedRows.push(row);
    renderedLength += rowLength;
  }

  const description = MessageText.joinText(boundedRows, "\n");
  return truncated ? [...description, ...overflowSummary] : description;
};

const renderSlotSection = (
  schedules: ReadonlyArray<PopulatedScheduleResult>,
  formatter: (schedule: PopulatedScheduleResult) => ReadonlyArray<BotTextPart>,
  fallback: string,
) => {
  const description = boundSlotRows(schedules.map(formatter));
  return description.length === 0 ? MessageText.parts(MessageText.text(fallback)) : description;
};

export const renderSlotEmbeds = (
  day: number,
  schedules: ReadonlyArray<PopulatedScheduleResult>,
  eventConfig: Parameters<typeof formatOpenSlot>[1],
) => [
  makeEmbed({
    title: `Day ${day} Open Slots`,
    description: renderSlotSection(
      schedules,
      (schedule) => formatOpenSlot(schedule, eventConfig),
      "All Filled :3",
    ),
  }),
  makeEmbed({
    title: `Day ${day} Filled Slots`,
    description: renderSlotSection(
      schedules,
      (schedule) => formatFilledSlot(schedule, eventConfig),
      "All Open :3",
    ),
  }),
];
