import type { SheetTextPart } from "sheet-ingress-api/schemas/client";
import type { PopulatedScheduleResult } from "sheet-ingress-api/schemas/sheet";
import * as MessageText from "./text";
import { formatFilledSlot, formatOpenSlot, joinDedupeAdjacent, makeEmbed } from "./rendering";

const renderSlotSection = (
  schedules: ReadonlyArray<PopulatedScheduleResult>,
  formatter: (schedule: PopulatedScheduleResult) => ReadonlyArray<SheetTextPart>,
  fallback: string,
) => {
  const description = joinDedupeAdjacent(schedules.map(formatter));
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
