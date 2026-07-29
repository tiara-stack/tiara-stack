import { ChannelType, PermissionFlagsBits } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import {
  isDiscordAnnouncementChannelType,
  isDiscordCategoryChannelType,
  isSendableDiscordChannelType,
  makeLockdownPermissionOverwrites,
} from "./guild-config";

describe("guild configuration policy", () => {
  it("recognizes only text and announcement channels as sendable", () => {
    expect(isSendableDiscordChannelType(ChannelType.GuildText)).toBe(true);
    expect(isSendableDiscordChannelType(ChannelType.GuildAnnouncement)).toBe(true);
    expect(isSendableDiscordChannelType(ChannelType.GuildVoice)).toBe(false);
    expect(isSendableDiscordChannelType(ChannelType.GuildCategory)).toBe(false);
  });

  it("recognizes category and announcement channel types", () => {
    expect(isDiscordCategoryChannelType(ChannelType.GuildCategory)).toBe(true);
    expect(isDiscordCategoryChannelType(ChannelType.GuildText)).toBe(false);
    expect(isDiscordAnnouncementChannelType(ChannelType.GuildAnnouncement)).toBe(true);
    expect(isDiscordAnnouncementChannelType(ChannelType.GuildText)).toBe(false);
  });

  it("builds the canonical lockdown overwrite set without duplicate roles", () => {
    const lockdownAllow = (
      PermissionFlagsBits.ViewChannel |
      PermissionFlagsBits.ReadMessageHistory |
      PermissionFlagsBits.SendMessages |
      PermissionFlagsBits.UseExternalEmojis
    ).toString();
    const monitorAllow = (
      BigInt(lockdownAllow) |
      PermissionFlagsBits.ManageChannels |
      PermissionFlagsBits.PinMessages
    ).toString();

    expect(
      makeLockdownPermissionOverwrites({
        workspaceId: "guild-1",
        lockdownRoleId: "role-lockdown",
        monitorRoleIds: ["role-monitor", "role-lockdown", "role-monitor", "guild-1"],
      }),
    ).toEqual([
      {
        id: "role-lockdown",
        type: 0,
        allow: lockdownAllow,
        deny: "0",
      },
      {
        id: "role-monitor",
        type: 0,
        allow: monitorAllow,
        deny: "0",
      },
      {
        id: "guild-1",
        type: 0,
        allow: "0",
        deny: PermissionFlagsBits.ViewChannel.toString(),
      },
    ]);
  });

  it("rejects @everyone as the lockdown role", () => {
    expect(() =>
      makeLockdownPermissionOverwrites({
        workspaceId: "guild-1",
        lockdownRoleId: "guild-1",
        monitorRoleIds: [],
      }),
    ).toThrow("The @everyone role cannot be used as the lockdown role");
  });
});
