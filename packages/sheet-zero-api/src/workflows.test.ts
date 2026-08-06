import { Effect, Option, Stream } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { SheetWorkflowContractCatalog } from "sheet-workflow-contracts";
import { makeSheetWorkflowZeroClients, sheetWorkflowZeroProcedureManifest } from "./workflows";

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
});
