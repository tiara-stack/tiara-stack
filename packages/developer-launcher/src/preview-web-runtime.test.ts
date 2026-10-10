import { expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, Fiber, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import type { ProcessStarter } from "./types";
import { startLongLivedProcess } from "./executor";
import {
  makePreviewWebProcessRequest,
  makePreviewWebRuntime,
  PreviewWebRuntimeError,
  terminateRecordedProcessGroup,
} from "./preview-web-runtime";

const previewOrigin = "https://p-session-sheet-web.dev.theerapakg.moe";
const environmentFor = (origin: string) => ({
  AUTH_BASE_URL: `${origin}/_preview/dependencies/auth/`,
  SHEET_ZERO_BASE_URL: `${origin}/_preview/dependencies/application-zero/`,
  SHEET_WORKFLOWS_BASE_URL: `${origin}/_preview/dependencies/workflow-execution/`,
});
const environment = environmentFor(previewOrigin);

it.live("retains the remote supervisor record when status is unavailable during cleanup", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      mkdtemp(path.join(os.tmpdir(), "tiara-preview-remote-stop-")),
    );
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const server = createServer((request, response) => {
      response.writeHead(request.url === "/stop" ? 202 : 503).end();
    });
    const endpoint = yield* Effect.tryPromise({
      try: () =>
        new Promise<string>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            const address = server.address();
            if (address === null || typeof address === "string")
              reject(new Error("test-supervisor-address-unavailable"));
            else resolve(`http://127.0.0.1:${address.port}`);
          });
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error("test-server-start-failed")),
    });
    const recordPath = path.join(directory, `${sessionId}.json`);
    const runtime = makePreviewWebRuntime({ registryDirectory: directory });
    yield* Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeFile(
          recordPath,
          JSON.stringify({
            sessionId,
            endpoint,
            controlToken: "c".repeat(43),
          }),
          { mode: 0o600 },
        ),
      );

      const stopped = yield* Effect.exit(runtime.stop(sessionId));
      expect(stopped._tag).toBe("Failure");
      const retained = yield* Effect.promise(() => readFile(recordPath, "utf8"));
      expect(JSON.parse(retained)).toMatchObject({ sessionId, endpoint });
    }).pipe(
      Effect.ensuring(
        Effect.tryPromise({
          try: () => new Promise<void>((resolve) => server.close(() => resolve())),
          catch: () => undefined,
        }).pipe(Effect.ignore),
      ),
      Effect.ensuring(
        Effect.tryPromise({
          try: () => rm(directory, { recursive: true, force: true }),
          catch: () => undefined,
        }).pipe(Effect.ignore),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it("constructs a web watch command with only positive session configuration", () => {
  const request = makePreviewWebProcessRequest({
    checkout: "/work/preview",
    port: 4317,
    publicOrigin: previewOrigin,
    revision: "source-a",
    environment,
  });
  expect(request?.args).toContain("--strictPort");
  const hostIndex = request?.args.indexOf("--host") ?? -1;
  expect(request?.args[hostIndex + 1]).toBe("127.0.0.1");
  expect(request?.env).toEqual({
    ...environment,
    NODE_ENV: "development",
    APP_BASE_URL: previewOrigin,
    DEV_SHEET_WEB_PORT: "4317",
    TIARA_PREVIEW_HMR_PATH: "/_preview/app/__vite_hmr",
    TIARA_PREVIEW_SOURCE_REVISION: "source-a",
  });
  expect(
    makePreviewWebProcessRequest({
      checkout: "/work/preview",
      port: 4317,
      publicOrigin: "https://app.production.example.com",
      revision: "source-a",
      environment,
    }),
  ).toBeUndefined();
  expect(
    makePreviewWebProcessRequest({
      checkout: "/work/preview",
      port: 4317,
      publicOrigin: previewOrigin,
      revision: "source-a",
      environment: { ...environment, DATABASE_URL: "postgres://invalid" },
    }),
  ).toBeUndefined();
  const customGatewayOrigin = "https://p-session-sheet-web.dev.example.test";
  expect(
    makePreviewWebProcessRequest({
      checkout: "/work/preview",
      port: 4317,
      publicOrigin: customGatewayOrigin,
      revision: "source-a",
      environment: {
        AUTH_BASE_URL: `${customGatewayOrigin}/_preview/dependencies/auth/`,
      },
    }),
  ).toBeDefined();
  expect(
    makePreviewWebProcessRequest({
      checkout: "/work/preview",
      port: 4317,
      publicOrigin: customGatewayOrigin,
      revision: "source-a",
      environment: { AUTH_BASE_URL: "https://auth.dev.example.test" },
    }),
  ).toBeUndefined();
});

it.effect("does not SIGKILL a process group after its recorded leader identity changes", () =>
  Effect.gen(function* () {
    let identityReads = 0;
    const signals: string[] = [];
    const record = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      endpoint: "http://127.0.0.1:4317",
      controlToken: "c".repeat(43),
      processId: 4317,
      processGroupId: 4317,
      processStartedAt: 100,
    };
    const exit = yield* Effect.exit(
      terminateRecordedProcessGroup(record, {
        exists: () => Effect.succeed(true),
        leaderStartedAt: () => Effect.sync(() => (++identityReads === 1 ? 100 : 200)),
        signal: (_processGroupId, signal) => Effect.sync(() => void signals.push(signal)),
        waitForExit: () => Effect.succeed(false),
      }),
    );
    expect(exit._tag).toBe("Failure");
    expect(signals).toEqual(["SIGTERM"]);
  }),
);

it.live("keeps process tracking active across edits and clears an exited child", () =>
  Effect.gen(function* () {
    const revisions: string[] = [];
    let revisionUrl = "";
    let revisionToken = "";
    let starterCount = 0;
    let resolveFirstChildExit: () => void = () => undefined;
    let processTreeSamples = 0;
    const starter: ProcessStarter = async (request) => {
      starterCount += 1;
      const isFirstChild = starterCount === 1;
      revisionUrl = request.env.TIARA_PREVIEW_REVISION_URL ?? "";
      revisionToken = request.env.TIARA_PREVIEW_REVISION_TOKEN ?? "";
      return {
        pid: isFirstChild ? 8123 : 8125,
        exited: isFirstChild
          ? new Promise((resolve) => {
              resolveFirstChildExit = () => resolve({ exitCode: 0 });
            })
          : new Promise(() => undefined),
        kill: async () => undefined,
      };
    };
    const runtime = makePreviewWebRuntime({
      starter,
      portChecker: async () => ({ available: true, status: "available" }),
      readinessChecker: async () => ({ reachable: true, status: 200 }),
      processTreeSampler: (processGroupId) =>
        Effect.sync(() => {
          processTreeSamples += 1;
          return {
            processIds: [processGroupId, processGroupId + 1],
            cpuTimeMs: processTreeSamples * 20,
            memoryRssBytes: 4096,
            sampledAt: 10_000 + processTreeSamples,
          };
        }),
      processTreeSamplingIntervalMs: 5,
      now: () => 10_000,
    });
    const process = yield* runtime.start({
      sessionId: "session-a",
      revision: "source-a",
      checkout: "/work/a",
      port: 4317,
      publicOrigin: "https://p-session-a-sheet-web.dev.theerapakg.moe",
      environment: environmentFor("https://p-session-a-sheet-web.dev.theerapakg.moe"),
      onSourceRevision: (revision) => Effect.sync(() => revisions.push(revision)),
    });
    expect(process.pid).toBe(8123);
    expect(process.revision).toBe("source-a");
    const notification = yield* Effect.tryPromise({
      try: () =>
        fetch(revisionUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${revisionToken}` },
          body: JSON.stringify({ revision: "a".repeat(64) }),
        }),
      catch: (cause) => cause,
    });
    expect(notification.status).toBe(204);
    expect(revisions).toEqual(["a".repeat(64)]);
    const measurements = yield* runtime.measurements("session-a");
    expect(measurements?.editCount).toBe(1);
    expect(measurements?.lastEditDurationMs).toBeGreaterThanOrEqual(0);
    expect(measurements?.processTree).toMatchObject({
      available: true,
      processIds: [8123, 8124],
      cpuTimeMs: expect.any(Number),
      memoryRssBytes: 4096,
      memoryHighWaterBytes: 4096,
    });
    const initialSampleCount = measurements?.processTree.sampleCount ?? 0;
    yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    const sampledAfterEdit = yield* runtime.measurements("session-a");
    expect(sampledAfterEdit?.processTree.sampleCount).toBeGreaterThan(initialSampleCount);
    expect(yield* runtime.status("session-a")).toBe(true);
    resolveFirstChildExit();
    yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    expect(yield* runtime.measurements("session-a")).toBeUndefined();
    expect(yield* runtime.status("session-a")).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it.live("reports unavailable when the live web readiness probe fails", () =>
  Effect.gen(function* () {
    let ready = true;
    const runtime = makePreviewWebRuntime({
      starter: async () => ({
        pid: 8126,
        exited: new Promise(() => undefined),
        kill: async () => undefined,
      }),
      portChecker: async () => ({ available: true, status: "available" }),
      readinessChecker: async () => ({ reachable: ready, status: ready ? 200 : 503 }),
    });
    yield* runtime.start({
      sessionId: "session-unready",
      revision: "source-a",
      checkout: "/work/a",
      port: 4318,
      publicOrigin: "https://p-session-unready-sheet-web.dev.theerapakg.moe",
      environment: environmentFor("https://p-session-unready-sheet-web.dev.theerapakg.moe"),
      onSourceRevision: () => Effect.void,
    });
    if (runtime.availability === undefined)
      return yield* Effect.fail(new Error("runtime availability API is unavailable"));
    expect(yield* runtime.availability("session-unready")).toBe("ready");
    ready = false;
    expect(yield* runtime.status("session-unready")).toBe(false);
    expect(yield* runtime.availability("session-unready")).toBe("transient-failure");
    yield* runtime.stop("session-unready");
  }).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it.live("kills a failed web startup and leaves no active process record", () =>
  Effect.gen(function* () {
    let killed = false;
    let now = 0;
    const runtime = makePreviewWebRuntime({
      starter: async () => ({
        pid: 8124,
        exited: new Promise(() => undefined),
        kill: async () => {
          killed = true;
        },
      }),
      portChecker: async () => ({ available: true, status: "available" }),
      readinessChecker: async () => {
        now += 10;
        return { reachable: false, status: 503 };
      },
      now: () => now,
      pollIntervalMs: 0,
      startupTimeoutMs: 30,
    });
    const exit = yield* Effect.exit(
      runtime.start({
        sessionId: "session-failed",
        revision: "source-a",
        checkout: "/work/a",
        port: 4317,
        publicOrigin: "https://p-session-failed-sheet-web.dev.theerapakg.moe",
        environment: environmentFor("https://p-session-failed-sheet-web.dev.theerapakg.moe"),
        onSourceRevision: () => Effect.void,
      }),
    );
    expect(exit._tag).toBe("Failure");
    expect(killed).toBe(true);
    expect(yield* runtime.status("session-failed")).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it.live("retains retryable cleanup evidence when startup identity and cleanup both fail", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      mkdtemp(path.join(os.tmpdir(), "tiara-preview-unconfirmed-start-")),
    );
    const sessionId = "55555555-5555-4555-8555-555555555555";
    let cleanupAttempts = 0;
    const runtime = makePreviewWebRuntime({
      starter: async () => ({
        pid: 8129,
        processGroupId: 8129,
        exited: new Promise(() => undefined),
        kill: async () => {
          cleanupAttempts += 1;
          if (cleanupAttempts < 3) throw new Error("cleanup not confirmed");
        },
      }),
      processIdentityReader: () =>
        Effect.fail(
          new PreviewWebRuntimeError({ reason: "supervisor-process-identity-unavailable" }),
        ),
      portChecker: async () => ({ available: true, status: "available" }),
      readinessChecker: async () => ({ reachable: true, status: 200 }),
      registryDirectory: directory,
    });
    const recordPath = path.join(directory, `${sessionId}.json`);

    yield* Effect.gen(function* () {
      const started = yield* Effect.exit(
        runtime.start({
          sessionId,
          revision: "source-a",
          checkout: "/work/a",
          port: 4319,
          publicOrigin: "https://p-session-unconfirmed-start-sheet-web.dev.theerapakg.moe",
          environment: environmentFor(
            "https://p-session-unconfirmed-start-sheet-web.dev.theerapakg.moe",
          ),
          onSourceRevision: () => Effect.void,
        }),
      );

      expect(started._tag).toBe("Failure");
      expect(cleanupAttempts).toBe(1);
      const retainedRecord = yield* Effect.promise(() => readFile(recordPath, "utf8"));
      expect(JSON.parse(retainedRecord)).toMatchObject({ sessionId });
      expect(JSON.parse(retainedRecord)).not.toHaveProperty("processId");
      expect(JSON.parse(retainedRecord)).not.toHaveProperty("processGroupId");

      const retry = yield* Effect.exit(runtime.stop(sessionId));
      expect(retry._tag).toBe("Failure");
      const recordAfterFailedRetry = yield* Effect.promise(() => readFile(recordPath, "utf8"));
      expect(JSON.parse(recordAfterFailedRetry)).toMatchObject({ sessionId });

      yield* runtime.stop(sessionId);

      expect(cleanupAttempts).toBe(3);
      const recordStillExists = yield* Effect.promise(() =>
        readFile(recordPath, "utf8").then(
          () => true,
          () => false,
        ),
      );
      expect(recordStillExists).toBe(false);
    }).pipe(
      Effect.ensuring(runtime.stop(sessionId).pipe(Effect.ignore)),
      Effect.ensuring(Effect.promise(() => rm(directory, { recursive: true, force: true }))),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it.live("records an unready process when cleanup fails and closes its revision listener", () =>
  Effect.gen(function* () {
    let now = 0;
    let cleanupAttempts = 0;
    const directory = yield* Effect.promise(() =>
      mkdtemp(path.join(os.tmpdir(), "tiara-preview-unready-cleanup-")),
    );
    const sessionId = "66666666-6666-4666-8666-666666666666";
    let revisionUrl = "";
    const runtime = makePreviewWebRuntime({
      starter: async (request) => {
        revisionUrl = request.env.TIARA_PREVIEW_REVISION_URL ?? "";
        return {
          pid: 8127,
          processGroupId: 8127,
          exited: new Promise(() => undefined),
          kill: async () => {
            cleanupAttempts += 1;
            if (cleanupAttempts === 1) throw new Error("process cleanup failed");
          },
        };
      },
      portChecker: async () => ({ available: true, status: "available" }),
      readinessChecker: async () => {
        now += 10;
        return { reachable: false, status: 503 };
      },
      now: () => now,
      pollIntervalMs: 0,
      startupTimeoutMs: 30,
      registryDirectory: directory,
    });
    const started = yield* Effect.exit(
      runtime.start({
        sessionId,
        revision: "source-a",
        checkout: "/work/a",
        port: 4317,
        publicOrigin: "https://p-session-listener-cleanup-sheet-web.dev.theerapakg.moe",
        environment: environmentFor(
          "https://p-session-listener-cleanup-sheet-web.dev.theerapakg.moe",
        ),
        onSourceRevision: () => Effect.void,
      }),
    );
    const listenerProbe = yield* Effect.exit(
      Effect.tryPromise({
        try: () => fetch(revisionUrl),
        catch: (cause) => cause,
      }),
    );

    expect(started._tag).toBe("Failure");
    expect(cleanupAttempts).toBe(1);
    expect(listenerProbe._tag).toBe("Failure");
    const recordPath = path.join(directory, `${sessionId}.json`);
    const retainedRecord = yield* Effect.promise(() => readFile(recordPath, "utf8"));
    expect(JSON.parse(retainedRecord)).toMatchObject({ sessionId });

    yield* runtime.stop(sessionId);

    expect(cleanupAttempts).toBe(2);
    const recordStillExists = yield* Effect.promise(() =>
      readFile(recordPath, "utf8").then(
        () => true,
        () => false,
      ),
    );
    expect(recordStillExists).toBe(false);
    yield* Effect.promise(() => rm(directory, { recursive: true, force: true }));
  }).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it.live("retries failed startup cleanup when the durable process record cannot be written", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      mkdtemp(path.join(os.tmpdir(), "tiara-preview-record-write-failure-")),
    );
    const registryPath = path.join(directory, "blocked-registry");
    const sessionId = "77777777-7777-4777-8777-777777777777";
    yield* Effect.promise(() => writeFile(registryPath, "not a directory"));
    let cleanupAttempts = 0;
    const runtime = makePreviewWebRuntime({
      starter: async () => ({
        pid: undefined,
        exited: new Promise(() => undefined),
        kill: async () => {
          cleanupAttempts += 1;
          if (cleanupAttempts === 1) throw new Error("cleanup not confirmed");
        },
      }),
      portChecker: async () => ({ available: true, status: "available" }),
      readinessChecker: async () => ({ reachable: true, status: 200 }),
      registryDirectory: registryPath,
    });

    yield* Effect.gen(function* () {
      const started = yield* Effect.exit(
        runtime.start({
          sessionId,
          revision: "source-a",
          checkout: "/work/a",
          port: 4320,
          publicOrigin: "https://p-session-record-write-sheet-web.dev.theerapakg.moe",
          environment: environmentFor(
            "https://p-session-record-write-sheet-web.dev.theerapakg.moe",
          ),
          onSourceRevision: () => Effect.void,
        }),
      );
      expect(started._tag).toBe("Failure");
      expect(cleanupAttempts).toBe(1);

      yield* Effect.promise(() => rm(registryPath, { force: true }));
      yield* runtime.stop(sessionId);

      expect(cleanupAttempts).toBe(2);
      expect(yield* runtime.status(sessionId)).toBe(false);
    }).pipe(
      Effect.ensuring(
        Effect.promise(() => rm(registryPath, { force: true })).pipe(
          Effect.andThen(runtime.stop(sessionId).pipe(Effect.ignore)),
        ),
      ),
      Effect.ensuring(Effect.promise(() => rm(directory, { recursive: true, force: true }))),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it.live("cleans up a startup child interrupted during process identity capture", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      mkdtemp(path.join(os.tmpdir(), "tiara-preview-identity-interruption-")),
    );
    const sessionId = "88888888-8888-4888-8888-888888888888";
    let notifyIdentityReadStarted: () => void = () => undefined;
    const identityReadStarted = new Promise<void>((resolve) => {
      notifyIdentityReadStarted = resolve;
    });
    let cleanupAttempts = 0;
    const runtime = makePreviewWebRuntime({
      starter: async () => ({
        pid: 8128,
        processGroupId: 8128,
        exited: new Promise(() => undefined),
        kill: async () => {
          cleanupAttempts += 1;
        },
      }),
      processIdentityReader: () =>
        Effect.tryPromise({
          try: () => {
            notifyIdentityReadStarted();
            return new Promise<number>(() => undefined);
          },
          catch: () => new PreviewWebRuntimeError({ reason: "process-group-identity-unavailable" }),
        }),
      portChecker: async () => ({ available: true, status: "available" }),
      readinessChecker: async () => ({ reachable: true, status: 200 }),
      registryDirectory: directory,
    });

    yield* Effect.gen(function* () {
      const starting = yield* Effect.forkChild(
        runtime.start({
          sessionId,
          revision: "source-a",
          checkout: "/work/a",
          port: 4321,
          publicOrigin: "https://p-session-identity-interruption-sheet-web.dev.theerapakg.moe",
          environment: environmentFor(
            "https://p-session-identity-interruption-sheet-web.dev.theerapakg.moe",
          ),
          onSourceRevision: () => Effect.void,
        }),
      );
      yield* Effect.promise(() => identityReadStarted);
      yield* Fiber.interrupt(starting);
      expect(cleanupAttempts).toBe(1);
      expect(yield* runtime.status(sessionId)).toBe(false);
    }).pipe(
      Effect.ensuring(runtime.stop(sessionId).pipe(Effect.ignore)),
      Effect.ensuring(Effect.promise(() => rm(directory, { recursive: true, force: true }))),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it.live("kills the startup child and closes its revision listener on interruption", () =>
  Effect.gen(function* () {
    let resolveProbeStarted: () => void = () => undefined;
    let revisionUrl = "";
    let killed = false;
    const probeStarted = new Promise<void>((resolve) => {
      resolveProbeStarted = resolve;
    });
    const runtime = makePreviewWebRuntime({
      starter: async (request) => {
        revisionUrl = request.env.TIARA_PREVIEW_REVISION_URL ?? "";
        return {
          pid: 8128,
          exited: new Promise(() => undefined),
          kill: async () => {
            killed = true;
          },
        };
      },
      portChecker: async () => ({ available: true, status: "available" }),
      readinessChecker: async () => {
        resolveProbeStarted();
        return new Promise<never>(() => undefined);
      },
    });
    const starting = yield* Effect.forkChild(
      runtime.start({
        sessionId: "session-interrupted",
        revision: "source-a",
        checkout: "/work/a",
        port: 4317,
        publicOrigin: "https://p-session-interrupted-sheet-web.dev.theerapakg.moe",
        environment: environmentFor("https://p-session-interrupted-sheet-web.dev.theerapakg.moe"),
        onSourceRevision: () => Effect.void,
      }),
    );
    yield* Effect.tryPromise({ try: () => probeStarted, catch: (cause) => cause });
    yield* Fiber.interrupt(starting);
    const listenerProbe = yield* Effect.exit(
      Effect.tryPromise({
        try: () => fetch(revisionUrl),
        catch: (cause) => cause,
      }),
    );

    expect(killed).toBe(true);
    expect(listenerProbe._tag).toBe("Failure");
  }).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it.live("rejects oversized supervisor adoption bodies without a second response", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      mkdtemp(path.join(os.tmpdir(), "tiara-preview-adopt-limit-")),
    );
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const runtime = makePreviewWebRuntime({
      starter: async () => ({
        pid: undefined,
        exited: new Promise(() => undefined),
        kill: async () => undefined,
      }),
      portChecker: async () => ({ available: true, status: "available" }),
      readinessChecker: async () => ({ reachable: true, status: 200 }),
      registryDirectory: directory,
    });
    yield* Effect.gen(function* () {
      yield* runtime.start({
        sessionId,
        revision: "source-a",
        checkout: "/work/a",
        port: 4317,
        publicOrigin: "https://p-session-adopt-sheet-web.dev.theerapakg.moe",
        environment: environmentFor("https://p-session-adopt-sheet-web.dev.theerapakg.moe"),
        onSourceRevision: () => Effect.void,
        onSupervisorAdopt: () => Effect.void,
      });
      const rawRecord = yield* Effect.tryPromise({
        try: async () =>
          JSON.parse(await readFile(path.join(directory, `${sessionId}.json`), "utf8")) as unknown,
        catch: (cause) =>
          cause instanceof Error ? cause : new Error("supervisor-record-read-failed"),
      });
      const record = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ endpoint: Schema.String, controlToken: Schema.String }),
      )(rawRecord);
      const rejected = yield* Effect.tryPromise({
        try: () =>
          fetch(`${record.endpoint}/adopt`, {
            method: "POST",
            headers: { authorization: `Bearer ${record.controlToken}` },
            body: "x".repeat(2049),
          }),
        catch: (cause) => (cause instanceof Error ? cause : new Error("adopt-request-failed")),
      });
      expect(rejected.status).toBe(413);
      const status = yield* Effect.tryPromise({
        try: () =>
          fetch(`${record.endpoint}/status`, {
            headers: { authorization: `Bearer ${record.controlToken}` },
          }),
        catch: (cause) => (cause instanceof Error ? cause : new Error("status-request-failed")),
      });
      expect(status.status).toBe(200);
      yield* runtime.stop(sessionId);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Effect.result(runtime.stop(sessionId));
          yield* Effect.tryPromise({
            try: () => rm(directory, { recursive: true, force: true }),
            catch: () => undefined,
          }).pipe(Effect.ignore);
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it.live("lets a separate launcher stop the owner-recorded web process", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      mkdtemp(path.join(os.tmpdir(), "tiara-preview-runtime-")),
    );
    yield* Effect.gen(function* () {
      let killed = false;
      let revisionUrl = "";
      let revisionToken = "";
      let adopted: { supervisorIdentity: string; generation: number } | undefined;
      let failFirstRevision = true;
      const acceptedRevisions: string[] = [];
      const starter: ProcessStarter = async (request) => {
        revisionUrl = request.env.TIARA_PREVIEW_REVISION_URL ?? "";
        revisionToken = request.env.TIARA_PREVIEW_REVISION_TOKEN ?? "";
        return {
          pid: 8125,
          exited: new Promise(() => undefined),
          kill: async () => {
            killed = true;
          },
        };
      };
      const options = {
        starter,
        portChecker: async () => ({ available: true, status: "available" as const }),
        readinessChecker: async () => ({ reachable: true, status: 200 }),
        registryDirectory: directory,
      };
      const starterRuntime = makePreviewWebRuntime(options);
      const stopRuntime = makePreviewWebRuntime({
        registryDirectory: directory,
        readinessChecker: async () => ({ reachable: true, status: 200 }),
      });
      yield* starterRuntime.start({
        sessionId: "11111111-1111-4111-8111-111111111111",
        revision: "source-a",
        checkout: "/work/a",
        port: 4317,
        publicOrigin: "https://p-session-a-sheet-web.dev.theerapakg.moe",
        environment: environmentFor("https://p-session-a-sheet-web.dev.theerapakg.moe"),
        onSourceRevision: (revision) =>
          Effect.suspend(() => {
            if (failFirstRevision) {
              failFirstRevision = false;
              return Effect.fail(new Error("old supervisor was fenced"));
            }
            acceptedRevisions.push(revision);
            return Effect.void;
          }),
        onSupervisorAdopt: (supervisorIdentity, generation) =>
          Effect.sync(() => {
            adopted = { supervisorIdentity, generation };
          }),
      });
      const supervisorRecordContents = yield* Effect.promise(() =>
        readFile(path.join(directory, "11111111-1111-4111-8111-111111111111.json"), "utf8"),
      );
      const supervisorRecord = JSON.parse(supervisorRecordContents) as {
        readonly controlToken: string;
        readonly endpoint: string;
      };
      expect(supervisorRecord.controlToken).not.toBe(revisionToken);
      const revisionTokenStatus = yield* Effect.promise(() =>
        fetch(`${supervisorRecord.endpoint}/status`, {
          headers: { authorization: `Bearer ${revisionToken}` },
        }),
      );
      expect(revisionTokenStatus.status).toBe(404);
      const controlStatus = yield* Effect.promise(() =>
        fetch(`${supervisorRecord.endpoint}/status`, {
          headers: { authorization: `Bearer ${supervisorRecord.controlToken}` },
        }),
      );
      expect(controlStatus.status).toBe(200);
      const controlRevision = yield* Effect.promise(() =>
        fetch(revisionUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${supervisorRecord.controlToken}` },
          body: JSON.stringify({ revision: "a".repeat(64) }),
        }),
      );
      expect(controlRevision.status).toBe(404);
      expect(yield* stopRuntime.status("11111111-1111-4111-8111-111111111111")).toBe(true);
      const measurements = yield* stopRuntime.measurements("11111111-1111-4111-8111-111111111111");
      expect(measurements?.pid).toBe(8125);
      const staleRevision = yield* Effect.promise(() =>
        fetch(revisionUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${revisionToken}` },
          body: JSON.stringify({ revision: "b".repeat(64) }),
        }),
      );
      expect(staleRevision.status).toBe(503);
      const adoptedIdentity = "a".repeat(43);
      if (stopRuntime.adoptSupervisor === undefined || stopRuntime.availability === undefined)
        return yield* Effect.fail(new Error("supervisor adoption APIs are unavailable"));
      yield* stopRuntime.adoptSupervisor(
        "11111111-1111-4111-8111-111111111111",
        adoptedIdentity,
        1,
      );
      expect(adopted).toEqual({ supervisorIdentity: adoptedIdentity, generation: 1 });
      const revisionAfterAdoption = yield* Effect.promise(() =>
        fetch(revisionUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${revisionToken}` },
          body: JSON.stringify({ revision: "c".repeat(64) }),
        }),
      );
      expect(revisionAfterAdoption.status).toBe(204);
      expect(acceptedRevisions).toEqual(["c".repeat(64)]);
      expect(yield* stopRuntime.availability("11111111-1111-4111-8111-111111111111")).toBe("ready");
      yield* stopRuntime.stop("11111111-1111-4111-8111-111111111111");
      for (let attempt = 0; attempt < 20 && !killed; attempt += 1) yield* Effect.sleep("10 millis");
      expect(killed).toBe(true);
      expect(yield* stopRuntime.status("11111111-1111-4111-8111-111111111111")).toBe(false);
    }).pipe(Effect.ensuring(Effect.promise(() => rm(directory, { recursive: true, force: true }))));
  }).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it.live("resets failed revision authority after local supervisor adoption", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      mkdtemp(path.join(os.tmpdir(), "tiara-preview-local-adopt-")),
    );
    let revisionUrl = "";
    let revisionToken = "";
    let failFirstRevision = true;
    const acceptedRevisions: string[] = [];
    const runtime = makePreviewWebRuntime({
      starter: async (request) => {
        revisionUrl = request.env.TIARA_PREVIEW_REVISION_URL ?? "";
        revisionToken = request.env.TIARA_PREVIEW_REVISION_TOKEN ?? "";
        return {
          pid: undefined,
          exited: new Promise(() => undefined),
          kill: async () => undefined,
        };
      },
      portChecker: async () => ({ available: true, status: "available" as const }),
      readinessChecker: async () => ({ reachable: true, status: 200 }),
      registryDirectory: directory,
    });
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const postRevision = (revision: string) =>
      fetch(revisionUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${revisionToken}` },
        body: JSON.stringify({ revision }),
      });

    yield* Effect.gen(function* () {
      yield* runtime.start({
        sessionId,
        revision: "source-a",
        checkout: "/work/a",
        port: 4317,
        publicOrigin: "https://p-session-local-adopt-sheet-web.dev.theerapakg.moe",
        environment: environmentFor("https://p-session-local-adopt-sheet-web.dev.theerapakg.moe"),
        onSourceRevision: (revision) =>
          Effect.suspend(() => {
            if (failFirstRevision) {
              failFirstRevision = false;
              return Effect.fail(new Error("revision authority expired"));
            }
            acceptedRevisions.push(revision);
            return Effect.void;
          }),
        onSupervisorAdopt: () => Effect.void,
      });

      const rejectedRevision = yield* Effect.promise(() => postRevision("a".repeat(64)));
      expect(rejectedRevision.status).toBe(503);
      if (runtime.adoptSupervisor === undefined)
        return yield* Effect.fail(new Error("supervisor adoption API is unavailable"));
      yield* runtime.adoptSupervisor(sessionId, "d".repeat(43), 1);

      const acceptedRevision = yield* Effect.promise(() => postRevision("b".repeat(64)));
      expect(acceptedRevision.status).toBe(204);
      expect(acceptedRevisions).toEqual(["b".repeat(64)]);
      yield* runtime.stop(sessionId);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Effect.result(runtime.stop(sessionId));
          yield* Effect.tryPromise({
            try: () => rm(directory, { recursive: true, force: true }),
            catch: () => undefined,
          }).pipe(Effect.ignore);
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it.live("reclaims a recorded detached process group when its supervisor is unavailable", () =>
  Effect.gen(function* () {
    if (process.platform === "win32") return;
    const directory = yield* Effect.promise(() =>
      mkdtemp(path.join(os.tmpdir(), "tiara-preview-stale-supervisor-")),
    );
    let processGroupId: number | undefined;
    yield* Effect.gen(function* () {
      let childExit: Promise<void> | undefined;
      const starter: ProcessStarter = async () => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: true,
          stdio: "ignore",
        });
        childExit = new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", () => resolve());
        });
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", () => resolve());
          child.once("error", reject);
        });
        if (child.pid === undefined) throw new Error("child pid unavailable");
        processGroupId = child.pid;
        return {
          pid: child.pid,
          processGroupId: child.pid,
          exited: childExit.then(() => ({ exitCode: 0, stdout: "", stderr: "" })),
          kill: async () => {
            globalThis.process.kill(-child.pid!, "SIGTERM");
          },
        };
      };
      const options = {
        starter,
        portChecker: async () => ({ available: true, status: "available" as const }),
        readinessChecker: async () => ({ reachable: true, status: 200 }),
        registryDirectory: directory,
      };
      const ownerRuntime = makePreviewWebRuntime(options);
      const stopRuntime = makePreviewWebRuntime({ registryDirectory: directory });
      const sessionId = "22222222-2222-4222-8222-222222222222";
      yield* ownerRuntime.start({
        sessionId,
        revision: "source-a",
        checkout: "/work/a",
        port: 4317,
        publicOrigin: "https://p-session-stale-sheet-web.dev.theerapakg.moe",
        environment: environmentFor("https://p-session-stale-sheet-web.dev.theerapakg.moe"),
        onSourceRevision: () => Effect.void,
      });
      const recordPath = path.join(directory, `${sessionId}.json`);
      const record = JSON.parse(yield* Effect.promise(() => readFile(recordPath, "utf8"))) as {
        readonly controlToken: string;
        readonly processGroupId: number;
        readonly processId: number;
        readonly processStartedAt: number;
        readonly sessionId: string;
      };
      expect(record.processGroupId).toBe(processGroupId);
      yield* Effect.promise(() =>
        writeFile(recordPath, JSON.stringify({ ...record, endpoint: "http://127.0.0.1:1" }), {
          mode: 0o600,
        }),
      );

      yield* Effect.promise(() =>
        writeFile(
          recordPath,
          JSON.stringify({
            ...record,
            endpoint: "http://127.0.0.1:1",
            processStartedAt: record.processStartedAt + 1_000,
          }),
          { mode: 0o600 },
        ),
      );
      const unprovenCleanup = yield* Effect.exit(stopRuntime.stop(sessionId));
      expect(unprovenCleanup._tag).toBe("Failure");
      expect(() => globalThis.process.kill(-record.processGroupId, 0)).not.toThrow();

      yield* Effect.promise(() =>
        writeFile(recordPath, JSON.stringify({ ...record, endpoint: "http://127.0.0.1:1" }), {
          mode: 0o600,
        }),
      );

      yield* stopRuntime.stop(sessionId);
      yield* Effect.tryPromise({
        try: () => childExit!,
        catch: (cause) => cause,
      });
      const recordExists = yield* Effect.promise(() =>
        readFile(recordPath, "utf8").then(
          () => true,
          () => false,
        ),
      );
      expect(recordExists).toBe(false);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (processGroupId !== undefined) {
            try {
              globalThis.process.kill(-processGroupId, "SIGKILL");
            } catch {
              // The group has already exited.
            }
          }
        }),
      ),
      Effect.ensuring(Effect.promise(() => rm(directory, { recursive: true, force: true }))),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it.live("retains the process-group record when the leader exits before its descendant", () =>
  Effect.gen(function* () {
    if (process.platform === "win32") return;
    const directory = yield* Effect.promise(() =>
      mkdtemp(path.join(os.tmpdir(), "tiara-preview-exited-leader-")),
    );
    let processGroupId: number | undefined;
    yield* Effect.gen(function* () {
      let resolveLeaderExit: () => void = () => undefined;
      const leaderExit = new Promise<void>((resolve) => {
        resolveLeaderExit = resolve;
      });
      const starter: ProcessStarter = async () => {
        const child = spawn(
          process.execPath,
          [
            "-e",
            'const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); setTimeout(() => process.exit(0), 500);',
          ],
          { detached: true, stdio: "ignore" },
        );
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", () => resolve());
          child.once("error", reject);
        });
        if (child.pid === undefined) throw new Error("preview child PID unavailable");
        processGroupId = child.pid;
        const exited = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
          (resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code) => {
              resolveLeaderExit();
              resolve({ exitCode: code ?? 1, stdout: "", stderr: "" });
            });
          },
        );
        return {
          pid: child.pid,
          processGroupId: child.pid,
          exited,
          kill: async () => {
            process.kill(-child.pid!, "SIGTERM");
            await exited;
          },
        };
      };
      const runtime = makePreviewWebRuntime({
        starter,
        portChecker: async () => ({ available: true, status: "available" }),
        readinessChecker: async () => ({ reachable: true, status: 200 }),
        registryDirectory: directory,
      });
      const sessionId = "33333333-3333-4333-8333-333333333333";
      yield* runtime.start({
        sessionId,
        revision: "source-a",
        checkout: "/work/a",
        port: 4317,
        publicOrigin: "https://p-session-exited-leader-sheet-web.dev.theerapakg.moe",
        environment: environmentFor("https://p-session-exited-leader-sheet-web.dev.theerapakg.moe"),
        onSourceRevision: () => Effect.void,
      });
      yield* Effect.promise(() => leaderExit);
      yield* Effect.sleep("200 millis");

      expect(processGroupId).toBeDefined();
      expect(() => process.kill(-processGroupId!, 0)).not.toThrow();
      const recordPath = path.join(directory, `${sessionId}.json`);
      const retainedRecord = yield* Effect.exit(Effect.promise(() => readFile(recordPath, "utf8")));
      expect(retainedRecord._tag).toBe("Success");
      const cleanup = yield* Effect.exit(runtime.stop(sessionId));
      expect(cleanup._tag).toBe("Failure");
      const recordAfterBlockedCleanup = yield* Effect.exit(
        Effect.promise(() => readFile(recordPath, "utf8")),
      );
      expect(recordAfterBlockedCleanup._tag).toBe("Success");
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (processGroupId !== undefined) {
            try {
              process.kill(-processGroupId, "SIGKILL");
            } catch {
              // The process group has already exited.
            }
          }
        }),
      ),
      Effect.ensuring(Effect.promise(() => rm(directory, { recursive: true, force: true }))),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it.live("retains runtime cleanup evidence when a Windows leader exits before descendants", () =>
  Effect.gen(function* () {
    if (process.platform === "win32") return;
    const directory = yield* Effect.promise(() =>
      mkdtemp(path.join(os.tmpdir(), "tiara-preview-windows-exited-leader-")),
    );
    let processGroupId: number | undefined;
    let leaderExited: Promise<unknown> | undefined;
    let releaseWatcherExit: () => void = () => undefined;
    const watcherExit = new Promise<void>((resolve) => {
      releaseWatcherExit = resolve;
    });
    const runtime = makePreviewWebRuntime({
      starter: async (request, signal) => {
        const child = await startLongLivedProcess(
          {
            ...request,
            command: process.execPath,
            args: [
              "-e",
              'const { spawn } = require("node:child_process"); const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); descendant.once("spawn", () => setTimeout(() => process.exit(0), 50));',
            ],
            cwd: process.cwd(),
            timeoutMs: 2_147_483_647,
            output: "inherit",
          },
          signal,
        );
        processGroupId = child.processGroupId;
        leaderExited = child.exited;
        // Windows does not expose a process group ID for this child. Hold the
        // runtime's exit watcher until stop has had to account for uncertainty.
        return {
          pid: child.pid,
          exited: watcherExit.then(() => child.exited),
          kill: child.kill,
        };
      },
      portChecker: async () => ({ available: true, status: "available" }),
      readinessChecker: async () => ({ reachable: true, status: 200 }),
      registryDirectory: directory,
    });
    const sessionId = "44444444-4444-4444-8444-444444444445";
    const recordPath = path.join(directory, sessionId + ".json");
    let platform: PropertyDescriptor | undefined;
    yield* Effect.gen(function* () {
      yield* runtime.start({
        sessionId,
        revision: "source-a",
        checkout: "/work/windows-cleanup",
        port: 4317,
        publicOrigin: "https://p-session-windows-cleanup-sheet-web.dev.theerapakg.moe",
        environment: environmentFor(
          "https://p-session-windows-cleanup-sheet-web.dev.theerapakg.moe",
        ),
        onSourceRevision: () => Effect.void,
      });
      expect(processGroupId).toBeDefined();
      yield* Effect.promise(() => leaderExited!);
      expect(() => process.kill(-processGroupId!, 0)).not.toThrow();

      const recordBeforeStop = JSON.parse(
        yield* Effect.promise(() => readFile(recordPath, "utf8")),
      );
      expect(recordBeforeStop).toMatchObject({ sessionId });
      expect(recordBeforeStop.processGroupId).toBeUndefined();

      platform = Object.getOwnPropertyDescriptor(process, "platform");
      if (platform === undefined)
        return yield* Effect.fail(new Error("process platform unavailable"));
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      try {
        const cleanup = yield* Effect.exit(runtime.stop(sessionId));
        expect(cleanup._tag).toBe("Failure");
        const retainedRecord = JSON.parse(
          yield* Effect.promise(() => readFile(recordPath, "utf8")),
        );
        expect(retainedRecord).toMatchObject({ sessionId });
        expect(() => process.kill(-processGroupId!, 0)).not.toThrow();
      } finally {
        Object.defineProperty(process, "platform", platform);
        platform = undefined;
      }
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (platform !== undefined) Object.defineProperty(process, "platform", platform);
          if (processGroupId !== undefined) {
            try {
              process.kill(-processGroupId, "SIGKILL");
            } catch {
              // The test-owned group has already exited.
            }
          }
          yield* Effect.result(runtime.stop(sessionId));
          releaseWatcherExit();
          yield* Effect.sleep("50 millis");
          yield* Effect.promise(() => rm(directory, { recursive: true, force: true }));
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);
