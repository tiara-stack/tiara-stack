import {
  ConversationsDeliverConfig,
  ConversationsSetLockdown,
  ConversationsUpdateConfigAndDeliver,
  WorkspacesDeliverConfig,
  WorkspacesSetMonitorRoleAndDeliver,
  WorkspacesUpdateConfigAndDeliver,
} from "sheet-workflow-contracts";

export const ConfigurationSheetWorkflowContracts = Object.freeze([
  WorkspacesDeliverConfig,
  WorkspacesUpdateConfigAndDeliver,
  WorkspacesSetMonitorRoleAndDeliver,
  ConversationsDeliverConfig,
  ConversationsUpdateConfigAndDeliver,
  ConversationsSetLockdown,
] as const);

export const configurationSheetWorkflowDefinitionVersion = "1";
