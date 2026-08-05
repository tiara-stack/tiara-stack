import {
  DiscordChannel as WorkflowDiscordChannel,
  DiscordRole as WorkflowDiscordRole,
} from "sheet-workflow-contracts/values";

// Temporary gateway-era compatibility names. New consumers import the workflow-owned schemas.
export const DiscordGuildChannel = WorkflowDiscordChannel;

export type DiscordGuildChannel = typeof DiscordGuildChannel.Type;

export const DiscordGuildRole = WorkflowDiscordRole;

export type DiscordGuildRole = typeof DiscordGuildRole.Type;
