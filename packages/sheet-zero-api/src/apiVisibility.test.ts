import { describe, expect, it } from "@effect/vitest";
import * as browser from "./index";
import { SheetZeroApi } from "./api";
import { mutators } from "./mutators";
import { queries } from "./queries";
import * as server from "./server";
import { serverMutators, serverQueries } from "./serverRegistries";

type Descriptor = {
  readonly group: string;
  readonly name: string;
  readonly kind: "query" | "mutator";
  readonly visibility: "public" | "service" | "internal";
};

const catalog = Object.entries(SheetZeroApi.groups).flatMap(([group, value]) =>
  Object.values(value.endpoints).map(
    ({ kind, name, visibility }): Descriptor => ({ group, name, kind, visibility }),
  ),
);

const expectedCatalog = {
  userConfig: [
    "query:public:getUserPlatformConfig",
    "query:public:getCheckinDmEnabledUserConfigs",
    "query:public:getMonitorDmEnabledUserConfigs",
    "mutator:public:upsertUserPlatformConfig",
  ],
  workspaceConfig: [
    "query:public:getAutoCheckinWorkspaces",
    "query:public:getWorkspaceConfigByWorkspaceId",
    "query:public:getWorkspaceMonitorRoles",
    "query:public:getWorkspaceFeatureFlags",
    "query:public:getWorkspacesForFeatureFlag",
    "query:public:getWorkspaceFeatureFlag",
    "query:public:getWorkspaceUpdateAnnouncementDelivery",
    "query:public:getWorkspaceConversations",
    "query:public:getWorkspaceConversationById",
    "query:public:getWorkspaceConversationByName",
    "query:public:getTeamSubmissionChannelByConversationId",
    "query:public:getTeamSubmissionChannelsForWorkspace",
    "mutator:public:upsertWorkspaceConfig",
    "mutator:public:addWorkspaceMonitorRole",
    "mutator:public:removeWorkspaceMonitorRole",
    "mutator:public:addWorkspaceFeatureFlag",
    "mutator:public:removeWorkspaceFeatureFlag",
    "mutator:public:recordWorkspaceUpdateAnnouncementDelivery",
    "mutator:public:claimWorkspaceUpdateAnnouncementDelivery",
    "mutator:public:releaseWorkspaceUpdateAnnouncementDeliveryClaim",
    "mutator:public:upsertWorkspaceConversationConfig",
    "mutator:public:upsertTeamSubmissionChannel",
    "mutator:public:removeTeamSubmissionChannel",
  ],
  sheetConfiguration: [
    "query:public:getSheetConfiguration",
    "query:public:getSheetConfigurationRevisions",
    "query:service:getSheetConfigurationRevisionById",
    "query:service:getSheetConfigurationRevisionsBySpreadsheetId",
    "query:public:getSheetConfigurationImportAttempt",
    "mutator:service:recordSheetConfigurationAudit",
    "mutator:service:upsertSheetConfigurationDraft",
    "mutator:service:saveSheetConfigurationRevision",
    "mutator:service:activateSheetConfigurationRevision",
    "mutator:service:rollbackSheetConfiguration",
    "mutator:service:discardSheetConfigurationDraft",
    "mutator:service:upsertSheetConfigurationImportAttempt",
  ],
  checkinMessages: [
    "query:service:getMessageSet",
    "query:service:getHourlyMessage",
    "query:service:listHourlyMessages",
    "query:service:getSaveReceipt",
    "mutator:service:reconcileMessageSet",
    "mutator:service:saveHourlyMessage",
  ],
  messageCheckin: [
    "query:public:getMessageCheckinData",
    "query:public:getMessageCheckinMembers",
    "mutator:public:upsertMessageCheckinData",
    "mutator:public:addMessageCheckinMembers",
    "mutator:public:persistMessageCheckin",
    "mutator:public:setMessageCheckinMemberCheckinAt",
    "mutator:public:setMessageCheckinMemberCheckinAtIfUnset",
    "mutator:public:removeMessageCheckinMember",
    "mutator:public:removeMessageCheckin",
  ],
  messageRoomOrder: [
    "query:public:getMessageRoomOrder",
    "query:public:getMessageRoomOrderEntry",
    "query:public:getMessageRoomOrderRange",
    "mutator:public:decrementMessageRoomOrderRank",
    "mutator:public:incrementMessageRoomOrderRank",
    "mutator:public:claimMessageRoomOrderSend",
    "mutator:public:completeMessageRoomOrderSend",
    "mutator:public:releaseMessageRoomOrderSendClaim",
    "mutator:public:claimMessageRoomOrderTentativeUpdate",
    "mutator:public:releaseMessageRoomOrderTentativeUpdateClaim",
    "mutator:public:claimMessageRoomOrderTentativePin",
    "mutator:public:completeMessageRoomOrderTentativePin",
    "mutator:public:releaseMessageRoomOrderTentativePinClaim",
    "mutator:public:markMessageRoomOrderTentative",
    "mutator:public:upsertMessageRoomOrder",
    "mutator:public:persistMessageRoomOrder",
    "mutator:public:bindMessageRoomOrderIfAbsent",
    "mutator:public:upsertMessageRoomOrderEntry",
    "mutator:public:removeMessageRoomOrderEntry",
  ],
  messageSlot: [
    "query:public:getMessageSlotData",
    "query:public:getMessageSlotDataByConversation",
    "mutator:public:upsertMessageSlotData",
    "mutator:public:removeMessageSlotData",
    "mutator:public:replaceMessageSlotData",
  ],
  messageTeamSubmission: [
    "query:public:getMessageTeamSubmission",
    "query:public:getMessageTeamSubmissionByDiscordMessage",
    "mutator:public:upsertMessageTeamSubmission",
    "mutator:public:setMessageTeamSubmissionConfirmation",
  ],
  runs: [
    "query:public:get",
    "query:public:list",
    "mutator:internal:enqueue",
    "mutator:service:enqueueAsCaller",
    "mutator:internal:command",
    "mutator:internal:sendEvent",
  ],
} as const;

const projectCatalog = () =>
  Object.fromEntries(
    Object.entries(SheetZeroApi.groups).map(([group, value]) => [
      group,
      Object.values(value.endpoints).map(
        ({ kind, name, visibility }) => `${kind}:${visibility}:${name}`,
      ),
    ]),
  );

const registryNames = (registry: Record<string, unknown>) =>
  Object.entries(registry).flatMap(([group, definitions]) =>
    group === "~"
      ? []
      : Object.keys(definitions as Record<string, unknown>).flatMap((name) =>
          name === "~" ? [] : [`${group}.${name}`],
        ),
  );

const catalogNames = (
  selectedKind: Descriptor["kind"],
  selectedVisibilities: ReadonlySet<Descriptor["visibility"]>,
) =>
  catalog
    .filter(({ kind, visibility }) => kind === selectedKind && selectedVisibilities.has(visibility))
    .map(({ group, name }) => `${group}.${name}`)
    .sort();

describe("Sheet Zero API visibility", () => {
  it("preserves the exhaustive 88-procedure catalog and visibility split", () => {
    expect(projectCatalog()).toEqual(expectedCatalog);
    expect(catalog).toHaveLength(88);
    expect(catalog.filter(({ visibility }) => visibility === "public")).toHaveLength(69);
    expect(catalog.filter(({ visibility }) => visibility === "service")).toHaveLength(16);
    expect(catalog.filter(({ visibility }) => visibility === "internal")).toHaveLength(3);
  });

  it("keeps browser registries public-only", () => {
    const publicVisibility = new Set<Descriptor["visibility"]>(["public"]);
    expect(registryNames(queries).sort()).toEqual(catalogNames("query", publicVisibility));
    expect(registryNames(mutators).sort()).toEqual(catalogNames("mutator", publicVisibility));
  });

  it("keeps server registries public-plus-service and excludes internal procedures", () => {
    const serverVisibility = new Set<Descriptor["visibility"]>(["public", "service"]);
    expect(registryNames(serverQueries).sort()).toEqual(catalogNames("query", serverVisibility));
    expect(registryNames(serverMutators).sort()).toEqual(catalogNames("mutator", serverVisibility));
  });
});

describe("Sheet Zero API entrypoint boundary", () => {
  const trustedExports = [
    "SheetZeroApi",
    "serviceApi",
    "service",
    "internal",
    "serverQueries",
    "serverMutators",
    "makeSheetServiceClient",
    "enqueueWorkflowCommandInZeroTransaction",
    "enqueueWorkflowContractInvocationInZeroTransaction",
    "enqueueWorkflowEventInZeroTransaction",
    "mutateWithWorkflow",
    "enqueueWorkflowInZeroTransaction",
    "defineZeroTableAccess",
  ] as const;

  it("does not expose trusted facilities from the browser root", () => {
    const browserExports = new Set(Object.keys(browser));
    for (const name of trustedExports) {
      expect(browserExports.has(name), `${name} must remain server-only`).toBe(false);
    }
  });

  it("exposes trusted facilities from the browser-blocked server entrypoint", () => {
    expect(Object.keys(server)).toEqual(expect.arrayContaining([...trustedExports]));
  });
});
