import { Schema } from "effect";
import { ScheduleTimeReferenceMetadata } from "sheet-domain";
import { slotCapacity } from "../shared/slotCapacity";

const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const filledSlotCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: slotCapacity }));

const slotViewScheduleFields = {
  visible: Schema.Boolean,
  hour: Schema.NullOr(Schema.Finite),
} as const;

const SlotViewSchedule = Schema.Union([
  Schema.TaggedStruct("Break", slotViewScheduleFields),
  Schema.TaggedStruct("Schedule", {
    ...slotViewScheduleFields,
    filledSlots: filledSlotCount,
    overfillSlots: nonNegativeInt,
  }),
]);

export const SlotView = Schema.Struct({
  eventStartEpochMs: Schema.Finite,
  scheduleTimeReference: Schema.optional(ScheduleTimeReferenceMetadata),
  schedules: Schema.Array(SlotViewSchedule),
});
export type SlotView = typeof SlotView.Type;
