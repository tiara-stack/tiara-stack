import type { ComponentProps } from "react";
import { DateTime, Option } from "effect";
import {
  autoCheckinSummaryMessage,
  buildRoomOrderContent,
  checkinAnnouncementMessage,
  checkinButtonAcknowledgementMessage,
  checkinPromptMessage,
  makeMonitorCheckinMessage,
  manualCheckinSummaryMessage,
  monitorPingMessage,
  publishedRoomOrderMessage,
  renderCheckedInContent,
  reminderMessage,
  roomOrderDraftMessage,
  roomOrderSendAcknowledgementMessage,
  tentativeRoomOrderPinAcknowledgementMessage,
  tentativeRoomOrderMessage,
} from "sheet-message-content";
import * as MessageText from "sheet-message-content";
import { DiscordMessage } from "./discord-message";

const client = { platform: "discord", clientId: "tiarabot" };
const workspaceId = "sekai-tiering";
const outgoingFiller = { key: "filler-1", name: "AiriFan39", userId: "filler-1" };
const incomingFiller = {
  key: "filler-2",
  name: "Theerie the Miku Enjoyer",
  userId: "filler-2",
};
const stayingFillers = [
  { key: "filler-3", name: "Wonderlands", userId: "filler-3" },
  { key: "filler-4", name: "Vivid BAD SQUAD", userId: "filler-4" },
  { key: "filler-5", name: "Leo/need", userId: "filler-5" },
] as const;
const labels = {
  users: {
    [outgoingFiller.key]: outgoingFiller.name,
    [incomingFiller.key]: incomingFiller.name,
    "monitor-1": "Moni",
  },
  conversations: { "running-1": "marathon-room", "checkin-1": "check-ins" },
};
const checkinTime = Date.UTC(2026, 6, 18, 12, 45);
const referenceTime = Date.UTC(2026, 6, 18, 12);

const ExampleDiscordMessage = (
  props: Omit<ComponentProps<typeof DiscordMessage>, "referenceEpochMs">,
) => <DiscordMessage {...props} referenceEpochMs={referenceTime} />;

const checkinContent = MessageText.parts(
  MessageText.userMention(incomingFiller.key),
  MessageText.text(" Press the button below to check in, and head to "),
  MessageText.conversationMention(MessageText.conversationRef(client, workspaceId, "running-1")),
  MessageText.text(" for "),
  MessageText.strong([MessageText.text("hour 4")]),
  MessageText.text(" "),
  MessageText.timestamp(checkinTime, "relative"),
);

const roomOrderContent = buildRoomOrderContent(
  4,
  DateTime.makeUnsafe("2026-07-18T12:00:00.000Z"),
  DateTime.makeUnsafe("2026-07-18T13:00:00.000Z"),
  "Moni",
  [outgoingFiller, ...stayingFillers],
  [incomingFiller, ...stayingFillers],
  [
    { position: 0, team: "Bloom Team | Tierer", tags: ["tierer"], effectValue: 0 },
    {
      position: 1,
      team: `${incomingFiller.name} | Full Fill`,
      tags: ["enc"],
      effectValue: 232,
    },
    {
      position: 2,
      team: `${stayingFillers[0].name} | Full Fill`,
      tags: [],
      effectValue: 224,
    },
    {
      position: 3,
      team: `${stayingFillers[1].name} | Full Fill`,
      tags: ["not_enc"],
      effectValue: 218,
    },
    { position: 4, team: `${stayingFillers[2].name} | Heal`, tags: [], effectValue: 180 },
  ],
);

const range = { minRank: 0, maxRank: 2 };

const monitorCheckinContent = makeMonitorCheckinMessage({
  initialMessage: checkinContent,
  empty: 0,
  out: [outgoingFiller],
  stay: stayingFillers,
  in: [incomingFiller],
  lookupFailedMessage: Option.none(),
});

const manualResult = {
  ...manualCheckinSummaryMessage({ monitorCheckinMessage: monitorCheckinContent }),
  visibility: "ephemeral",
} as const;

const checkinButtonResult = {
  ...checkinButtonAcknowledgementMessage(true),
  visibility: "ephemeral",
} as const;

const checkedInPrompt = checkinPromptMessage(
  renderCheckedInContent(checkinContent, [
    { memberId: incomingFiller.key, checkinAt: Option.some(checkinTime) },
  ]),
);

const autoMonitorSummary = autoCheckinSummaryMessage({
  monitorUserId: "monitor-1",
  monitorCheckinMessage: monitorCheckinContent,
  monitorFailureMessage: null,
});

const dmContext = {
  client,
  workspaceId,
  workspaceName: "Sekai Tiering",
  runningConversationId: "running-1",
  checkinConversationId: "checkin-1",
  hour: 4,
};

export const CheckinPromptExample = () => (
  <ExampleDiscordMessage
    message={checkinPromptMessage(checkinContent)}
    labels={labels}
    channel="check-ins"
  />
);
export const CheckinButtonResultExample = () => (
  <ExampleDiscordMessage message={checkinButtonResult} labels={labels} channel="check-ins" />
);
export const CheckedInPromptExample = () => (
  <ExampleDiscordMessage message={checkedInPrompt} labels={labels} channel="check-ins" />
);
export const CheckinAnnouncementExample = () => (
  <ExampleDiscordMessage
    message={checkinAnnouncementMessage(incomingFiller.key)}
    labels={labels}
    channel="marathon-room"
  />
);
export const ManualCheckinResultExample = () => (
  <ExampleDiscordMessage
    message={manualResult}
    labels={labels}
    channel="marathon-room"
    command={{ name: "checkin manual" }}
  />
);
export const AutoCheckinSummaryExample = () => (
  <ExampleDiscordMessage message={autoMonitorSummary} labels={labels} channel="marathon-room" />
);
export const FillerReminderExample = () => (
  <ExampleDiscordMessage
    message={reminderMessage(dmContext)}
    labels={labels}
    delivery="direct"
    channel="TiaraBot"
  />
);
export const MonitorPingExample = () => (
  <ExampleDiscordMessage
    message={monitorPingMessage(dmContext)}
    labels={labels}
    delivery="direct"
    channel="TiaraBot"
  />
);
export const RoomOrderDraftExample = () => (
  <ExampleDiscordMessage
    message={{ ...roomOrderDraftMessage(roomOrderContent, range, 1), visibility: "ephemeral" }}
    labels={labels}
    channel="marathon-room"
    command={{ name: "room_order manual" }}
  />
);
export const PublishedRoomOrderExample = () => (
  <ExampleDiscordMessage
    message={publishedRoomOrderMessage(roomOrderContent)}
    labels={labels}
    channel="marathon-room"
  />
);
export const TentativeRoomOrderExample = () => (
  <ExampleDiscordMessage
    message={tentativeRoomOrderMessage(roomOrderContent, range, 1)}
    labels={labels}
    channel="marathon-room"
  />
);
export const RoomOrderSendResultExample = () => (
  <ExampleDiscordMessage
    message={{ ...roomOrderSendAcknowledgementMessage(true), visibility: "ephemeral" }}
    labels={labels}
    channel="marathon-room"
    command={{ name: "room_order manual" }}
  />
);
export const TentativeRoomOrderPinResultExample = () => (
  <ExampleDiscordMessage
    message={{ ...tentativeRoomOrderPinAcknowledgementMessage(true), visibility: "ephemeral" }}
    labels={labels}
    channel="marathon-room"
  />
);
