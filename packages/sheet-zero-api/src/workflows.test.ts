import { Effect, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { ZeroApiEndpoint } from "typhoon-zero/zeroApi";
import { InvocationId, workflowContractKey } from "effect-zero-workflow/contract";
import {
  AuthorizationLoadWorkspaceCapabilities,
  CheckinMessagesLoad,
  CheckinMessagesSave,
  SheetWorkflowContractCatalog,
} from "sheet-workflow-contracts";
import { workflowContractZeroGroupIdentifier } from "effect-zero-workflow/contract/transport";
import { zql } from "./schema";
import { serverMutators, serverQueries } from "./serverRegistries";
import { queries } from "./queries";
import {
  makeSheetWorkflowZeroObservationGroups,
  makeSheetWorkflowZeroClients,
  sheetWorkflowZeroObservationProcedureManifest,
  sheetWorkflowZeroProcedureManifest,
} from "./workflows";

describe("sheet Workflow Contract Zero clients", () => {
  it("publishes three explicit procedures per contract", () => {
    expect(sheetWorkflowZeroProcedureManifest).toHaveLength(
      SheetWorkflowContractCatalog.length * 3,
    );
    expect(new Set(sheetWorkflowZeroProcedureManifest).size).toBe(
      sheetWorkflowZeroProcedureManifest.length,
    );
  });

  it("preserves the typed contract tree without a generic dispatcher", () => {
    const clients = makeSheetWorkflowZeroClients({
      enqueue: () => Effect.void,
      get: () => Stream.succeed(Option.none()),
      list: () => Stream.succeed([]),
    });

    expect(clients.roomOrders.navigate).toHaveProperty("enqueue");
    expect(clients.workspaces.featureFlags.setAndDeliver).toHaveProperty("get");
    expect(clients).not.toHaveProperty("dispatch");
    expect(clients).not.toHaveProperty("getByName");
  });

  it("mounts the supported bot observations as read-only client/server pairs", () => {
    const groups = [
      workflowContractZeroGroupIdentifier(CheckinMessagesLoad),
      workflowContractZeroGroupIdentifier(CheckinMessagesSave),
      workflowContractZeroGroupIdentifier(AuthorizationLoadWorkspaceCapabilities),
    ];
    const clientQueries = queries as unknown as Record<string, Record<string, unknown>>;
    const mountedServerQueries = serverQueries as unknown as Record<
      string,
      Record<string, unknown>
    >;
    const mountedServerMutators = serverMutators as unknown as Record<string, unknown>;

    expect(sheetWorkflowZeroObservationProcedureManifest).toEqual(
      groups.flatMap((group) => [`${group}.get`, `${group}.list`]),
    );
    for (const group of groups) {
      expect(Object.keys(clientQueries[group]!).filter((name) => name !== "~")).toEqual([
        "get",
        "list",
      ]);
      expect(Object.keys(mountedServerQueries[group]!).filter((name) => name !== "~")).toEqual([
        "get",
        "list",
      ]);
      expect(mountedServerMutators[group]).toBeUndefined();
    }
  });

  it("builds the mounted query from the contract and authenticated owner", () => {
    const calls: Array<readonly unknown[]> = [];
    const query = {
      where: (field: string, operator: string, value: unknown) => {
        calls.push(["where", field, operator, value]);
        return query;
      },
      one: () => {
        calls.push(["one"]);
        return query;
      },
    } as unknown as typeof zql.workflowRun;
    const group = makeSheetWorkflowZeroObservationGroups(query).find(
      (candidate) =>
        candidate.identifier === workflowContractZeroGroupIdentifier(CheckinMessagesLoad),
    );
    const get = group?.endpoints.get;
    if (get === undefined || !ZeroApiEndpoint.isKind("query")(get)) {
      throw new Error("Saved-message load observation query is not mounted");
    }
    const invocationId = Schema.decodeUnknownSync(InvocationId)(
      "123e4567-e89b-42d3-a456-426614174000",
    );

    get.query({
      args: {
        invocationId,
        contractIdentity: CheckinMessagesLoad.identity,
        wireVersion: CheckinMessagesLoad.wireVersion,
      },
      ctx: { ownerKey: "user:auth-user-1" },
    });

    expect(calls).toEqual([
      ["where", "runId", "=", invocationId],
      ["where", "workflowName", "=", workflowContractKey(CheckinMessagesLoad)],
      ["where", "visibilityKey", "=", "user:auth-user-1"],
      ["one"],
    ]);
  });
});
