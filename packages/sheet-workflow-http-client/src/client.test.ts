import { Cause, Effect, Exit, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { InvocationId } from "effect-zero-workflow/contract";
import {
  RolloutGateEvaluationRequest,
  SheetWorkflowContractCatalog,
  SheetWorkflowContracts,
} from "sheet-workflow-contracts";
import { makeSheetWorkflowEnqueueClients } from "./apps-script";
import {
  RolloutGateBaseUrlInvalid,
  makeRolloutGateHttpClient,
  makeWorkflowInvocationId,
} from "./index";
import { sheetWorkflowHttpRouteManifest } from "./routes";

const unusedHttpClient = HttpClient.make(() => Effect.die("HTTP is not used by this test"));

const makeRecordingHttpClient = (body: unknown, status: number) => {
  const requests: Array<string> = [];
  const httpClient = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.url);
      const responseBody = body === undefined ? undefined : JSON.stringify(body);
      return HttpClientResponse.fromWeb(request, new Response(responseBody, { status }));
    }),
  );

  return { httpClient, requests };
};

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
      const { httpClient, requests } = makeRecordingHttpClient(undefined, 204);
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

  it.effect("preserves a configured path prefix for Rollout Gate evaluation", () =>
    Effect.gen(function* () {
      const { httpClient, requests } = makeRecordingHttpClient(
        {
          gateKey: "gate-key",
          revision: 0,
          matched: false,
          executionPath: "legacy",
          reason: "unconfigured",
        },
        200,
      );
      const client = makeRolloutGateHttpClient(httpClient, {
        baseUrl: "https://example.test/api",
      });
      const input = Schema.decodeUnknownSync(RolloutGateEvaluationRequest)({
        contractIdentity: "services.deliverStatus",
        contractWireVersion: "1",
        client: { platform: "discord", clientId: "discord-main" },
        invocationId: "123e4567-e89b-42d3-a456-426614174000",
      });

      yield* client.evaluate(input);

      expect(requests).toEqual(["https://example.test/api/internal/rollout-gates/evaluate"]);
    }),
  );

  it.effect("reports invalid Rollout Gate base URLs as effect failures", () =>
    Effect.gen(function* () {
      const client = makeRolloutGateHttpClient(unusedHttpClient, {
        baseUrl: "not a URL",
      });
      const input = Schema.decodeUnknownSync(RolloutGateEvaluationRequest)({
        contractIdentity: "services.deliverStatus",
        contractWireVersion: "1",
        client: { platform: "discord", clientId: "discord-main" },
        invocationId: "123e4567-e89b-42d3-a456-426614174000",
      });

      const exit = yield* Effect.exit(client.evaluate(input));

      if (Exit.isSuccess(exit)) {
        throw new Error("Expected Rollout Gate evaluation to fail for an invalid base URL");
      }
      const failure = exit.cause.reasons.find(Cause.isFailReason);
      expect(failure?.error).toBeInstanceOf(RolloutGateBaseUrlInvalid);
    }),
  );

  it.effect("reports invocation ID generator errors as effect failures", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        makeWorkflowInvocationId(() => {
          throw new Error("generator failed");
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find(Cause.isFailReason);
        expect(failure?.error).toBeInstanceOf(Error);
      }
    }),
  );

  it.effect("reports invalid invocation ID values as effect failures", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(makeWorkflowInvocationId(() => "not-a-uuid"));

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
