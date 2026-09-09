import { describe, expect, it } from "@effect/vitest";
import { StringOptionBuilder } from "dfx-discord-utils/utils";
import { channelNameOption, makeChannelNameChoices } from "./channelNameAutocomplete";

describe("channel name autocomplete", () => {
  it("offers only named running conversations and preserves their logical names", () => {
    expect(
      makeChannelNameChoices(
        [
          { name: "late", running: true },
          { name: "main", running: true },
          { name: "announcements", running: false },
          { name: null, running: true },
          { name: "  ", running: true },
        ],
        "",
      ),
    ).toEqual([
      { name: "late", value: "late" },
      { name: "main", value: "main" },
    ]);
  });

  it("filters case-insensitively and caps the Discord choice list", () => {
    const conversations = Array.from({ length: 30 }, (_, index) => ({
      name: `raid-${String(index).padStart(2, "0")}`,
      running: true,
    }));

    expect(makeChannelNameChoices(conversations, "RAID-1")).toHaveLength(10);
    expect(makeChannelNameChoices(conversations, "")).toHaveLength(25);
  });

  it("marks the reusable string option for autocomplete", () => {
    const option = channelNameOption("The running channel")(new StringOptionBuilder());

    expect(option.builder.toJSON()).toMatchObject({
      name: "channel_name",
      autocomplete: true,
    });
  });
});
