import {
  AuthorizationLoadWorkspaceCapabilities,
  DiscordLoadProfile,
  DiscordLoadWorkspaceChannels,
  DiscordLoadWorkspaceRoles,
  NotificationsLoadSupportedClients,
  SchedulesLoadWorkspace,
  SheetsDescribe,
  SheetsReadSnapshot,
} from "sheet-workflow-contracts";

export const ReadOnlySheetWorkflowContracts = Object.freeze([
  DiscordLoadProfile,
  DiscordLoadWorkspaceChannels,
  DiscordLoadWorkspaceRoles,
  AuthorizationLoadWorkspaceCapabilities,
  SheetsDescribe,
  SheetsReadSnapshot,
  SchedulesLoadWorkspace,
  NotificationsLoadSupportedClients,
] as const);

export const readOnlySheetWorkflowDefinitionVersion = "1";
