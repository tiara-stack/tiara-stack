import { Schema } from "effect";

const ScheduleIdentity = Schema.Struct({
  accountId: Schema.String,
  name: Schema.String,
});

const UserSchedule = Schema.Struct({
  visible: Schema.Boolean,
  hour: Schema.NullOr(Schema.Number),
  break: Schema.Boolean,
  fills: Schema.Array(Schema.String),
  overfills: Schema.Array(Schema.String),
  standbys: Schema.Array(Schema.String),
  monitor: Schema.NullOr(Schema.String),
});

export const UserScheduleView = Schema.Struct({
  eventStartEpochMs: Schema.Number,
  players: Schema.Array(ScheduleIdentity),
  monitors: Schema.Array(ScheduleIdentity),
  schedules: Schema.Array(UserSchedule),
});
export type UserScheduleView = typeof UserScheduleView.Type;
