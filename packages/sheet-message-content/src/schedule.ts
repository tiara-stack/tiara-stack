import { Option, Schema } from "effect";

export class ScheduleHourWindow extends Schema.TaggedClass<ScheduleHourWindow>()(
  "ScheduleHourWindow",
  {
    start: Schema.DateTimeUtcFromMillis,
    end: Schema.DateTimeUtcFromMillis,
  },
) {}

export class Player extends Schema.TaggedClass<Player>()("Player", {
  index: Schema.Number,
  id: Schema.String,
  name: Schema.String,
}) {}

export class PartialNamePlayer extends Schema.TaggedClass<PartialNamePlayer>()(
  "PartialNamePlayer",
  { name: Schema.String },
) {}

export class Monitor extends Schema.TaggedClass<Monitor>()("Monitor", {
  index: Schema.Number,
  id: Schema.String,
  name: Schema.String,
}) {}

export class PartialNameMonitor extends Schema.TaggedClass<PartialNameMonitor>()(
  "PartialNameMonitor",
  { name: Schema.String },
) {}

const PopulatedSchedulePlayerOrPartial = Schema.Union([Player, PartialNamePlayer]);
const PopulatedScheduleMonitorOrPartial = Schema.Union([Monitor, PartialNameMonitor]);
const populatedScheduleFillCount = 5;

export class PopulatedSchedulePlayer extends Schema.TaggedClass<PopulatedSchedulePlayer>()(
  "PopulatedSchedulePlayer",
  {
    player: PopulatedSchedulePlayerOrPartial,
    enc: Schema.Boolean,
  },
) {}

export class PopulatedScheduleMonitor extends Schema.TaggedClass<PopulatedScheduleMonitor>()(
  "PopulatedScheduleMonitor",
  { monitor: PopulatedScheduleMonitorOrPartial },
) {}

export class PopulatedSchedule extends Schema.TaggedClass<PopulatedSchedule>()(
  "PopulatedSchedule",
  {
    channel: Schema.String,
    day: Schema.Number,
    visible: Schema.Boolean,
    hour: Schema.OptionFromNullOr(Schema.Number),
    hourWindow: Schema.OptionFromNullOr(ScheduleHourWindow),
    fills: Schema.Array(Schema.OptionFromNullOr(PopulatedSchedulePlayer)).check(
      Schema.isLengthBetween(populatedScheduleFillCount, populatedScheduleFillCount),
    ),
    overfills: Schema.Array(PopulatedSchedulePlayer),
    standbys: Schema.Array(PopulatedSchedulePlayer),
    runners: Schema.Array(PopulatedSchedulePlayer),
    monitor: Schema.OptionFromNullOr(PopulatedScheduleMonitor),
  },
) {
  static empty = ({ fills, overfills }: PopulatedSchedule): number =>
    Math.max(populatedScheduleFillCount - fills.filter(Option.isSome).length - overfills.length, 0);
}

export class PopulatedBreakSchedule extends Schema.TaggedClass<PopulatedBreakSchedule>()(
  "PopulatedBreakSchedule",
  {
    channel: Schema.String,
    day: Schema.Number,
    visible: Schema.Boolean,
    hour: Schema.OptionFromNullOr(Schema.Number),
    hourWindow: Schema.OptionFromNullOr(ScheduleHourWindow),
  },
) {}

export type PopulatedScheduleResult = PopulatedBreakSchedule | PopulatedSchedule;
export const PopulatedScheduleResult = Schema.Union([PopulatedBreakSchedule, PopulatedSchedule]);
