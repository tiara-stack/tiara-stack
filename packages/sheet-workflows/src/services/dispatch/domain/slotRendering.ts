import { Effect, Option } from "effect";
import { renderSlotEmbeds } from "sheet-message-content/slotRendering";
import { makeSheetApisServices } from "../clients/sheetApis";

type SheetApisServices = ReturnType<typeof makeSheetApisServices>;

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
    return renderSlotEmbeds(day, sortedSchedules, eventConfig);
  });

export type SlotEmbedRenderer = ReturnType<typeof makeSlotEmbedRenderer>;
