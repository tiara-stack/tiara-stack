import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { serviceStatusTargets, ServiceStatusService } from "./serviceStatus";

const runStatusCheck = (handler: HttpClient.HttpClient["execute"]) =>
  Effect.gen(function* () {
    const service = yield* ServiceStatusService;
    return yield* service.getServicesStatus();
  }).pipe(
    Effect.provide(ServiceStatusService.layer),
    Effect.provideService(HttpClient.HttpClient, HttpClient.make(handler)),
  );

const response = (request: Parameters<HttpClient.HttpClient["execute"]>[0], status: number) =>
  HttpClientResponse.fromWeb(request, new Response(null, { status }));

const runWithSheetWebResponse = (
  sheetWebResponse: Effect.Effect<HttpClientResponse.HttpClientResponse, any>,
) =>
  runStatusCheck((request) =>
    request.url.includes("sheet-web-service")
      ? sheetWebResponse
      : Effect.succeed(response(request, 200)),
  );

describe("ServiceStatusService", () => {
  it.effect("reports ok when every service returns 2xx", () =>
    Effect.gen(function* () {
      const result = yield* runStatusCheck((request) => Effect.succeed(response(request, 200)));

      expect(result.overallStatus).toBe("ok");
      expect(result.services).toHaveLength(serviceStatusTargets.length);
      expect(result.services.every((service) => service.status === "ok")).toBe(true);
      expect(result.services.every((service) => service.httpStatus === 200)).toBe(true);
    }),
  );

  it.effect("checks each Kubernetes service URL", () =>
    Effect.gen(function* () {
      const urls: Array<string> = [];
      yield* runStatusCheck((request) => {
        urls.push(request.url);
        return Effect.succeed(response(request, 200));
      });

      expect(urls).toHaveLength(serviceStatusTargets.length);
      expect(new Set(urls)).toEqual(new Set(serviceStatusTargets.map(({ url }) => url)));
    }),
  );

  it.effect("reports degraded when a service returns non-2xx", () =>
    Effect.gen(function* () {
      const result = yield* runStatusCheck((request) =>
        Effect.succeed(response(request, request.url.includes("sheet-bot-service") ? 503 : 200)),
      );

      expect(result.overallStatus).toBe("degraded");
      expect(result.services.find(({ name }) => name === "sheet-bot")).toMatchObject({
        status: "down",
        httpStatus: 503,
        error: "HTTP 503",
      });
    }),
  );

  it.effect("reports degraded when a service request fails", () =>
    Effect.gen(function* () {
      const result = yield* runWithSheetWebResponse(Effect.fail(new Error("connection refused")));

      expect(result.overallStatus).toBe("degraded");
      expect(result.services.find(({ name }) => name === "sheet-web")).toMatchObject({
        status: "down",
        httpStatus: null,
        latencyMs: null,
        error: "connection refused",
      });
    }),
  );

  it.live("reports degraded when a service request times out", () =>
    Effect.gen(function* () {
      const result = yield* runWithSheetWebResponse(Effect.never);

      expect(result.overallStatus).toBe("degraded");
      expect(result.services.find(({ name }) => name === "sheet-web")).toMatchObject({
        status: "down",
        httpStatus: null,
        error: "timeout",
        latencyMs: expect.any(Number),
      });
    }),
  );

  it.effect("formats non-error and circular request failures", () =>
    Effect.gen(function* () {
      const circular: Record<string, unknown> = { count: 1n };
      circular.self = circular;
      const failures = [undefined, circular] as const;

      for (const failure of failures) {
        const result = yield* runWithSheetWebResponse(Effect.fail(failure));
        expect(result.services.find(({ name }) => name === "sheet-web")?.error).toBe(
          failure === undefined ? "undefined" : '{"count":"1","self":"[Circular]"}',
        );
      }
    }),
  );
});
