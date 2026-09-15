import { DateTime } from "effect";
import { describe, expect, it } from "vitest";
import { renderPlainText } from "./text";
import { buildRoomOrderContent } from "./roomOrderContent";

const start = DateTime.makeUnsafe("2026-07-18T12:00:00.000Z");
const end = DateTime.makeUnsafe("2026-07-18T13:00:00.000Z");
const entries = [{ position: 0, team: "Nightcord", tags: [], effectValue: 35 }];

const renderRoomOrder = (handoff: {
  readonly currentMonitor: string | null;
  readonly previousMonitor: string | null;
  readonly previousMonitorHistoryKnown: boolean;
}) =>
  renderPlainText(
    buildRoomOrderContent(
      4,
      start,
      end,
      handoff,
      [{ key: "filler-out", name: "MikuEnjoyer" }],
      [{ key: "filler-in", name: "AiriFan" }],
      entries,
    ),
  );

describe("buildRoomOrderContent", () => {
  it.each([
    {
      name: "renders a first assignment as incoming",
      handoff: {
        currentMonitor: "Airi",
        previousMonitor: null,
        previousMonitorHistoryKnown: true,
      },
      monitorLine: "Monis: In Airi",
    },
    {
      name: "renders a monitor handoff with both assignments",
      handoff: {
        currentMonitor: "Airi",
        previousMonitor: "Miku",
        previousMonitorHistoryKnown: true,
      },
      monitorLine: "Monis: In Airi · Out Miku",
    },
    {
      name: "renders an unchanged assignment without a movement marker",
      handoff: {
        currentMonitor: "Miku",
        previousMonitor: "Miku",
        previousMonitorHistoryKnown: true,
      },
      monitorLine: "Monis: Miku",
    },
    {
      name: "renders a departure as outgoing",
      handoff: {
        currentMonitor: null,
        previousMonitor: "Miku",
        previousMonitorHistoryKnown: true,
      },
      monitorLine: "Monis: Out Miku",
    },
    {
      name: "omits adjacent unassigned hours",
      handoff: {
        currentMonitor: null,
        previousMonitor: null,
        previousMonitorHistoryKnown: true,
      },
      monitorLine: null,
    },
    {
      name: "does not claim movement when previous history is unknown",
      handoff: {
        currentMonitor: "Airi",
        previousMonitor: "Miku",
        previousMonitorHistoryKnown: false,
      },
      monitorLine: "Monis: Airi",
    },
  ])("$name", ({ handoff, monitorLine }) => {
    const content = renderRoomOrder(handoff);

    if (monitorLine === null) {
      expect(content).not.toContain("Monis:");
    } else {
      expect(content).toContain(monitorLine);
      expect(content.indexOf(monitorLine)).toBeGreaterThan(content.indexOf("Hour 4"));
      expect(content.indexOf(monitorLine)).toBeLessThan(content.indexOf("P1:"));
    }
    expect(content).toContain("In: AiriFan");
    expect(content).toContain("Out: MikuEnjoyer");
    expect(content).not.toContain("@Airi");
    expect(content).not.toContain("@Miku");
  });
});
