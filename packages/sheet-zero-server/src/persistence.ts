import { Context, Effect, Layer } from "effect";
import { makeSheetClient, type Schema, type SheetClient } from "sheet-zero-api";
import type { ZeroClient } from "typhoon-zero/client";

type GroupedSheetClient = SheetClient["grouped"];

type ClientMethod<
  Group extends keyof GroupedSheetClient,
  Method extends keyof GroupedSheetClient[Group],
> = GroupedSheetClient[Group][Method];

export interface TrustedSheetPersistenceShape {
  readonly workspaces: {
    readonly getAutoCheckinWorkspaces: ClientMethod<"workspaceConfig", "getAutoCheckinWorkspaces">;
    readonly getWorkspaceConfigByWorkspaceId: ClientMethod<
      "workspaceConfig",
      "getWorkspaceConfigByWorkspaceId"
    >;
    readonly getWorkspaceMonitorRoles: ClientMethod<"workspaceConfig", "getWorkspaceMonitorRoles">;
    readonly getWorkspaceFeatureFlags: ClientMethod<"workspaceConfig", "getWorkspaceFeatureFlags">;
    readonly getWorkspacesForFeatureFlag: ClientMethod<
      "workspaceConfig",
      "getWorkspacesForFeatureFlag"
    >;
    readonly getWorkspaceFeatureFlag: ClientMethod<"workspaceConfig", "getWorkspaceFeatureFlag">;
    readonly getWorkspaceUpdateAnnouncementDelivery: ClientMethod<
      "workspaceConfig",
      "getWorkspaceUpdateAnnouncementDelivery"
    >;
    readonly getWorkspaceConversations: ClientMethod<
      "workspaceConfig",
      "getWorkspaceConversations"
    >;
    readonly getWorkspaceConversationById: ClientMethod<
      "workspaceConfig",
      "getWorkspaceConversationById"
    >;
    readonly getWorkspaceConversationByName: ClientMethod<
      "workspaceConfig",
      "getWorkspaceConversationByName"
    >;
    readonly getTeamSubmissionChannelByConversationId: ClientMethod<
      "workspaceConfig",
      "getTeamSubmissionChannelByConversationId"
    >;
    readonly getTeamSubmissionChannelsForWorkspace: ClientMethod<
      "workspaceConfig",
      "getTeamSubmissionChannelsForWorkspace"
    >;
    readonly upsertWorkspaceConfig: ClientMethod<"workspaceConfig", "upsertWorkspaceConfig">;
    readonly addWorkspaceMonitorRole: ClientMethod<"workspaceConfig", "addWorkspaceMonitorRole">;
    readonly removeWorkspaceMonitorRole: ClientMethod<
      "workspaceConfig",
      "removeWorkspaceMonitorRole"
    >;
    readonly addWorkspaceFeatureFlag: ClientMethod<"workspaceConfig", "addWorkspaceFeatureFlag">;
    readonly removeWorkspaceFeatureFlag: ClientMethod<
      "workspaceConfig",
      "removeWorkspaceFeatureFlag"
    >;
    readonly recordWorkspaceUpdateAnnouncementDelivery: ClientMethod<
      "workspaceConfig",
      "recordWorkspaceUpdateAnnouncementDelivery"
    >;
    readonly claimWorkspaceUpdateAnnouncementDelivery: ClientMethod<
      "workspaceConfig",
      "claimWorkspaceUpdateAnnouncementDelivery"
    >;
    readonly releaseWorkspaceUpdateAnnouncementDeliveryClaim: ClientMethod<
      "workspaceConfig",
      "releaseWorkspaceUpdateAnnouncementDeliveryClaim"
    >;
    readonly upsertWorkspaceConversationConfig: ClientMethod<
      "workspaceConfig",
      "upsertWorkspaceConversationConfig"
    >;
    readonly upsertTeamSubmissionChannel: ClientMethod<
      "workspaceConfig",
      "upsertTeamSubmissionChannel"
    >;
    readonly removeTeamSubmissionChannel: ClientMethod<
      "workspaceConfig",
      "removeTeamSubmissionChannel"
    >;
  };
  readonly preferences: {
    readonly getUserPlatformConfig: ClientMethod<"userConfig", "getUserPlatformConfig">;
    readonly getCheckinDmEnabledUserConfigs: ClientMethod<
      "userConfig",
      "getCheckinDmEnabledUserConfigs"
    >;
    readonly getMonitorDmEnabledUserConfigs: ClientMethod<
      "userConfig",
      "getMonitorDmEnabledUserConfigs"
    >;
    readonly upsertUserPlatformConfig: ClientMethod<"userConfig", "upsertUserPlatformConfig">;
  };
  readonly checkinState: {
    readonly getMessageCheckinData: ClientMethod<"messageCheckin", "getMessageCheckinData">;
    readonly getMessageCheckinMembers: ClientMethod<"messageCheckin", "getMessageCheckinMembers">;
    readonly persistMessageCheckin: ClientMethod<"messageCheckin", "persistMessageCheckin">;
    readonly setMessageCheckinMemberCheckinAtIfUnset: ClientMethod<
      "messageCheckin",
      "setMessageCheckinMemberCheckinAtIfUnset"
    >;
    readonly removeMessageCheckin: ClientMethod<"messageCheckin", "removeMessageCheckin">;
  };
  readonly roomOrderState: {
    readonly getMessageRoomOrder: ClientMethod<"messageRoomOrder", "getMessageRoomOrder">;
    readonly getMessageRoomOrderEntry: ClientMethod<"messageRoomOrder", "getMessageRoomOrderEntry">;
    readonly getMessageRoomOrderRange: ClientMethod<"messageRoomOrder", "getMessageRoomOrderRange">;
    readonly decrementMessageRoomOrderRank: ClientMethod<
      "messageRoomOrder",
      "decrementMessageRoomOrderRank"
    >;
    readonly incrementMessageRoomOrderRank: ClientMethod<
      "messageRoomOrder",
      "incrementMessageRoomOrderRank"
    >;
    readonly claimMessageRoomOrderSend: ClientMethod<
      "messageRoomOrder",
      "claimMessageRoomOrderSend"
    >;
    readonly completeMessageRoomOrderSend: ClientMethod<
      "messageRoomOrder",
      "completeMessageRoomOrderSend"
    >;
    readonly releaseMessageRoomOrderSendClaim: ClientMethod<
      "messageRoomOrder",
      "releaseMessageRoomOrderSendClaim"
    >;
    readonly claimMessageRoomOrderTentativeUpdate: ClientMethod<
      "messageRoomOrder",
      "claimMessageRoomOrderTentativeUpdate"
    >;
    readonly releaseMessageRoomOrderTentativeUpdateClaim: ClientMethod<
      "messageRoomOrder",
      "releaseMessageRoomOrderTentativeUpdateClaim"
    >;
    readonly claimMessageRoomOrderTentativePin: ClientMethod<
      "messageRoomOrder",
      "claimMessageRoomOrderTentativePin"
    >;
    readonly completeMessageRoomOrderTentativePin: ClientMethod<
      "messageRoomOrder",
      "completeMessageRoomOrderTentativePin"
    >;
    readonly releaseMessageRoomOrderTentativePinClaim: ClientMethod<
      "messageRoomOrder",
      "releaseMessageRoomOrderTentativePinClaim"
    >;
    readonly markMessageRoomOrderTentative: ClientMethod<
      "messageRoomOrder",
      "markMessageRoomOrderTentative"
    >;
    readonly persistMessageRoomOrder: ClientMethod<"messageRoomOrder", "persistMessageRoomOrder">;
  };
  readonly slotState: {
    readonly getMessageSlotData: ClientMethod<"messageSlot", "getMessageSlotData">;
    readonly upsertMessageSlotData: ClientMethod<"messageSlot", "upsertMessageSlotData">;
  };
  readonly teamSubmissionState: {
    readonly getMessageTeamSubmission: ClientMethod<
      "messageTeamSubmission",
      "getMessageTeamSubmission"
    >;
    readonly getMessageTeamSubmissionByDiscordMessage: ClientMethod<
      "messageTeamSubmission",
      "getMessageTeamSubmissionByDiscordMessage"
    >;
    readonly upsertMessageTeamSubmission: ClientMethod<
      "messageTeamSubmission",
      "upsertMessageTeamSubmission"
    >;
    readonly setMessageTeamSubmissionConfirmation: ClientMethod<
      "messageTeamSubmission",
      "setMessageTeamSubmissionConfirmation"
    >;
  };
}

export const trustedSheetPersistenceCatalog = {
  workspaces: [
    "getAutoCheckinWorkspaces",
    "getWorkspaceConfigByWorkspaceId",
    "getWorkspaceMonitorRoles",
    "getWorkspaceFeatureFlags",
    "getWorkspacesForFeatureFlag",
    "getWorkspaceFeatureFlag",
    "getWorkspaceUpdateAnnouncementDelivery",
    "getWorkspaceConversations",
    "getWorkspaceConversationById",
    "getWorkspaceConversationByName",
    "getTeamSubmissionChannelByConversationId",
    "getTeamSubmissionChannelsForWorkspace",
    "upsertWorkspaceConfig",
    "addWorkspaceMonitorRole",
    "removeWorkspaceMonitorRole",
    "addWorkspaceFeatureFlag",
    "removeWorkspaceFeatureFlag",
    "recordWorkspaceUpdateAnnouncementDelivery",
    "claimWorkspaceUpdateAnnouncementDelivery",
    "releaseWorkspaceUpdateAnnouncementDeliveryClaim",
    "upsertWorkspaceConversationConfig",
    "upsertTeamSubmissionChannel",
    "removeTeamSubmissionChannel",
  ],
  preferences: [
    "getUserPlatformConfig",
    "getCheckinDmEnabledUserConfigs",
    "getMonitorDmEnabledUserConfigs",
    "upsertUserPlatformConfig",
  ],
  checkinState: [
    "getMessageCheckinData",
    "getMessageCheckinMembers",
    "persistMessageCheckin",
    "setMessageCheckinMemberCheckinAtIfUnset",
    "removeMessageCheckin",
  ],
  roomOrderState: [
    "getMessageRoomOrder",
    "getMessageRoomOrderEntry",
    "getMessageRoomOrderRange",
    "decrementMessageRoomOrderRank",
    "incrementMessageRoomOrderRank",
    "claimMessageRoomOrderSend",
    "completeMessageRoomOrderSend",
    "releaseMessageRoomOrderSendClaim",
    "claimMessageRoomOrderTentativeUpdate",
    "releaseMessageRoomOrderTentativeUpdateClaim",
    "claimMessageRoomOrderTentativePin",
    "completeMessageRoomOrderTentativePin",
    "releaseMessageRoomOrderTentativePinClaim",
    "markMessageRoomOrderTentative",
    "persistMessageRoomOrder",
  ],
  slotState: ["getMessageSlotData", "upsertMessageSlotData"],
  teamSubmissionState: [
    "getMessageTeamSubmission",
    "getMessageTeamSubmissionByDiscordMessage",
    "upsertMessageTeamSubmission",
    "setMessageTeamSubmissionConfirmation",
  ],
} as const satisfies {
  readonly [Group in keyof TrustedSheetPersistenceShape]: ReadonlyArray<
    keyof TrustedSheetPersistenceShape[Group]
  >;
};

type MissingCatalogEntries = {
  readonly [Group in keyof TrustedSheetPersistenceShape]: Exclude<
    keyof TrustedSheetPersistenceShape[Group],
    (typeof trustedSheetPersistenceCatalog)[Group][number]
  >;
};
type AssertCatalogIsExhaustive<
  _Entries extends { readonly [Group in keyof MissingCatalogEntries]: never },
> = true;
type _CatalogIsExhaustive = AssertCatalogIsExhaustive<MissingCatalogEntries>;

const clientGroupByPersistenceGroup = {
  workspaces: (client: GroupedSheetClient) => client.workspaceConfig,
  preferences: (client: GroupedSheetClient) => client.userConfig,
  checkinState: (client: GroupedSheetClient) => client.messageCheckin,
  roomOrderState: (client: GroupedSheetClient) => client.messageRoomOrder,
  slotState: (client: GroupedSheetClient) => client.messageSlot,
  teamSubmissionState: (client: GroupedSheetClient) => client.messageTeamSubmission,
} as const satisfies {
  readonly [Group in keyof TrustedSheetPersistenceShape]: (client: GroupedSheetClient) => {
    readonly [Method in keyof TrustedSheetPersistenceShape[Group]]: TrustedSheetPersistenceShape[Group][Method];
  };
};

const persistenceGroups = Object.keys(clientGroupByPersistenceGroup) as ReadonlyArray<
  keyof TrustedSheetPersistenceShape
>;

const makeTrustedGroup = <Group extends keyof TrustedSheetPersistenceShape>(
  group: Group,
  client: GroupedSheetClient,
): TrustedSheetPersistenceShape[Group] => {
  const source = clientGroupByPersistenceGroup[group](client) as Readonly<
    Record<PropertyKey, unknown>
  >;
  return Object.fromEntries(
    trustedSheetPersistenceCatalog[group].map((method) => [method, source[method]]),
  ) as TrustedSheetPersistenceShape[Group];
};

const makeTrustedView = (client: GroupedSheetClient): TrustedSheetPersistenceShape =>
  Object.fromEntries(
    persistenceGroups.map((group) => [group, makeTrustedGroup(group, client)]),
  ) as unknown as TrustedSheetPersistenceShape;

export class TrustedSheetPersistence extends Context.Service<
  TrustedSheetPersistence,
  TrustedSheetPersistenceShape
>()("sheet-zero-server/TrustedSheetPersistence") {}

export const makeTrustedSheetPersistence = <ClientContext>(
  executor: ZeroClient.ZeroClientExecutor<Schema, ClientContext>,
): Effect.Effect<TrustedSheetPersistenceShape> =>
  makeSheetClient(executor).pipe(Effect.map((client) => makeTrustedView(client.grouped)));

export const makeTrustedSheetPersistenceLayer = <ClientContext>(
  executor: ZeroClient.ZeroClientExecutor<Schema, ClientContext>,
) => Layer.effect(TrustedSheetPersistence, makeTrustedSheetPersistence(executor));
