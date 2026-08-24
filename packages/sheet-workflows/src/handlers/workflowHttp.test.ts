import { ConfigProvider, Effect, Layer } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { WorkflowStore } from "effect-zero-workflow";
import {
  makeWorkflowHttpRouteCatalog,
  workflowHttpServerExecutorFromHandler,
} from "effect-zero-workflow/contract/http/server";
import { vi } from "vitest";
import { sheetWorkflowHttpEnqueueContracts, workflowHttpRoutesLayer } from "./workflowHttp";
import { ReadOnlyWorkflowAuthorization } from "@/workflows/readOnly/authorization";

describe("sheet workflow HTTP enqueue boundary", () => {
  it("exposes every migrated workflow contract", () => {
    expect(sheetWorkflowHttpEnqueueContracts.map(({ identity }) => identity)).toEqual([
      "services.deliverStatus",
      "schedules.deliverUserSchedule",
      "calculations.recalculateSheet",
      "workspaces.deliverWelcome",
      "teamSubmissions.process",
      "teamSubmissions.decide",
      "announcements.deliverUpdate",
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
      "conversations.deliverConfig",
      "conversations.updateConfigAndDeliver",
      "conversations.setLockdown",
      "teams.deliverList",
      "screenshots.captureAndDeliver",
    ]);
  });

  it.effect("registers every generated enqueue route exactly once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const routes = makeWorkflowHttpRouteCatalog(
          sheetWorkflowHttpEnqueueContracts,
          workflowHttpServerExecutorFromHandler({
            enqueue: () => Effect.die("HTTP route test does not enqueue workflows"),
            get: () => Effect.die("HTTP route test does not observe workflows"),
            list: () => Effect.die("HTTP route test does not observe workflows"),
          }),
        );
        const enqueuePaths = routes.map(({ routes: contractRoutes }) => contractRoutes.enqueue);
        expect(new Set(enqueuePaths).size).toBe(enqueuePaths.length);
        const authorizationLayer = Layer.mock(ReadOnlyWorkflowAuthorization)({});

        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
          new Response(JSON.stringify({ issuer: "https://issuer.example.com" }), {
            headers: { "content-type": "application/json" },
          }),
        );

        try {
          const handler = yield* HttpRouter.toHttpEffect(
            workflowHttpRoutesLayer.pipe(
              Layer.provide(Layer.mock(WorkflowStore)({})),
              Layer.provide(
                ConfigProvider.layer(
                  ConfigProvider.fromUnknown({ SHEET_AUTH_ISSUER: "https://issuer.example.com" }),
                ),
              ),
              Layer.provide(HttpRouter.layer),
            ),
          );
          const responses = yield* Effect.forEach(enqueuePaths, (path) =>
            handler.pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(
                  new Request(`http://localhost${path}`, { method: "POST" }),
                ),
              ),
              Effect.provide(authorizationLayer),
            ),
          );

          expect(responses.map(({ status }) => status)).toEqual(enqueuePaths.map(() => 401));
        } finally {
          fetchMock.mockRestore();
        }
      }),
    ),
  );
});
