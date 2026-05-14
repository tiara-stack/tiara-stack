import { Schema } from "effect";
import { Workflow } from "effect/unstable/workflow";

export const AutoCheckinChannelPayload = Schema.Struct({
  guildId: Schema.String,
  channelName: Schema.String,
  hour: Schema.Number,
  eventStartEpochMs: Schema.Number,
});

export type AutoCheckinChannelPayload = Schema.Schema.Type<typeof AutoCheckinChannelPayload>;

export const AutoCheckinChannelResult = Schema.Struct({
  guildId: Schema.String,
  channelName: Schema.String,
  hour: Schema.Number,
  status: Schema.Literals(["sent", "skipped"]),
  checkinMessageId: Schema.NullOr(Schema.String),
  monitorMessageId: Schema.String,
  tentativeRoomOrderMessageId: Schema.NullOr(Schema.String),
});

export type AutoCheckinChannelResult = Schema.Schema.Type<typeof AutoCheckinChannelResult>;

export const AutoCheckinChannelWorkflow = Workflow.make({
  name: "autoCheckin.channel",
  payload: AutoCheckinChannelPayload,
  success: AutoCheckinChannelResult,
  error: Schema.Unknown,
  idempotencyKey: ({ guildId, channelName, hour, eventStartEpochMs }) =>
    `auto-checkin:${guildId}:${eventStartEpochMs}:${hour}:${channelName}`,
});
