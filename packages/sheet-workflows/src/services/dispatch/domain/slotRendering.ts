import { Effect, Option, String as EffectString, pipe } from "effect";
import { makeSheetApisServices } from "../clients/sheetApis";
import { formatFilledSlot, formatOpenSlot, joinDedupeAdjacent, makeEmbed } from "../pure/rendering";

type SheetApisServices = ReturnType<typeof makeSheetApisServices>;

const renderSlotSection = <Schedule>(
  schedules: ReadonlyArray<Schedule>,
  formatter: (schedule: Schedule) => string,
  fallback: string,
) =>
  pipe(schedules.map(formatter), joinDedupeAdjacent, (description) =>
    EffectString.isEmpty(description) ? fallback : description,
  );

export const makeSlotEmbedRenderer = ({
  scheduleService,
  sheetService,
}: {
  readonly scheduleService: SheetApisServices["scheduleService"];
  readonly sheetService: SheetApisServices["sheetService"];
}) =>
  Effect.fn("DispatchService.makeSlotEmbeds")(function* (workspaceId: string, day: number) {
    const eventConfig = yield* sheetService.getEventConfig(workspaceId);
    const daySchedule = yield* scheduleService.dayPopulatedFillerSchedules(workspaceId, day);
    const sortedSchedules = daySchedule
      .flatMap((schedule) =>
        Option.match(schedule.hour, {
          onSome: (hour) => [{ schedule, hour }],
          onNone: () => [],
        }),
      )
      .sort((left, right) => left.hour - right.hour)
      .map(({ schedule }) => schedule);
    const openSlots = renderSlotSection(
      sortedSchedules,
      (schedule) => formatOpenSlot(schedule, eventConfig),
      "All Filled :3",
    );
    const filledSlots = renderSlotSection(
      sortedSchedules,
      (schedule) => formatFilledSlot(schedule, eventConfig),
      "All Open :3",
    );

    return [
      makeEmbed({
        title: `Day ${day} Open Slots`,
        description: openSlots,
      }),
      makeEmbed({
        title: `Day ${day} Filled Slots`,
        description: filledSlots,
      }),
    ];
  });

export type SlotEmbedRenderer = ReturnType<typeof makeSlotEmbedRenderer>;
