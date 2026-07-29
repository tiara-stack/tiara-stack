import { ChannelType, PermissionFlagsBits } from "discord-api-types/v10";
import type { ChannelPermissionOverwrite } from "dfx-discord-utils/discord/schema";
import { Equal, Predicate } from "effect";
import { makeArgumentError } from "typhoon-core/error";

const isDiscordTextChannelType = Equal.equals(ChannelType.GuildText);

export const isDiscordCategoryChannelType = Equal.equals(ChannelType.GuildCategory);

export const isDiscordAnnouncementChannelType = Equal.equals(ChannelType.GuildAnnouncement);

export const isSendableDiscordChannelType = Predicate.or(
  isDiscordTextChannelType,
  isDiscordAnnouncementChannelType,
);

const lockdownRoleBits =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.UseExternalEmojis;

const monitorRoleBits =
  lockdownRoleBits | PermissionFlagsBits.ManageChannels | PermissionFlagsBits.PinMessages;

export const isLockdownRoleIdAllowed = (workspaceId: string, roleId: string) =>
  Predicate.not(Equal.equals(workspaceId))(roleId);

export const lockdownEveryoneRoleErrorMessage =
  "The @everyone role cannot be used as the lockdown role";

export const makeLockdownPermissionOverwrites = ({
  workspaceId,
  lockdownRoleId,
  monitorRoleIds,
}: {
  readonly workspaceId: string;
  readonly lockdownRoleId: string;
  readonly monitorRoleIds: ReadonlyArray<string>;
}): ReadonlyArray<typeof ChannelPermissionOverwrite.Type> => {
  if (!isLockdownRoleIdAllowed(workspaceId, lockdownRoleId)) {
    throw makeArgumentError(lockdownEveryoneRoleErrorMessage);
  }

  return [
    {
      id: lockdownRoleId,
      type: 0,
      allow: lockdownRoleBits.toString(),
      deny: "0",
    },
    ...Array.from(new Set(monitorRoleIds))
      .filter((monitorRoleId) => monitorRoleId !== lockdownRoleId && monitorRoleId !== workspaceId)
      .map((monitorRoleId) => ({
        id: monitorRoleId,
        type: 0 as const,
        allow: monitorRoleBits.toString(),
        deny: "0",
      })),
    {
      id: workspaceId,
      type: 0,
      allow: "0",
      deny: PermissionFlagsBits.ViewChannel.toString(),
    },
  ];
};
