import { Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { InvocationId } from "effect-zero-workflow/contract";
import { SheetWorkflowContractCatalog, SheetWorkflowContracts } from "sheet-workflow-contracts";
import { makeSheetWorkflowEnqueueClients } from "./apps-script";
import { sheetWorkflowHttpRouteManifest } from "./routes";

const unusedHttpClient = HttpClient.make(() => Effect.die("HTTP is not used by this test"));

describe("sheet Workflow Contract HTTP clients", () => {
  it("publishes three explicit literal routes per contract", () => {
    expect(sheetWorkflowHttpRouteManifest).toHaveLength(SheetWorkflowContractCatalog.length * 3);
    expect(new Set(sheetWorkflowHttpRouteManifest.map(({ path }) => path)).size).toBe(
      sheetWorkflowHttpRouteManifest.length,
    );
    expect(sheetWorkflowHttpRouteManifest.some(({ path }) => path.includes(":workflow"))).toBe(
      false,
    );
  });

  it("keeps the Apps Script surface enqueue-only", () => {
    const clients = makeSheetWorkflowEnqueueClients(unusedHttpClient, {
      baseUrl: "https://example.test",
    });

    expect(Object.keys(clients.calculations.recalculateSheet)).toEqual(["enqueue"]);
    expect(clients.calculations.recalculateSheet).not.toHaveProperty("get");
    expect(clients.calculations.recalculateSheet).not.toHaveProperty("list");
  });

  it.effect("submits an Apps Script command with a caller-generated invocation ID", () =>
    Effect.gen(function* () {
      const requests: Array<string> = [];
      const httpClient = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          return HttpClientResponse.fromWeb(request, new Response(undefined, { status: 204 }));
        }),
      );
      const clients = makeSheetWorkflowEnqueueClients(httpClient, {
        baseUrl: "https://example.test/",
      });
      const invocationId = Schema.decodeUnknownSync(InvocationId)(
        "123e4567-e89b-42d3-a456-426614174000",
      );
      const input = Schema.decodeUnknownSync(
        SheetWorkflowContracts.calculations.recalculateSheet.input,
      )({
        spreadsheetId: "spreadsheet-a",
        sheetRef: "Sheet1",
        hour: 12,
        config: { cc: false, considerEnc: true, healNeeded: 1 },
        players: [
          { name: "one", encable: true },
          { name: "two", encable: true },
          { name: "three", encable: true },
          { name: "four", encable: true },
          { name: "five", encable: true },
        ],
        fixedTeams: [],
      });

      const reference = yield* clients.calculations.recalculateSheet.enqueue(input, {
        invocationId,
      });

      expect(reference.invocationId).toBe(invocationId);
      expect(requests).toEqual([
        "https://example.test/workflows/calculations.recalculateSheet/v/1/enqueue",
      ]);
    }),
  );
});
