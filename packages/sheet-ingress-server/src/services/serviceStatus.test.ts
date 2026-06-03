import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ServiceStatusService } from "./serviceStatus";

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

describe("ServiceStatusService", () => {
  const expectedServiceUrls = [
    "http://sheet-apis-service/ready",
    "http://sheet-auth-service/ready",
    "http://sheet-bot-service/ready",
    "http://sheet-workflows-service/ready",
    "http://sheet-db-server-service/ready",
    "http://sheet-ingress-server-service/ready",
    "http://sheet-web-service/ready",
  ];

  it("reports ok when every service returns 2xx", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* runStatusCheck((request) => Effect.succeed(response(request, 200)));

        expect(result.overallStatus).toBe("ok");
        expect(result.services).toHaveLength(7);
        expect(result.services.every((service) => service.status === "ok")).toBe(true);
        expect(result.services.every((service) => service.httpStatus === 200)).toBe(true);
      }),
    );
  });

  it("checks Kubernetes service ports instead of container ports", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const urls: Array<string> = [];
        yield* runStatusCheck((request) => {
          urls.push(request.url);
          return Effect.succeed(response(request, 200));
        });

        expect(urls).toHaveLength(expectedServiceUrls.length);
        expect(new Set(urls)).toEqual(new Set(expectedServiceUrls));
      }),
    );
  });

  it("reports degraded when a service returns non-2xx", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* runStatusCheck((request) =>
          Effect.succeed(response(request, request.url.includes("sheet-bot-service") ? 503 : 200)),
        );

        const sheetBot = result.services.find((service) => service.name === "sheet-bot");
        expect(result.overallStatus).toBe("degraded");
        expect(sheetBot).toMatchObject({
          status: "down",
          httpStatus: 503,
          error: "HTTP 503",
        });
      }),
    );
  });

  it("reports degraded when a service request fails", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* runStatusCheck((request) =>
          request.url.includes("sheet-web-service")
            ? Effect.fail(new Error("connection refused") as never)
            : Effect.succeed(response(request, 200)),
        );

        const sheetWeb = result.services.find((service) => service.name === "sheet-web");
        expect(result.overallStatus).toBe("degraded");
        expect(sheetWeb).toMatchObject({
          status: "down",
          httpStatus: null,
          latencyMs: null,
          error: "connection refused",
        });
      }),
    );
  });

  it("reports degraded when a service request times out", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* runStatusCheck((request) =>
          request.url.includes("sheet-web-service")
            ? Effect.never
            : Effect.succeed(response(request, 200)),
        );

        const sheetWeb = result.services.find((service) => service.name === "sheet-web");
        expect(result.overallStatus).toBe("degraded");
        expect(sheetWeb).toMatchObject({
          status: "down",
          httpStatus: null,
          error: "timeout",
        });
        expect(sheetWeb?.latencyMs).toEqual(expect.any(Number));
      }),
    );
  });

  it("reports degraded with a string error when a service request fails without a cause", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* runStatusCheck((request) =>
          request.url.includes("sheet-web-service")
            ? Effect.fail(undefined as never)
            : Effect.succeed(response(request, 200)),
        );

        const sheetWeb = result.services.find((service) => service.name === "sheet-web");
        expect(result.overallStatus).toBe("degraded");
        expect(sheetWeb).toMatchObject({
          status: "down",
          httpStatus: null,
          latencyMs: null,
          error: "undefined",
        });
      }),
    );
  });

  it("reports degraded when a service request fails with a circular BigInt cause", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const cause: Record<string, unknown> = { count: 1n };
        cause.self = cause;

        const result = yield* runStatusCheck((request) =>
          request.url.includes("sheet-web-service")
            ? Effect.fail(cause as never)
            : Effect.succeed(response(request, 200)),
        );

        const sheetWeb = result.services.find((service) => service.name === "sheet-web");
        expect(result.overallStatus).toBe("degraded");
        expect(sheetWeb).toMatchObject({
          status: "down",
          httpStatus: null,
          latencyMs: null,
          error: '{"count":"1","self":"[Circular]"}',
        });
      }),
    );
  });
});
