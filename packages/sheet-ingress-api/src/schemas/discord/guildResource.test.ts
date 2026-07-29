import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DiscordGuildChannel, DiscordGuildRole } from "./guildResource";

describe("Discord guild resource schemas", () => {
  it("round trips lightweight channel records", () => {
    const channel = {
      id: "channel-1",
      name: "running-room",
      type: 0,
      parentId: "category-1",
      position: 2,
    };
    expect(
      Schema.encodeSync(DiscordGuildChannel)(
        Schema.decodeUnknownSync(DiscordGuildChannel)(channel),
      ),
    ).toEqual(channel);
  });

  it("round trips uncategorized channel records", () => {
    const channel = {
      id: "channel-2",
      name: "uncategorized-room",
      type: 0,
      parentId: null,
      position: 3,
    };
    expect(
      Schema.encodeSync(DiscordGuildChannel)(
        Schema.decodeUnknownSync(DiscordGuildChannel)(channel),
      ),
    ).toEqual(channel);
  });

  it("round trips lightweight role records", () => {
    const role = {
      id: "role-1",
      name: "Mana",
      position: 4,
      color: 0x33ccbb,
      managed: false,
    };
    expect(
      Schema.encodeSync(DiscordGuildRole)(Schema.decodeUnknownSync(DiscordGuildRole)(role)),
    ).toEqual(role);
  });

  it("rejects fractional Discord resource metadata", () => {
    expect(() =>
      Schema.decodeUnknownSync(DiscordGuildChannel)({
        id: "channel-1",
        name: "running-room",
        type: 0.5,
        parentId: null,
        position: 2,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(DiscordGuildRole)({
        id: "role-1",
        name: "Mana",
        position: 4,
        color: 1.5,
        managed: false,
      }),
    ).toThrow();
  });
});
