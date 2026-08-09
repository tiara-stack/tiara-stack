import {
  AuthorizationLoadWorkspaceCapabilities,
  DiscordLoadProfile,
  DiscordLoadWorkspaceChannels,
  DiscordLoadWorkspaceRoles,
  NotificationsLoadSupportedClients,
  SchedulesLoadWorkspace,
} from "sheet-workflow-contracts";

export const ReadOnlySheetWorkflowContracts = Object.freeze([
  DiscordLoadProfile,
  DiscordLoadWorkspaceChannels,
  DiscordLoadWorkspaceRoles,
  AuthorizationLoadWorkspaceCapabilities,
  SchedulesLoadWorkspace,
  NotificationsLoadSupportedClients,
] as const);

export const readOnlySheetWorkflowDefinitionVersion = "1";
