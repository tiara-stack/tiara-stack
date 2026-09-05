import { defineWorkflowContractCatalog } from "effect-zero-workflow/contract";
import type { WorkflowContractSchema } from "effect-zero-workflow/contract";
import * as Failures from "./failures";
import { defineSheetWorkflowContract } from "./policy";
import type {
  SheetWorkflowAuthorizationResource,
  SheetWorkflowCapability,
  SheetWorkflowPrincipalKind,
  SheetWorkflowUserRule,
} from "./policy";
import * as Values from "./values";

type AuthorizationPolicyUserRuleInput =
  | {
      readonly targetUserField: string;
      readonly userRule: SheetWorkflowUserRule;
    }
  | {
      readonly targetUserField?: never;
      readonly userRule?: never;
    };

type AuthorizationPolicyInput = {
  readonly principalKinds: ReadonlyArray<SheetWorkflowPrincipalKind>;
  readonly requiredCapabilities: ReadonlyArray<SheetWorkflowCapability>;
  readonly requiredAnyCapabilities?: ReadonlyArray<SheetWorkflowCapability>;
  readonly resource: SheetWorkflowAuthorizationResource;
  readonly resourceField?: string;
  readonly serviceRule?: string;
} & AuthorizationPolicyUserRuleInput;

type AuthorizationPolicyVersion = "1" | "2";

const policy = (
  principalKinds: ReadonlyArray<SheetWorkflowPrincipalKind>,
  requiredCapabilities: ReadonlyArray<SheetWorkflowCapability>,
  resource: SheetWorkflowAuthorizationResource,
  options?: {
    readonly resourceField?: string;
    readonly requiredAnyCapabilities?: ReadonlyArray<SheetWorkflowCapability>;
    readonly serviceRule?: string;
  } & AuthorizationPolicyUserRuleInput,
) => ({
  principalKinds: [...principalKinds],
  requiredCapabilities: [...requiredCapabilities],
  resource,
  ...options,
});

const authorizationPolicy = (
  contractIdentity: string,
  input: AuthorizationPolicyInput,
  version: AuthorizationPolicyVersion = "1",
) => ({
  policy: `sheet.workflow.${contractIdentity}.invoke`,
  version,
  ...input,
  revalidateBeforeEffects: true,
});

const contractKind =
  <DeclaredFailure extends WorkflowContractSchema>(declaredFailure: DeclaredFailure) =>
  <
    const Identity extends string,
    Input extends WorkflowContractSchema,
    Success extends WorkflowContractSchema,
  >(
    identity: Identity,
    input: Input,
    success: Success,
    policyInput: AuthorizationPolicyInput,
    authorizationPolicyVersion: AuthorizationPolicyVersion = "1",
  ) =>
    defineSheetWorkflowContract({
      identity,
      wireVersion: "1",
      input,
      success,
      declaredFailure,
      authorizationPolicy: authorizationPolicy(identity, policyInput, authorizationPolicyVersion),
    });

const dataAcquisition = contractKind(Failures.DataAcquisitionDeclaredFailure);
const interactive = contractKind(Failures.InteractiveDeclaredFailure);
const autonomous = contractKind(Failures.AutonomousDeclaredFailure);
const calculation = contractKind(Failures.CalculationDeclaredFailure);
const sheetSnapshot = contractKind(Failures.SheetSnapshotDeclaredFailure);
const checkinMessages = contractKind(Failures.CheckinMessagesDeclaredFailure);

export const DiscordLoadProfile = dataAcquisition(
  "discord.loadProfile",
  Values.EmptyInput,
  Values.DiscordLoadProfileSuccess,
  policy(["user"], ["self"], "self"),
);

export const DiscordLoadWorkspaceChannels = dataAcquisition(
  "discord.loadWorkspaceChannels",
  Values.WorkspaceInput,
  Values.DiscordLoadWorkspaceChannelsSuccess,
  policy(["user"], ["workspace.member"], "workspace", { resourceField: "workspaceId" }),
);

export const DiscordLoadWorkspaceRoles = dataAcquisition(
  "discord.loadWorkspaceRoles",
  Values.WorkspaceInput,
  Values.DiscordLoadWorkspaceRolesSuccess,
  policy(["user"], ["workspace.member"], "workspace", {
    resourceField: "workspaceId",
  }),
);

export const AuthorizationLoadWorkspaceCapabilities = dataAcquisition(
  "authorization.loadWorkspaceCapabilities",
  Values.WorkspaceInput,
  Values.WorkspaceCapabilities,
  policy(["user"], [], "workspace", {
    resourceField: "workspaceId",
  }),
);

export const SheetsDescribe = sheetSnapshot(
  "sheets.describe",
  Values.SheetsDescribeInput,
  Values.SheetsDescribeSuccess,
  policy(["user"], ["workspace.manage"], "workspace", { resourceField: "workspaceId" }),
);

export const SheetsReadSnapshot = sheetSnapshot(
  "sheets.readSnapshot",
  Values.SheetsReadSnapshotInput,
  Values.SheetsReadSnapshotSuccess,
  policy(["user"], ["workspace.manage"], "workspace", { resourceField: "workspaceId" }),
);

export const SheetConfigurationImportLegacy = interactive(
  "sheetConfiguration.importLegacy",
  Values.SheetConfigurationImportLegacyInput,
  Values.SheetConfigurationImportLegacySuccess,
  policy(["user"], ["workspace.manage"], "workspace", { resourceField: "workspaceId" }),
);

export const SheetConfigurationSaveDraft = interactive(
  "sheetConfiguration.saveDraft",
  Values.SheetConfigurationSaveDraftInput,
  Values.SheetConfigurationSaveDraftSuccess,
  policy(["user"], ["workspace.manage"], "workspace", { resourceField: "workspaceId" }),
);

export const SheetConfigurationEditDraft = interactive(
  "sheetConfiguration.editDraft",
  Values.SheetConfigurationEditDraftInput,
  Values.SheetConfigurationEditDraftSuccess,
  policy(["user"], ["workspace.manage"], "workspace", { resourceField: "workspaceId" }),
);

export const SheetConfigurationSaveRevision = interactive(
  "sheetConfiguration.saveRevision",
  Values.SheetConfigurationSaveRevisionInput,
  Values.SheetConfigurationSaveRevisionSuccess,
  policy(["user"], ["workspace.manage"], "workspace", { resourceField: "workspaceId" }),
);

export const SheetConfigurationActivate = interactive(
  "sheetConfiguration.activate",
  Values.SheetConfigurationActivateInput,
  Values.SheetConfigurationActivateSuccess,
  policy(["user"], ["workspace.manage"], "workspace", { resourceField: "workspaceId" }),
);

export const SheetConfigurationRollback = interactive(
  "sheetConfiguration.rollback",
  Values.SheetConfigurationRollbackInput,
  Values.SheetConfigurationRollbackSuccess,
  policy(["user"], ["workspace.manage"], "workspace", { resourceField: "workspaceId" }),
);

export const SheetConfigurationDiscardDraft = interactive(
  "sheetConfiguration.discardDraft",
  Values.SheetConfigurationDiscardDraftInput,
  Values.SheetConfigurationDiscardDraftSuccess,
  policy(["user"], ["workspace.manage"], "workspace", { resourceField: "workspaceId" }),
);

export const SchedulesLoadWorkspace = dataAcquisition(
  "schedules.loadWorkspace",
  Values.WorkspaceInput,
  Values.SchedulesLoadWorkspaceSuccess,
  policy(["user"], ["workspace.member"], "workspace", {
    resourceField: "workspaceId",
  }),
);

export const CheckinMessagesLoad = checkinMessages(
  "checkinMessages.load",
  Values.CheckinMessagesLoadInput,
  Values.CheckinMessagesLoadSuccess,
  policy(["user"], [], "workspace", {
    resourceField: "workspaceId",
    requiredAnyCapabilities: ["workspace.monitor", "workspace.manage"],
  }),
);

export const CheckinMessagesSave = checkinMessages(
  "checkinMessages.save",
  Values.CheckinMessagesSaveInput,
  Values.CheckinMessagesSaveSuccess,
  policy(["user"], [], "workspace", {
    resourceField: "workspaceId",
    requiredAnyCapabilities: ["workspace.monitor", "workspace.manage"],
  }),
);

export const NotificationsLoadSupportedClients = dataAcquisition(
  "notifications.loadSupportedClients",
  Values.NotificationsLoadSupportedClientsInput,
  Values.NotificationsLoadSupportedClientsSuccess,
  policy(["user"], ["self"], "self"),
);

export const CheckinsOpen = interactive(
  "checkins.open",
  Values.CheckinsOpenInput,
  Values.CheckinsOpenSuccess,
  policy(["user", "service"], ["workspace.member"], "workspace", {
    resourceField: "workspaceId",
    serviceRule: "auto-checkin",
  }),
);

export const CheckinsTestAuto = interactive(
  "checkins.testAuto",
  Values.CheckinsTestAutoInput,
  Values.CheckinsTestAutoSuccess,
  policy(["user"], ["workspace.manage"], "workspace", {
    resourceField: "workspaceId",
  }),
);

export const CheckinsRespond = interactive(
  "checkins.respond",
  Values.CheckinsRespondInput,
  Values.CheckinsRespondSuccess,
  policy(["user"], ["workspace.participant"], "message", {
    resourceField: "messageId",
  }),
);

export const RoomOrdersCreate = interactive(
  "roomOrders.create",
  Values.RoomOrdersCreateInput,
  Values.RoomOrdersCreateSuccess,
  policy(["user"], ["workspace.member"], "workspace", {
    resourceField: "workspaceId",
  }),
);

export const RoomOrdersNavigate = interactive(
  "roomOrders.navigate",
  Values.RoomOrdersNavigateInput,
  Values.RoomOrderOperationSuccess,
  policy(["user"], ["workspace.monitor"], "message", {
    resourceField: "messageId",
  }),
  "2",
);

export const RoomOrdersSend = interactive(
  "roomOrders.send",
  Values.RoomOrdersSendInput,
  Values.RoomOrderOperationSuccess,
  policy(["user"], ["workspace.monitor"], "message", {
    resourceField: "messageId",
  }),
  "2",
);

export const RoomOrdersPinTentative = interactive(
  "roomOrders.pinTentative",
  Values.RoomOrdersPinTentativeInput,
  Values.RoomOrderOperationSuccess,
  policy(["user"], ["workspace.monitor"], "message", {
    resourceField: "messageId",
  }),
  "2",
);

export const SlotsDeliverList = interactive(
  "slots.deliverList",
  Values.SlotsDeliverListInput,
  Values.SlotsDeliverListSuccess,
  policy(["user"], ["workspace.member"], "workspace", {
    resourceField: "workspaceId",
  }),
);

export const SlotsPublishButton = interactive(
  "slots.publishButton",
  Values.SlotsPublishButtonInput,
  Values.SlotsPublishButtonSuccess,
  policy(["user"], ["workspace.monitor"], "workspace", {
    resourceField: "workspaceId",
  }),
);

export const SlotsRemoveButton = interactive(
  "slots.removeButton",
  Values.SlotsRemoveButtonInput,
  Values.SlotsRemoveButtonSuccess,
  policy(["user"], ["workspace.monitor"], "workspace", {
    resourceField: "workspaceId",
  }),
);

export const SlotsRefreshButton = autonomous(
  "slots.refreshButton",
  Values.SlotsRefreshButtonInput,
  Values.SlotsRefreshButtonSuccess,
  policy(["service"], ["service.allowed"], "workspace", {
    resourceField: "workspaceId",
    serviceRule: "sheet-bot.gateway",
  }),
);

export const SlotsOpen = interactive(
  "slots.open",
  Values.SlotsOpenInput,
  Values.SlotsOpenSuccess,
  policy(["user"], ["workspace.member"], "message", {
    resourceField: "messageId",
  }),
  "2",
);

export const MembersKick = interactive(
  "members.kick",
  Values.MembersKickInput,
  Values.MembersKickSuccess,
  policy(["user", "service"], ["workspace.monitor"], "workspace", {
    resourceField: "workspaceId",
    serviceRule: "auto-role-cleanup",
  }),
);

export const PreferencesDeliverStatus = interactive(
  "preferences.deliverStatus",
  Values.PreferencesDeliverStatusInput,
  Values.PreferencesDeliverySuccess,
  policy(["user"], ["self"], "self"),
);

export const PreferencesUpdateAndDeliver = interactive(
  "preferences.updateAndDeliver",
  Values.PreferencesUpdateAndDeliverInput,
  Values.PreferencesDeliverySuccess,
  policy(["user"], ["self"], "self"),
);

export const WorkspacesDeliverConfig = interactive(
  "workspaces.deliverConfig",
  Values.WorkspacesDeliverConfigInput,
  Values.WorkspaceConfigDeliverySuccess,
  policy(["user"], ["workspace.manage"], "workspace", {
    resourceField: "workspaceId",
  }),
);

export const WorkspacesUpdateConfigAndDeliver = interactive(
  "workspaces.updateConfigAndDeliver",
  Values.WorkspacesUpdateConfigAndDeliverInput,
  Values.WorkspaceConfigDeliverySuccess,
  policy(["user"], ["workspace.manage"], "workspace", { resourceField: "workspaceId" }),
);

export const WorkspacesSetMonitorRoleAndDeliver = interactive(
  "workspaces.setMonitorRoleAndDeliver",
  Values.WorkspacesSetMonitorRoleAndDeliverInput,
  Values.MonitorRoleDeliverySuccess,
  policy(["user"], ["workspace.manage"], "workspace", { resourceField: "workspaceId" }),
);

export const WorkspacesDeliverWelcome = autonomous(
  "workspaces.deliverWelcome",
  Values.WorkspacesDeliverWelcomeInput,
  Values.WorkspacesDeliverWelcomeSuccess,
  policy(["service"], ["service.allowed"], "workspace", {
    resourceField: "workspaceId",
    serviceRule: "sheet-bot.gateway",
  }),
);

export const WorkspacesFeatureFlagsSetAndDeliver = interactive(
  "workspaces.featureFlags.setAndDeliver",
  Values.WorkspacesFeatureFlagsSetAndDeliverInput,
  Values.WorkspacesFeatureFlagsSetAndDeliverSuccess,
  policy(["user", "service"], ["workspace.manage"], "workspace", {
    resourceField: "workspaceId",
    serviceRule: "sheet-bot.gateway",
  }),
);

export const ConversationsDeliverConfig = interactive(
  "conversations.deliverConfig",
  Values.ConversationsDeliverConfigInput,
  Values.ConversationConfigDeliverySuccess,
  policy(["user"], ["workspace.manage"], "workspace", {
    resourceField: "workspaceId",
  }),
);

export const ConversationsUpdateConfigAndDeliver = interactive(
  "conversations.updateConfigAndDeliver",
  Values.ConversationsUpdateConfigAndDeliverInput,
  Values.ConversationConfigDeliverySuccess,
  policy(["user"], ["workspace.manage"], "workspace", { resourceField: "workspaceId" }),
);

export const ConversationsSetLockdown = interactive(
  "conversations.setLockdown",
  Values.ConversationsSetLockdownInput,
  Values.ConversationsSetLockdownSuccess,
  policy(["user"], ["workspace.manage"], "workspace", {
    resourceField: "workspaceId",
  }),
);

export const TeamsDeliverList = interactive(
  "teams.deliverList",
  Values.TeamsDeliverListInput,
  Values.TeamsDeliverListSuccess,
  policy(["user"], [], "workspace", {
    resourceField: "workspaceId",
    targetUserField: "targetUserId",
    userRule: "target-user-or-workspace-monitor-or-application-owner",
  }),
  "2",
);

export const SchedulesDeliverUserSchedule = interactive(
  "schedules.deliverUserSchedule",
  Values.SchedulesDeliverUserScheduleInput,
  Values.SchedulesDeliverUserScheduleSuccess,
  policy(["user"], [], "workspace", {
    resourceField: "workspaceId",
    targetUserField: "targetUserId",
    userRule: "target-user-or-workspace-monitor-or-application-owner",
  }),
  "2",
);

export const ScreenshotsCaptureAndDeliver = interactive(
  "screenshots.captureAndDeliver",
  Values.ScreenshotsCaptureAndDeliverInput,
  Values.ScreenshotsCaptureAndDeliverSuccess,
  policy(["user"], ["workspace.monitor"], "workspace", { resourceField: "workspaceId" }),
  "2",
);

export const ServicesDeliverStatus = interactive(
  "services.deliverStatus",
  Values.ServicesDeliverStatusInput,
  Values.ServicesDeliverStatusSuccess,
  policy(["user"], ["application.owner"], "system"),
);

export const TeamSubmissionsProcess = autonomous(
  "teamSubmissions.process",
  Values.TeamSubmissionsProcessInput,
  Values.TeamSubmissionsProcessSuccess,
  policy(["service"], ["service.allowed"], "submission", {
    resourceField: "sourceMessage",
    serviceRule: "sheet-bot.gateway",
  }),
);

export const TeamSubmissionsDecide = interactive(
  "teamSubmissions.decide",
  Values.TeamSubmissionsDecideInput,
  Values.TeamSubmissionsDecideSuccess,
  policy(["user"], ["workspace.participant"], "submission", {
    resourceField: "sourceMessage",
  }),
);

export const AnnouncementsDeliverUpdate = autonomous(
  "announcements.deliverUpdate",
  Values.AnnouncementsDeliverUpdateInput,
  Values.AnnouncementsDeliverUpdateSuccess,
  policy(["service"], ["service.allowed"], "workspace", {
    resourceField: "workspaceId",
    serviceRule: "sheet-bot.gateway",
  }),
);

export const CalculationsRecalculateSheet = calculation(
  "calculations.recalculateSheet",
  Values.CalculationsRecalculateSheetInput,
  Values.CalculationsRecalculateSheetSuccess,
  policy(["service"], ["service.allowed"], "spreadsheet", {
    resourceField: "spreadsheetId",
    serviceRule: "apps-script.installation",
  }),
);

export const SheetWorkflowContracts = Object.freeze({
  discord: Object.freeze({
    loadProfile: DiscordLoadProfile,
    loadWorkspaceChannels: DiscordLoadWorkspaceChannels,
    loadWorkspaceRoles: DiscordLoadWorkspaceRoles,
  }),
  authorization: Object.freeze({
    loadWorkspaceCapabilities: AuthorizationLoadWorkspaceCapabilities,
  }),
  sheets: Object.freeze({
    describe: SheetsDescribe,
    readSnapshot: SheetsReadSnapshot,
  }),
  sheetConfiguration: Object.freeze({
    importLegacy: SheetConfigurationImportLegacy,
    saveDraft: SheetConfigurationSaveDraft,
    editDraft: SheetConfigurationEditDraft,
    saveRevision: SheetConfigurationSaveRevision,
    activate: SheetConfigurationActivate,
    rollback: SheetConfigurationRollback,
    discardDraft: SheetConfigurationDiscardDraft,
  }),
  schedules: Object.freeze({
    loadWorkspace: SchedulesLoadWorkspace,
    deliverUserSchedule: SchedulesDeliverUserSchedule,
  }),
  checkinMessages: Object.freeze({
    load: CheckinMessagesLoad,
    save: CheckinMessagesSave,
  }),
  notifications: Object.freeze({
    loadSupportedClients: NotificationsLoadSupportedClients,
  }),
  checkins: Object.freeze({
    open: CheckinsOpen,
    testAuto: CheckinsTestAuto,
    respond: CheckinsRespond,
  }),
  roomOrders: Object.freeze({
    create: RoomOrdersCreate,
    navigate: RoomOrdersNavigate,
    send: RoomOrdersSend,
    pinTentative: RoomOrdersPinTentative,
  }),
  slots: Object.freeze({
    deliverList: SlotsDeliverList,
    publishButton: SlotsPublishButton,
    removeButton: SlotsRemoveButton,
    refreshButton: SlotsRefreshButton,
    open: SlotsOpen,
  }),
  members: Object.freeze({ kick: MembersKick }),
  preferences: Object.freeze({
    deliverStatus: PreferencesDeliverStatus,
    updateAndDeliver: PreferencesUpdateAndDeliver,
  }),
  workspaces: Object.freeze({
    deliverConfig: WorkspacesDeliverConfig,
    updateConfigAndDeliver: WorkspacesUpdateConfigAndDeliver,
    setMonitorRoleAndDeliver: WorkspacesSetMonitorRoleAndDeliver,
    deliverWelcome: WorkspacesDeliverWelcome,
    featureFlags: Object.freeze({ setAndDeliver: WorkspacesFeatureFlagsSetAndDeliver }),
  }),
  conversations: Object.freeze({
    deliverConfig: ConversationsDeliverConfig,
    updateConfigAndDeliver: ConversationsUpdateConfigAndDeliver,
    setLockdown: ConversationsSetLockdown,
  }),
  teams: Object.freeze({ deliverList: TeamsDeliverList }),
  screenshots: Object.freeze({ captureAndDeliver: ScreenshotsCaptureAndDeliver }),
  services: Object.freeze({ deliverStatus: ServicesDeliverStatus }),
  teamSubmissions: Object.freeze({
    process: TeamSubmissionsProcess,
    decide: TeamSubmissionsDecide,
  }),
  announcements: Object.freeze({ deliverUpdate: AnnouncementsDeliverUpdate }),
  calculations: Object.freeze({ recalculateSheet: CalculationsRecalculateSheet }),
});

export const SheetWorkflowContractCatalog = defineWorkflowContractCatalog(
  DiscordLoadProfile,
  DiscordLoadWorkspaceChannels,
  DiscordLoadWorkspaceRoles,
  AuthorizationLoadWorkspaceCapabilities,
  SheetsDescribe,
  SheetsReadSnapshot,
  SheetConfigurationImportLegacy,
  SheetConfigurationSaveDraft,
  SheetConfigurationEditDraft,
  SheetConfigurationSaveRevision,
  SheetConfigurationActivate,
  SheetConfigurationRollback,
  SheetConfigurationDiscardDraft,
  SchedulesLoadWorkspace,
  CheckinMessagesLoad,
  CheckinMessagesSave,
  NotificationsLoadSupportedClients,
  CheckinsOpen,
  CheckinsTestAuto,
  CheckinsRespond,
  RoomOrdersCreate,
  RoomOrdersNavigate,
  RoomOrdersSend,
  RoomOrdersPinTentative,
  SlotsDeliverList,
  SlotsPublishButton,
  SlotsRemoveButton,
  SlotsRefreshButton,
  SlotsOpen,
  MembersKick,
  PreferencesDeliverStatus,
  PreferencesUpdateAndDeliver,
  WorkspacesDeliverConfig,
  WorkspacesUpdateConfigAndDeliver,
  WorkspacesSetMonitorRoleAndDeliver,
  WorkspacesDeliverWelcome,
  WorkspacesFeatureFlagsSetAndDeliver,
  ConversationsDeliverConfig,
  ConversationsUpdateConfigAndDeliver,
  ConversationsSetLockdown,
  TeamsDeliverList,
  SchedulesDeliverUserSchedule,
  ScreenshotsCaptureAndDeliver,
  ServicesDeliverStatus,
  TeamSubmissionsProcess,
  TeamSubmissionsDecide,
  AnnouncementsDeliverUpdate,
  CalculationsRecalculateSheet,
);

export type SheetWorkflowContract = (typeof SheetWorkflowContractCatalog)[number];
