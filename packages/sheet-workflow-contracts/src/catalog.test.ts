import { Predicate, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  SchedulesDeliverUserSchedule,
  SheetWorkflowContractCatalog,
  SheetWorkflowContracts,
  TeamsDeliverList,
} from "./catalog";
import { SheetWorkflowAuthorizationPolicyMetadata } from "./policy";

const approvedIntentInventory = [
  "discord.loadProfile",
  "discord.loadWorkspaceChannels",
  "discord.loadWorkspaceRoles",
  "authorization.loadWorkspaceCapabilities",
  "schedules.loadWorkspace",
  "notifications.loadSupportedClients",
  "checkins.open",
  "checkins.testAuto",
  "checkins.respond",
  "roomOrders.create",
  "roomOrders.navigate",
  "roomOrders.send",
  "roomOrders.pinTentative",
  "slots.deliverList",
  "slots.publishButton",
  "slots.open",
  "members.kick",
  "preferences.deliverStatus",
  "preferences.updateAndDeliver",
  "workspaces.deliverConfig",
  "workspaces.updateConfigAndDeliver",
  "workspaces.setMonitorRoleAndDeliver",
  "workspaces.deliverWelcome",
  "workspaces.featureFlags.setAndDeliver",
  "conversations.deliverConfig",
  "conversations.updateConfigAndDeliver",
  "conversations.setLockdown",
  "teams.deliverList",
  "schedules.deliverUserSchedule",
  "screenshots.captureAndDeliver",
  "services.deliverStatus",
  "teamSubmissions.process",
  "teamSubmissions.decide",
  "announcements.deliverUpdate",
  "calculations.recalculateSheet",
] as const;

const expectedAuthorizationPolicyVersions: Readonly<Record<string, string>> = {
  "schedules.deliverUserSchedule": "2",
  "teams.deliverList": "2",
};

describe("sheet Workflow Contract catalog", () => {
  it("is complete against the approved intent inventory", () => {
    expect(SheetWorkflowContractCatalog.map(({ identity }) => identity)).toEqual(
      approvedIntentInventory,
    );
    expect(new Set(SheetWorkflowContractCatalog.map(({ identity }) => identity)).size).toBe(
      approvedIntentInventory.length,
    );
  });

  it("publishes one explicit immutable versioned policy per intent", () => {
    const policyIdentities = SheetWorkflowContractCatalog.map(
      ({ authorizationPolicy }) => authorizationPolicy.policy,
    );

    for (const contract of SheetWorkflowContractCatalog) {
      expect(contract.wireVersion).toBe("1");
      expect(
        Schema.decodeUnknownSync(SheetWorkflowAuthorizationPolicyMetadata)(
          contract.authorizationPolicy,
        ),
      ).toEqual(contract.authorizationPolicy);
      expect(contract.authorizationPolicy.version).toBe(
        expectedAuthorizationPolicyVersions[contract.identity] ?? "1",
      );
      expect(contract.authorizationPolicy.policy).toBe(
        `sheet.workflow.${contract.identity}.invoke`,
      );
      expect(contract.authorizationPolicy.principalKinds.length).toBeGreaterThan(0);
      expect(contract.authorizationPolicy.revalidateBeforeEffects).toBe(true);
      expect(Object.isFrozen(contract)).toBe(true);
      expect(Object.isFrozen(contract.authorizationPolicy)).toBe(true);
      expect(Object.isFrozen(contract.authorizationPolicy.principalKinds)).toBe(true);
      expect(Object.isFrozen(contract.authorizationPolicy.requiredCapabilities)).toBe(true);
    }

    expect(new Set(policyIdentities).size).toBe(approvedIntentInventory.length);
  });

  it("reserves empty unruled workspace policies for capability discovery", () => {
    expect(
      SheetWorkflowContractCatalog.filter(
        ({ authorizationPolicy }) =>
          authorizationPolicy.resource === "workspace" &&
          authorizationPolicy.requiredCapabilities.length === 0 &&
          Predicate.isUndefined(authorizationPolicy.userRule),
      ).map(({ identity }) => identity),
    ).toEqual(["authorization.loadWorkspaceCapabilities"]);
  });

  it("publishes the same named target-user rule for team-list and user-schedule delivery", () => {
    for (const contract of [TeamsDeliverList, SchedulesDeliverUserSchedule]) {
      expect(contract.wireVersion).toBe("1");
      expect(contract.authorizationPolicy).toMatchObject({
        version: "2",
        principalKinds: ["user"],
        requiredCapabilities: [],
        resource: "workspace",
        resourceField: "workspaceId",
        targetUserField: "targetUserId",
        userRule: "target-user-or-workspace-monitor-or-application-owner",
        revalidateBeforeEffects: true,
      });
    }
  });

  it("exposes explicit grouped declarations without a generic name dispatcher", () => {
    expect(SheetWorkflowContracts.roomOrders.navigate.identity).toBe("roomOrders.navigate");
    expect(SheetWorkflowContracts.workspaces.featureFlags.setAndDeliver.identity).toBe(
      "workspaces.featureFlags.setAndDeliver",
    );
    expect(SheetWorkflowContracts.calculations.recalculateSheet.identity).toBe(
      "calculations.recalculateSheet",
    );
    expect(SheetWorkflowContracts).not.toHaveProperty("dispatch");
    expect(SheetWorkflowContracts).not.toHaveProperty("getByName");
  });

  it("groups exactly the contracts in the flat catalog", () => {
    const flattenIdentities = (node: object): ReadonlyArray<string> =>
      Object.values(node).flatMap((value) =>
        Predicate.hasProperty(value, "identity")
          ? [value.identity as string]
          : flattenIdentities(value as object),
      );

    expect([...flattenIdentities(SheetWorkflowContracts)].sort()).toEqual(
      SheetWorkflowContractCatalog.map(({ identity }) => identity).sort(),
    );
  });
});
