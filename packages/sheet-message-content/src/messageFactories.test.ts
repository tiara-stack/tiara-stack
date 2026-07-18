import { describe, expect, it } from "@effect/vitest";
import { DateTime } from "effect";
import {
  checkinAnnouncementMessage,
  checkinButtonAcknowledgementMessage,
} from "./checkinAnnouncement";
import { buildRoomOrderContent } from "./roomOrderContent";
import { checkinActionRow, roomOrderActionRow, tentativeRoomOrderActionRow } from "./components";
import { checkinPromptMessage } from "./checkinPrompt";
import {
  publishedRoomOrderMessage,
  roomOrderDraftMessage,
  roomOrderSendAcknowledgementMessage,
  tentativeRoomOrderPinAcknowledgementMessage,
  tentativeRoomOrderMessage,
} from "./roomOrderMessage";
import { renderPlainText, text } from "./text";

describe("interactive message factories", () => {
  const range = { minRank: 0, maxRank: 2 };
  const content = [text("Room order")];

  it("uses the production check-in button", () => {
    expect(checkinPromptMessage(content)).toEqual({
      content,
      components: [checkinActionRow()],
    });
    expect(checkinActionRow().components).toEqual([
      {
        type: "button",
        actionId: "interaction:checkin",
        label: "Check in",
        style: "primary",
        emoji: { id: "907705464215711834", name: "Miku_Happy" },
        disabled: false,
      },
    ]);
  });

  it("uses the production successful check-in announcement", () => {
    expect(checkinAnnouncementMessage("filler-1")).toEqual({
      content: [
        { type: "userMention", userId: "filler-1" },
        { type: "text", text: " has checked in!" },
      ],
    });
    expect(checkinButtonAcknowledgementMessage(true)).toEqual({
      content: "You have been checked in!",
    });
    expect(checkinButtonAcknowledgementMessage(false)).toEqual({
      content: "You have already been checked in!",
    });
  });

  it("uses the production room-order controls", () => {
    expect(roomOrderDraftMessage(content, range, 1)).toEqual({
      content,
      components: [roomOrderActionRow(range, 1)],
    });
    expect(
      roomOrderActionRow(range, 1).components.map(({ label, disabled }) => [label, disabled]),
    ).toEqual([
      ["Previous", false],
      ["Next", false],
      ["Send", false],
    ]);
    expect(tentativeRoomOrderActionRow(range, 1).components).toEqual([
      expect.objectContaining({ label: "Previous", style: "secondary", disabled: false }),
      expect.objectContaining({ label: "Next", style: "secondary", disabled: false }),
      expect.objectContaining({
        label: "Pin",
        style: "primary",
        emoji: { name: "📌" },
        disabled: false,
      }),
    ]);
  });

  it("keeps published room orders button-free and prefixes tentative ones", () => {
    expect(publishedRoomOrderMessage(content)).toEqual({ content });
    expect(tentativeRoomOrderMessage(content, range, 1)).toEqual({
      content: [text("(tentative)"), text("\n"), ...content],
      components: [tentativeRoomOrderActionRow(range, 1)],
    });
    expect(roomOrderSendAcknowledgementMessage(true)).toEqual({
      content: "sent room order and pinned it!",
    });
    expect(tentativeRoomOrderPinAcknowledgementMessage(true)).toEqual({
      content: "pinned tentative room order!",
    });
  });

  it("renders room-order content with the production formatter", () => {
    const roomOrder = buildRoomOrderContent(
      4,
      DateTime.makeUnsafe("2026-07-18T12:00:00.000Z"),
      DateTime.makeUnsafe("2026-07-18T13:00:00.000Z"),
      "Moni",
      [{ key: "filler-2", name: "MikuEnjoyer" }],
      [{ key: "filler-1", name: "AiriFan" }],
      [{ position: 0, team: "Nightcord", tags: ["enc"], effectValue: 35 }],
    );

    expect(renderPlainText(roomOrder)).toBe(
      "Hour 4 2026-07-18T12:00:00.000Z - 2026-07-18T13:00:00.000Z\nMonitor: Moni\n\nP1:  Nightcord (+35%, enc)\n\nIn: AiriFan\nOut: MikuEnjoyer",
    );
  });
});
