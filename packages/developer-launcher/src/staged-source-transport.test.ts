import { it } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { expect } from "vitest";
import {
  StagedRunnerSnapshotTransport,
  StagedRunnerSnapshotTransportLive,
} from "./staged-source-transport";

const target = {
  endpoint: "http://127.0.0.1:4317",
  identity: {
    sessionId: "session-1",
    generation: 1,
    role: "ordinary-runner" as const,
  },
  authorizationToken: Redacted.make("test-session-token"),
};

const emptySnapshot = {
  revision: "r1",
  files: [],
  completion: { expectedFileCount: 0, filesDigest: "a".repeat(64) },
};

it.effect("bounds response-body decoding and maps the timeout to runner-request-failed", () =>
  Effect.gen(function* () {
    const httpClient = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream<Uint8Array>({
              pull: () => new Promise<void>(() => undefined),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );
    const transportLayer = StagedRunnerSnapshotTransportLive({
      allowInsecureLoopbackForTests: true,
      httpClientLayer: Layer.succeed(HttpClient.HttpClient, httpClient),
      requestTimeout: Duration.millis(5),
    });
    const transport = yield* StagedRunnerSnapshotTransport.pipe(Effect.provide(transportLayer));
    const result = yield* Effect.result(
      transport.activate({ target, snapshot: emptySnapshot }),
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.millis(5));
    const timedOut = yield* Fiber.join(result);
    expect(timedOut._tag).toBe("Failure");
    if (timedOut._tag === "Failure") expect(timedOut.failure.reason).toBe("runner-request-failed");
  }),
);

it.effect("keeps the default request alive through the full server activation budget", () =>
  Effect.gen(function* () {
    const requestStarted = yield* Deferred.make<void>();
    let requestCompleted = false;
    const httpClient = HttpClient.make((request) =>
      Deferred.succeed(requestStarted, void 0).pipe(
        Effect.andThen(Effect.sleep(Duration.seconds(241))),
        Effect.andThen(
          Effect.sync(() => {
            requestCompleted = true;
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  requestedRevision: "r1",
                  activeRevision: "r1",
                  unavailableRoles: [],
                  failure: null,
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            );
          }),
        ),
      ),
    );
    const transport = yield* StagedRunnerSnapshotTransport.pipe(
      Effect.provide(
        StagedRunnerSnapshotTransportLive({
          allowInsecureLoopbackForTests: true,
          httpClientLayer: Layer.succeed(HttpClient.HttpClient, httpClient),
        }),
      ),
    );
    const request = yield* transport
      .activate({ target, snapshot: emptySnapshot })
      .pipe(Effect.forkChild);

    yield* Deferred.await(requestStarted);
    yield* TestClock.adjust(Duration.seconds(240));
    expect(requestCompleted).toBe(false);
    yield* TestClock.adjust(Duration.seconds(1));
    const result = yield* Fiber.join(request);

    expect(requestCompleted).toBe(true);
    expect(result.failure).toBeNull();
  }),
);

it.effect("preserves runner status and response-decode transport errors", () =>
  Effect.gen(function* () {
    const deniedHttpClient = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("denied", { status: 403 }))),
    );
    const deniedTransport = yield* StagedRunnerSnapshotTransport.pipe(
      Effect.provide(
        StagedRunnerSnapshotTransportLive({
          allowInsecureLoopbackForTests: true,
          httpClientLayer: Layer.succeed(HttpClient.HttpClient, deniedHttpClient),
        }),
      ),
    );
    const denied = yield* Effect.result(
      deniedTransport.activate({ target, snapshot: emptySnapshot }),
    );
    expect(denied._tag).toBe("Failure");
    if (denied._tag === "Failure") expect(denied.failure.reason).toBe("runner-request-denied");

    const malformedHttpClient = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("not-json", { status: 200 })),
      ),
    );
    const malformedTransport = yield* StagedRunnerSnapshotTransport.pipe(
      Effect.provide(
        StagedRunnerSnapshotTransportLive({
          allowInsecureLoopbackForTests: true,
          httpClientLayer: Layer.succeed(HttpClient.HttpClient, malformedHttpClient),
        }),
      ),
    );
    const malformed = yield* Effect.result(
      malformedTransport.activate({ target, snapshot: emptySnapshot }),
    );
    expect(malformed._tag).toBe("Failure");
    if (malformed._tag === "Failure")
      expect(malformed.failure.reason).toBe("invalid-runner-response");
  }),
);

it.effect("allows IPv6 loopback HTTP only when explicitly enabled for tests", () =>
  Effect.gen(function* () {
    let requests = 0;
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        requests += 1;
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              requestedRevision: "r1",
              activeRevision: "r1",
              unavailableRoles: [],
              failure: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }),
    );
    const ipv6Target = { ...target, endpoint: "http://[::1]:4317" };
    const testTransport = yield* StagedRunnerSnapshotTransport.pipe(
      Effect.provide(
        StagedRunnerSnapshotTransportLive({
          allowInsecureLoopbackForTests: true,
          httpClientLayer: Layer.succeed(HttpClient.HttpClient, httpClient),
        }),
      ),
    );
    const allowed = yield* testTransport.activate({ target: ipv6Target, snapshot: emptySnapshot });

    const productionTransport = yield* StagedRunnerSnapshotTransport.pipe(
      Effect.provide(
        StagedRunnerSnapshotTransportLive({
          httpClientLayer: Layer.succeed(HttpClient.HttpClient, httpClient),
        }),
      ),
    );
    const rejected = yield* Effect.result(
      productionTransport.activate({ target: ipv6Target, snapshot: emptySnapshot }),
    );

    expect(allowed.failure).toBeNull();
    expect(rejected._tag).toBe("Failure");
    if (rejected._tag === "Failure")
      expect(rejected.failure.reason).toBe("runner-endpoint-requires-tls");
    expect(requests).toBe(1);
  }),
);
