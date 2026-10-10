import { Context, Effect, FileSystem, Layer, Result, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { checkHttpReadiness } from "./access";
import { startLongLivedProcess } from "./executor";
import { checkLoopbackPort } from "./ports";
import type { PortChecker, ProcessStarter, ReadinessChecker, RunningProcess } from "./types";

const webEnvironmentKeys = [
  "NODE_ENV",
  "LOG_LEVEL",
  "APP_BASE_URL",
  "AUTH_BASE_URL",
  "SHEET_ZERO_BASE_URL",
  "SHEET_WORKFLOWS_BASE_URL",
  "SEARCH_BASE_URL",
  "DEV_SHEET_WEB_PORT",
  "TIARA_PREVIEW_HMR_PATH",
  "TIARA_PREVIEW_REVISION_URL",
  "TIARA_PREVIEW_REVISION_TOKEN",
  "TIARA_PREVIEW_SOURCE_REVISION",
  "TIARA_PREVIEW_ADMISSION_TOKEN",
  "TIARA_PREVIEW_APPLICATION_INTEGRATION_TOKEN",
  "TIARA_PREVIEW_SEARCH_QUERY_TOKEN",
] as const;

export const PreviewWebEnvironmentSchema = Schema.Record(Schema.String, Schema.String);
export type PreviewWebEnvironment = Readonly<Record<string, string>>;

const hasSecureDevelopmentUrlComponents = (url: URL) =>
  url.protocol === "https:" &&
  url.username === "" &&
  url.password === "" &&
  url.search === "" &&
  url.hash === "";
const isDevelopmentGatewayHostname = (hostname: string, expectedHostname?: string) => {
  const matchesDevelopmentDomain = /^(?:[a-z0-9-]+\.)*dev\.(?:[a-z0-9-]+\.)+[a-z0-9-]+$/.test(
    hostname,
  );
  const matchesExpectedHost = expectedHostname === undefined || hostname === expectedHostname;
  const isProductionName = /(^|[.-])(prod|production|live)([.-]|$)/i.test(hostname);
  return matchesDevelopmentDomain && matchesExpectedHost && !isProductionName;
};
const safeDevelopmentUrl = (input: string, expectedHostname?: string) => {
  try {
    const url = new URL(input);
    return (
      hasSecureDevelopmentUrlComponents(url) &&
      isDevelopmentGatewayHostname(url.hostname, expectedHostname)
    );
  } catch {
    return false;
  }
};

export const makePreviewWebProcessRequest = (input: {
  readonly checkout: string;
  readonly port: number;
  readonly publicOrigin: string;
  readonly revision: string;
  readonly environment: PreviewWebEnvironment;
}) => {
  let publicUrl: URL;
  try {
    publicUrl = new URL(input.publicOrigin);
  } catch {
    return undefined;
  }
  if (
    !Number.isSafeInteger(input.port) ||
    input.port < 1024 ||
    input.port > 65535 ||
    !safeDevelopmentUrl(input.publicOrigin) ||
    publicUrl.pathname !== "/"
  )
    return undefined;
  const allowed = new Set<string>(webEnvironmentKeys);
  const environment: Record<string, string> = {
    NODE_ENV: "development",
    APP_BASE_URL: input.publicOrigin,
    DEV_SHEET_WEB_PORT: String(input.port),
    TIARA_PREVIEW_HMR_PATH: "/_preview/app/__vite_hmr",
    TIARA_PREVIEW_SOURCE_REVISION: input.revision,
  };
  for (const [key, value] of Object.entries(input.environment)) {
    if (
      !allowed.has(key) ||
      key === "NODE_ENV" ||
      key === "DEV_SHEET_WEB_PORT" ||
      key === "APP_BASE_URL" ||
      key === "TIARA_PREVIEW_HMR_PATH" ||
      key === "TIARA_PREVIEW_SOURCE_REVISION" ||
      value.length > 16_384
    )
      return undefined;
    if (key.endsWith("_BASE_URL") && !safeDevelopmentUrl(value, publicUrl.hostname))
      return undefined;
    environment[key] = value;
  }
  return {
    command: "pnpm",
    args: [
      "--filter",
      "sheet-web",
      "exec",
      "vp",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(input.port),
      "--strictPort",
    ],
    cwd: input.checkout,
    env: environment,
    environmentInheritance: "web-preview" as const,
    timeoutMs: 2_147_483_647,
    kind: "runtime" as const,
    readOnly: false,
    output: "inherit" as const,
  };
};

const waitForWebReadiness = (
  child: RunningProcess,
  readiness: ReadinessChecker,
  port: number,
  now: () => number,
  timeoutMs: number,
  pollIntervalMs: number,
) =>
  Effect.gen(function* () {
    let childExited = false;
    void child.exited.then(() => {
      childExited = true;
    });
    const deadline = now() + timeoutMs;
    while (now() < deadline && !childExited) {
      if (yield* probeWeb(readiness, port)) return true;
      yield* Effect.sleep(pollIntervalMs);
    }
    return false;
  });

const registerParentExitCleanup = (pid: number | undefined) => {
  if (pid === undefined) return () => undefined;
  const onExit = () => {
    const processGroup = globalThis.process.platform === "win32" ? pid : -pid;
    try {
      globalThis.process.kill(processGroup, "SIGTERM");
    } catch {
      // The process group has already exited.
    }
  };
  globalThis.process.once("exit", onExit);
  return () => globalThis.process.off("exit", onExit);
};

const cleanupUnreadyWebProcess = (
  child: RunningProcess,
  revisionEndpoint: { readonly close: Effect.Effect<void, PreviewWebRuntimeError> },
  onUnconfirmedCleanup: () => Effect.Effect<void, PreviewWebRuntimeError, FileSystem.FileSystem>,
  onConfirmedCleanup: () => Effect.Effect<void>,
) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const killed = yield* Effect.result(
        Effect.tryPromise({
          try: child.kill,
          catch: () => new PreviewWebRuntimeError({ reason: "web-process-cleanup-failed" }),
        }),
      );
      const listenerClosed = yield* Effect.result(revisionEndpoint.close);
      if (Result.isFailure(killed)) {
        yield* onUnconfirmedCleanup();
      } else yield* onConfirmedCleanup();
      return { killed, listenerClosed };
    }),
  );

const ensureWebProcessReady = (
  child: RunningProcess,
  revisionEndpoint: { readonly close: Effect.Effect<void, PreviewWebRuntimeError> },
  readiness: ReadinessChecker,
  port: number,
  now: () => number,
  timeoutMs: number,
  pollIntervalMs: number,
  onUnconfirmedCleanup: () => Effect.Effect<void, PreviewWebRuntimeError, FileSystem.FileSystem>,
  onConfirmedCleanup: () => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const startedAt = now();
    const isReady = yield* waitForWebReadiness(
      child,
      readiness,
      port,
      now,
      timeoutMs,
      pollIntervalMs,
    );
    if (!isReady) {
      const cleanup = yield* cleanupUnreadyWebProcess(
        child,
        revisionEndpoint,
        onUnconfirmedCleanup,
        onConfirmedCleanup,
      );
      return yield* failAfterUnreadyCleanup(
        cleanup,
        new PreviewWebRuntimeError({ reason: "web-readiness-failed" }),
      );
    }
    return startedAt;
  });

export class PreviewWebRuntimeError extends Schema.TaggedErrorClass<PreviewWebRuntimeError>()(
  "PreviewWebRuntimeError",
  { reason: Schema.String },
) {}

const failAfterUnreadyCleanup = (
  cleanup: {
    readonly killed: Result.Result<void, PreviewWebRuntimeError>;
    readonly listenerClosed: Result.Result<void, PreviewWebRuntimeError>;
  },
  failure: PreviewWebRuntimeError,
) => {
  if (Result.isFailure(cleanup.killed)) return Effect.fail(cleanup.killed.failure);
  if (Result.isFailure(cleanup.listenerClosed)) return Effect.fail(cleanup.listenerClosed.failure);
  return Effect.fail(failure);
};

export interface PreviewWebProcess {
  readonly sessionId: string;
  readonly revision: string;
  readonly port: number;
  readonly pid: number | undefined;
  readonly startedAt: number;
  readonly readyAt: number;
  readonly startupDurationMs: number;
  readonly lastEditDurationMs: number | null;
  readonly editCount: number;
  readonly stop: Effect.Effect<
    void,
    PreviewWebRuntimeError,
    FileSystem.FileSystem | HttpClient.HttpClient
  >;
}
export interface PreviewWebProcessTreeSample {
  readonly processIds: readonly number[];
  readonly cpuTimeMs: number;
  readonly memoryRssBytes: number;
  readonly sampledAt: number;
}
interface PreviewWebProcessTreeAttribution extends PreviewWebProcessTreeSample {
  readonly available: boolean;
  readonly sampleCount: number;
  readonly memoryHighWaterBytes: number;
}
export type PreviewWebProcessTreeSampler = (
  processGroupId: number,
) => Effect.Effect<PreviewWebProcessTreeSample, PreviewWebRuntimeError>;
const cpuTimeMilliseconds = (input: string) => {
  const pieces = input.split(":").map(Number);
  const seconds =
    pieces.length === 3
      ? (pieces[0] ?? 0) * 3600 + (pieces[1] ?? 0) * 60 + (pieces[2] ?? 0)
      : pieces.length === 2
        ? (pieces[0] ?? 0) * 60 + (pieces[1] ?? 0)
        : Number.NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
};
const sampleProcessGroup: PreviewWebProcessTreeSampler = (processGroupId) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        if (process.platform === "win32") {
          reject(new Error("process-tree-sampler-unsupported"));
          return;
        }
        const args =
          process.platform === "darwin"
            ? ["-o", "pid=,pgid=,time=,rss=", "-g", String(processGroupId)]
            : ["-o", "pid=,pgid=,time=,rss=", "--pgroup", String(processGroupId)];
        execFile("ps", args, { timeout: 3_000 }, (error, stdout) =>
          error === null ? resolve(stdout) : reject(error),
        );
      }),
    catch: () => new PreviewWebRuntimeError({ reason: "process-tree-sampler-unavailable" }),
  }).pipe(
    Effect.flatMap((output) =>
      Effect.try({
        try: () => {
          const processes = output
            .split("\n")
            .map((line) => line.trim().split(/\s+/))
            .filter((columns) => columns.length >= 4)
            .flatMap((columns) => {
              const pid = Number(columns[0]);
              const pgid = Number(columns[1]);
              const cpuTimeMs = cpuTimeMilliseconds(columns[2] ?? "");
              const memoryKilobytes = Number(columns[3]);
              return pid > 0 &&
                pgid === processGroupId &&
                cpuTimeMs !== undefined &&
                Number.isFinite(memoryKilobytes)
                ? [{ pid, cpuTimeMs, memoryRssBytes: memoryKilobytes * 1024 }]
                : [];
            });
          if (processes.length === 0) throw new Error("process-tree-not-found");
          return {
            processIds: processes.map(({ pid }) => pid),
            cpuTimeMs: processes.reduce((total, item) => total + item.cpuTimeMs, 0),
            memoryRssBytes: processes.reduce((total, item) => total + item.memoryRssBytes, 0),
            sampledAt: Date.now(),
          } satisfies PreviewWebProcessTreeSample;
        },
        catch: () => new PreviewWebRuntimeError({ reason: "process-tree-sample-invalid" }),
      }),
    ),
  );
const PreviewWebProcessMeasurementsSchema = Schema.Struct({
  sessionId: Schema.String,
  revision: Schema.String,
  port: Schema.Number,
  pid: Schema.NullOr(Schema.Number),
  startedAt: Schema.Number,
  readyAt: Schema.Number,
  startupDurationMs: Schema.Number,
  lastEditDurationMs: Schema.NullOr(Schema.Number),
  editCount: Schema.Number,
  processTree: Schema.Struct({
    available: Schema.Boolean,
    sampleCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    processIds: Schema.Array(Schema.Int),
    cpuTimeMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
    memoryRssBytes: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
    memoryHighWaterBytes: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
    sampledAt: Schema.Finite,
  }),
});
type PreviewWebProcessMeasurements = typeof PreviewWebProcessMeasurementsSchema.Type;
export interface PreviewWebRuntimeApi {
  readonly start: (input: {
    readonly sessionId: string;
    readonly revision: string;
    readonly checkout: string;
    readonly port: number;
    readonly publicOrigin: string;
    readonly environment: PreviewWebEnvironment;
    readonly onSourceRevision: (revision: string) => Effect.Effect<void, Error>;
    readonly onSupervisorAdopt?: (
      supervisorIdentity: string,
      generation: number,
    ) => Effect.Effect<void, Error>;
  }) => Effect.Effect<
    PreviewWebProcess,
    PreviewWebRuntimeError,
    FileSystem.FileSystem | HttpClient.HttpClient
  >;
  readonly stop: (
    sessionId: string,
  ) => Effect.Effect<void, PreviewWebRuntimeError, FileSystem.FileSystem | HttpClient.HttpClient>;
  readonly status: (
    sessionId: string,
  ) => Effect.Effect<boolean, never, FileSystem.FileSystem | HttpClient.HttpClient>;
  readonly measurements: (
    sessionId: string,
  ) => Effect.Effect<
    PreviewWebProcessMeasurements | undefined,
    never,
    FileSystem.FileSystem | HttpClient.HttpClient
  >;
  /** Transfers the live supervisor's fenced session identity across a compatible resume. */
  readonly adoptSupervisor?: (
    sessionId: string,
    supervisorIdentity: string,
    generation: number,
  ) => Effect.Effect<void, PreviewWebRuntimeError, FileSystem.FileSystem | HttpClient.HttpClient>;
  /** Distinguishes confirmed process exit from a failed loopback readiness probe. */
  readonly availability?: (
    sessionId: string,
  ) => Effect.Effect<
    "ready" | "transient-failure" | "missing",
    never,
    FileSystem.FileSystem | HttpClient.HttpClient
  >;
}
export class PreviewWebRuntime extends Context.Service<PreviewWebRuntime, PreviewWebRuntimeApi>()(
  "developer-launcher/PreviewWebRuntime",
) {}
export const PreviewWebRuntimeLayer = (runtime: PreviewWebRuntimeApi) =>
  Layer.succeed(PreviewWebRuntime, runtime);

const supervisorRecordSchema = Schema.Struct({
  sessionId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/i)),
  endpoint: Schema.String.check(Schema.isPattern(/^http:\/\/127\.0\.0\.1:[0-9]+$/)),
  controlToken: Schema.String.check(Schema.isMinLength(32)),
  processId: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  processGroupId: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  processStartedAt: Schema.optional(Schema.Finite),
});
type SupervisorRecord = typeof supervisorRecordSchema.Type;
const legacySupervisorRecordSchema = Schema.Struct({
  sessionId: supervisorRecordSchema.fields.sessionId,
  endpoint: supervisorRecordSchema.fields.endpoint,
  token: Schema.String.check(Schema.isMinLength(32)),
});

const processGroupLeaderStartedAt = (processId: number, processGroupId: number) =>
  Effect.tryPromise({
    try: () =>
      new Promise<number>((resolve, reject) =>
        execFile(
          "ps",
          ["-o", "pid=,pgid=,lstart=", "-p", String(processId)],
          { timeout: 3_000, env: { ...process.env, LC_ALL: "C", LANG: "C" } },
          (error, stdout) => {
            if (error !== null) {
              reject(error);
              return;
            }
            const match = stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
            if (
              match === null ||
              Number(match[1]) !== processId ||
              Number(match[2]) !== processGroupId
            ) {
              reject(new Error("process-group-identity-unavailable"));
              return;
            }
            const startedAt = Date.parse(match[3] ?? "");
            if (!Number.isFinite(startedAt)) {
              reject(new Error("process-group-start-time-unavailable"));
              return;
            }
            resolve(startedAt);
          },
        ),
      ),
    catch: () => new PreviewWebRuntimeError({ reason: "process-group-identity-unavailable" }),
  });

const processGroupExists = (processGroupId: number) =>
  Effect.try({
    try: () => {
      globalThis.process.kill(-processGroupId, 0);
      return true;
    },
    catch: (cause) => cause as NodeJS.ErrnoException,
  }).pipe(
    Effect.catchIf(
      (error) => error.code === "ESRCH",
      () => Effect.succeed(false),
    ),
    Effect.catchIf(
      (error) => error.code === "EPERM",
      () => Effect.succeed(true),
    ),
    Effect.mapError(() => new PreviewWebRuntimeError({ reason: "process-group-check-failed" })),
  );

const signalProcessGroup = (processGroupId: number, signal: "SIGTERM" | "SIGKILL") =>
  Effect.try({
    try: () => globalThis.process.kill(-processGroupId, signal),
    catch: (cause) => cause as NodeJS.ErrnoException,
  }).pipe(
    Effect.catchIf(
      (error) => error.code === "ESRCH",
      () => Effect.void,
    ),
    Effect.mapError(() => new PreviewWebRuntimeError({ reason: "process-group-signal-failed" })),
    Effect.asVoid,
  );

const waitForProcessGroupExit = (processGroupId: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (!(yield* processGroupExists(processGroupId))) return true;
      yield* Effect.sleep("100 millis");
    }
    return !(yield* processGroupExists(processGroupId));
  });

type ProcessGroupCleanupOperations = {
  readonly exists: typeof processGroupExists;
  readonly leaderStartedAt: typeof processGroupLeaderStartedAt;
  readonly signal: typeof signalProcessGroup;
  readonly waitForExit: typeof waitForProcessGroupExit;
};
const defaultProcessGroupCleanupOperations: ProcessGroupCleanupOperations = {
  exists: processGroupExists,
  leaderStartedAt: processGroupLeaderStartedAt,
  signal: signalProcessGroup,
  waitForExit: waitForProcessGroupExit,
};

const recordedProcessGroupIsOwned = (
  record: SupervisorRecord,
  operations: ProcessGroupCleanupOperations,
) =>
  Effect.gen(function* () {
    const { processId, processGroupId, processStartedAt } = record;
    if (
      processId === undefined ||
      processGroupId === undefined ||
      processStartedAt === undefined ||
      processId !== processGroupId
    )
      return yield* Effect.fail(
        new PreviewWebRuntimeError({ reason: "supervisor-process-identity-unavailable" }),
      );
    if (!(yield* operations.exists(processGroupId))) return undefined;
    const actualStartedAt = yield* operations.leaderStartedAt(processId, processGroupId);
    if (actualStartedAt !== processStartedAt)
      return yield* Effect.fail(
        new PreviewWebRuntimeError({ reason: "supervisor-process-identity-mismatch" }),
      );
    return processGroupId;
  });

export const terminateRecordedProcessGroup = (
  record: SupervisorRecord,
  operations = defaultProcessGroupCleanupOperations,
) =>
  Effect.gen(function* () {
    const processGroupId = yield* recordedProcessGroupIsOwned(record, operations);
    if (processGroupId === undefined) return;
    yield* operations.signal(processGroupId, "SIGTERM");
    if (yield* operations.waitForExit(processGroupId)) return;
    // PGIDs can be reused after the original group exits; prove the recorded leader still owns it.
    const stillOwned = yield* recordedProcessGroupIsOwned(record, operations);
    if (stillOwned === undefined) return;
    yield* operations.signal(stillOwned, "SIGKILL");
    if (!(yield* operations.waitForExit(stillOwned)))
      return yield* Effect.fail(
        new PreviewWebRuntimeError({ reason: "supervisor-process-cleanup-failed" }),
      );
  });

export const makePreviewWebRuntime = (options: {
  readonly starter?: ProcessStarter;
  readonly readinessChecker?: ReadinessChecker;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly startupTimeoutMs?: number;
  readonly portChecker?: PortChecker;
  readonly processTreeSampler?: PreviewWebProcessTreeSampler;
  readonly processTreeSamplingIntervalMs?: number;
  readonly registryDirectory?: string;
  readonly processIdentityReader?: typeof processGroupLeaderStartedAt;
}) => {
  const starter = options.starter ?? startLongLivedProcess;
  const readiness = options.readinessChecker ?? checkHttpReadiness;
  const portChecker = options.portChecker ?? checkLoopbackPort;
  const processTreeSampler = options.processTreeSampler ?? sampleProcessGroup;
  const processIdentityReader = options.processIdentityReader ?? processGroupLeaderStartedAt;
  const now = options.now ?? Date.now;
  const running = new Map<string, PreviewWebProcess>();
  const children = new Map<string, RunningProcess>();
  const unconfirmedStarts = new Map<
    string,
    {
      readonly retryCleanup: () => Effect.Effect<
        void,
        PreviewWebRuntimeError,
        FileSystem.FileSystem | HttpClient.HttpClient
      >;
    }
  >();
  const adoptionHandlers = new Map<
    string,
    NonNullable<Parameters<PreviewWebRuntimeApi["start"]>[0]["onSupervisorAdopt"]>
  >();
  const processTree = new Map<string, PreviewWebProcessTreeAttribution>();
  const hasActiveStart = (sessionId: string) =>
    running.has(sessionId) || unconfirmedStarts.has(sessionId);
  const recordPath = (sessionId: string) =>
    options.registryDirectory === undefined || !/^[a-f0-9-]{36}$/i.test(sessionId)
      ? undefined
      : path.join(options.registryDirectory, `${sessionId}.json`);
  const readRecord = (sessionId: string) =>
    Effect.gen(function* () {
      const target = recordPath(sessionId);
      if (target === undefined) return undefined;
      const fileSystem = yield* FileSystem.FileSystem;
      const exists = yield* fileSystem
        .exists(target)
        .pipe(
          Effect.mapError(
            () => new PreviewWebRuntimeError({ reason: "supervisor-record-unavailable" }),
          ),
        );
      if (!exists) return undefined;
      const contentsResult = yield* Effect.result(fileSystem.readFileString(target));
      if (Result.isFailure(contentsResult)) {
        const stillExists = yield* fileSystem
          .exists(target)
          .pipe(
            Effect.mapError(
              () => new PreviewWebRuntimeError({ reason: "supervisor-record-unavailable" }),
            ),
          );
        if (!stillExists) return undefined;
        return yield* Effect.fail(
          new PreviewWebRuntimeError({ reason: "supervisor-record-unavailable" }),
        );
      }
      const contents = contentsResult.success;
      return yield* Effect.try({
        try: () => {
          const value = JSON.parse(contents) as unknown;
          const current = Schema.decodeUnknownOption(supervisorRecordSchema)(value);
          if (current._tag === "Some") return current.value;
          const legacy = Schema.decodeUnknownSync(legacySupervisorRecordSchema)(value);
          return {
            sessionId: legacy.sessionId,
            endpoint: legacy.endpoint,
            controlToken: legacy.token,
          };
        },
        catch: () => new PreviewWebRuntimeError({ reason: "supervisor-record-unavailable" }),
      });
    });
  const writeRecord = (record: SupervisorRecord) =>
    Effect.gen(function* () {
      if (options.registryDirectory === undefined) return;
      const fileSystem = yield* FileSystem.FileSystem;
      const target = recordPath(record.sessionId);
      if (target === undefined)
        return yield* Effect.fail(
          new PreviewWebRuntimeError({ reason: "supervisor-record-write-failed" }),
        );
      yield* fileSystem
        .makeDirectory(options.registryDirectory, { recursive: true, mode: 0o700 })
        .pipe(
          Effect.mapError(
            () => new PreviewWebRuntimeError({ reason: "supervisor-record-write-failed" }),
          ),
        );
      yield* fileSystem
        .writeFileString(target, JSON.stringify(record), { mode: 0o600 })
        .pipe(
          Effect.mapError(
            () => new PreviewWebRuntimeError({ reason: "supervisor-record-write-failed" }),
          ),
        );
      yield* fileSystem
        .chmod(options.registryDirectory, 0o700)
        .pipe(
          Effect.mapError(
            () => new PreviewWebRuntimeError({ reason: "supervisor-record-write-failed" }),
          ),
        );
    });
  const removeRecord = (sessionId: string) =>
    Effect.gen(function* () {
      const target = recordPath(sessionId);
      if (target === undefined) return;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem
        .remove(target, { force: true })
        .pipe(
          Effect.mapError(
            () => new PreviewWebRuntimeError({ reason: "supervisor-record-remove-failed" }),
          ),
        );
    });
  const makeSupervisorRecord = (
    sessionId: string,
    revisionEndpoint: { readonly endpoint: string; readonly controlToken: string },
    processIdentity:
      | {
          readonly processId: number;
          readonly processGroupId: number;
          readonly processStartedAt: number;
        }
      | undefined,
  ): SupervisorRecord => ({
    sessionId,
    endpoint: revisionEndpoint.endpoint,
    controlToken: revisionEndpoint.controlToken,
    ...processIdentity,
  });
  const watchProcessExit = (
    sessionId: string,
    child: RunningProcess,
    record: SupervisorRecord,
    removeSignalHandlers: () => void,
    revisionEndpoint: { readonly close: Effect.Effect<void, PreviewWebRuntimeError> },
    runtimeContext: Context.Context<FileSystem.FileSystem | HttpClient.HttpClient>,
  ) => {
    const runWithContext = Effect.runPromiseWith(runtimeContext);
    void child.exited.then(() => {
      if (children.get(sessionId) === child) {
        running.delete(sessionId);
        children.delete(sessionId);
        adoptionHandlers.delete(sessionId);
        processTree.delete(sessionId);
        removeSignalHandlers();
      }
      void runWithContext(revisionEndpoint.close).catch(() => undefined);
      // Keep the durable identity if the leader exits while its group remains or ownership
      // can no longer be proven. A later cleanup must not mistake that group for a dead child.
      void runWithContext(terminateRecordedProcessGroup(record))
        .then(() => runWithContext(removeRecord(sessionId)))
        .catch(() => undefined);
    });
  };
  const emptyProcessTreeAttribution = (): PreviewWebProcessTreeAttribution => ({
    available: false,
    sampleCount: 0,
    processIds: [],
    cpuTimeMs: 0,
    memoryRssBytes: 0,
    memoryHighWaterBytes: 0,
    sampledAt: now(),
  });
  const recordProcessTreeSample = (sessionId: string, processGroupId: number | undefined) =>
    Effect.gen(function* () {
      const previous = processTree.get(sessionId) ?? emptyProcessTreeAttribution();
      if (processGroupId === undefined) {
        processTree.set(sessionId, { ...previous, available: false, sampledAt: now() });
        return;
      }
      const result = yield* Effect.result(processTreeSampler(processGroupId));
      processTree.set(
        sessionId,
        Result.isSuccess(result)
          ? {
              ...result.success,
              available: true,
              sampleCount: previous.sampleCount + 1,
              memoryHighWaterBytes: Math.max(
                previous.memoryHighWaterBytes,
                result.success.memoryRssBytes,
              ),
            }
          : { ...previous, available: false, sampledAt: now() },
      );
    });
  const measurementsFor = (process: PreviewWebProcess): PreviewWebProcessMeasurements => ({
    sessionId: process.sessionId,
    revision: process.revision,
    port: process.port,
    pid: process.pid ?? null,
    startedAt: process.startedAt,
    readyAt: process.readyAt,
    startupDurationMs: process.startupDurationMs,
    lastEditDurationMs: process.lastEditDurationMs,
    editCount: process.editCount,
    processTree: processTree.get(process.sessionId) ?? emptyProcessTreeAttribution(),
  });
  const supervisorRequest = (
    record: SupervisorRecord,
    pathName: "status" | "stop" | "adopt",
    body?: unknown,
  ) =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const url = `${record.endpoint}/${pathName}`;
      const baseRequest =
        pathName === "status" ? HttpClientRequest.get(url) : HttpClientRequest.post(url);
      const request =
        body === undefined ? baseRequest : baseRequest.pipe(HttpClientRequest.bodyJsonUnsafe(body));
      return yield* httpClient
        .execute(
          request.pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${record.controlToken}`),
          ),
        )
        .pipe(
          Effect.timeout("3 seconds"),
          Effect.mapError(() => new PreviewWebRuntimeError({ reason: "supervisor-unavailable" })),
        );
    });
  const stopStaleSupervisor = (sessionId: string) =>
    Effect.gen(function* () {
      const latest = yield* readRecord(sessionId);
      if (latest === undefined) return;
      yield* terminateRecordedProcessGroup(latest);
      yield* removeRecord(sessionId);
    });
  const waitForRemoteStop = (sessionId: string) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const record = yield* Effect.result(readRecord(sessionId));
        if (Result.isFailure(record)) return false;
        if (record.success === undefined) return true;
        yield* Effect.sleep("100 millis");
      }
      return false;
    });
  const retainAdoptionHandler = (
    sessionId: string,
    handler:
      | NonNullable<Parameters<PreviewWebRuntimeApi["start"]>[0]["onSupervisorAdopt"]>
      | undefined,
  ) => {
    if (handler !== undefined) adoptionHandlers.set(sessionId, handler);
  };
  const rollbackFailedRecordWrite = (
    persisted: Result.Result<void, PreviewWebRuntimeError>,
    stopProcess: Effect.Effect<
      void,
      PreviewWebRuntimeError,
      FileSystem.FileSystem | HttpClient.HttpClient
    >,
    sessionId: string,
    preserveUnconfirmedCleanup: () => Effect.Effect<void, never, FileSystem.FileSystem>,
  ) => {
    if (Result.isSuccess(persisted)) return Effect.void;
    return Effect.gen(function* () {
      const cleanup = yield* Effect.result(stopProcess);
      if (Result.isFailure(cleanup)) yield* preserveUnconfirmedCleanup();
      running.delete(sessionId);
      children.delete(sessionId);
      adoptionHandlers.delete(sessionId);
      processTree.delete(sessionId);
      return yield* Effect.fail(persisted.failure);
    });
  };
  const stopRecordedSupervisor = (sessionId: string, record: SupervisorRecord) =>
    Effect.gen(function* () {
      const requested = yield* Effect.result(supervisorRequest(record, "stop"));
      if (Result.isFailure(requested)) return yield* stopStaleSupervisor(sessionId);
      if (requested.success.status !== 202)
        return yield* Effect.fail(
          new PreviewWebRuntimeError({ reason: "supervisor-stop-rejected" }),
        );
      if (yield* waitForRemoteStop(sessionId)) return;
      yield* stopStaleSupervisor(sessionId);
    });
  const captureProcessIdentity = (
    child: RunningProcess,
    revisionEndpoint: { readonly close: Effect.Effect<void, PreviewWebRuntimeError> },
    onUnconfirmedCleanup: () => Effect.Effect<void, PreviewWebRuntimeError, FileSystem.FileSystem>,
    onConfirmedCleanup: () => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      if (child.pid === undefined || child.processGroupId === undefined) return undefined;
      const identity = yield* Effect.result(processIdentityReader(child.pid, child.processGroupId));
      if (Result.isFailure(identity)) {
        const cleanup = yield* cleanupUnreadyWebProcess(
          child,
          revisionEndpoint,
          onUnconfirmedCleanup,
          onConfirmedCleanup,
        );
        return yield* failAfterUnreadyCleanup(cleanup, identity.failure);
      }
      return {
        processId: child.pid,
        processGroupId: child.processGroupId,
        processStartedAt: identity.success,
      };
    });
  const remoteMeasurements = (sessionId: string) =>
    Effect.gen(function* () {
      const record = yield* readRecord(sessionId);
      if (record === undefined) return undefined;
      const response = yield* supervisorRequest(record, "status");
      if (response.status < 200 || response.status >= 300) return undefined;
      const json = yield* response.json.pipe(
        Effect.mapError(
          () => new PreviewWebRuntimeError({ reason: "supervisor-response-invalid" }),
        ),
      );
      const decoded = Schema.decodeUnknownOption(PreviewWebProcessMeasurementsSchema)(json);
      return decoded._tag === "Some" ? decoded.value : undefined;
    }).pipe(Effect.catch(() => Effect.succeed(undefined)));
  const serveRevisionEvents = (
    sessionId: string,
    onSourceRevision: (revision: string) => Effect.Effect<void, Error>,
    onSupervisorAdopt?: (
      supervisorIdentity: string,
      generation: number,
    ) => Effect.Effect<void, Error>,
  ) =>
    Effect.gen(function* () {
      const runtimeContext = yield* Effect.context<FileSystem.FileSystem | HttpClient.HttpClient>();
      const runWithContext = Effect.runPromiseWith(runtimeContext);
      const revisionToken = randomBytes(32).toString("base64url");
      const controlToken = randomBytes(32).toString("base64url");
      let revisionQueue = Promise.resolve();
      let revisionAuthorityEpoch = 0;
      let revisionAuthorityFailedEpoch: number | undefined;
      let stopProcess: (() => Promise<void>) | undefined;
      const adoptSupervisor =
        onSupervisorAdopt === undefined
          ? undefined
          : (supervisorIdentity: string, generation: number) =>
              onSupervisorAdopt(supervisorIdentity, generation).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    revisionAuthorityEpoch += 1;
                    revisionAuthorityFailedEpoch = undefined;
                  }),
                ),
              );
      const handleStatus = (response: ServerResponse) => {
        const active = running.get(sessionId);
        if (active === undefined) response.writeHead(503).end();
        else {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(measurementsFor(active)));
        }
      };
      const handleStop = (response: ServerResponse) => {
        response.writeHead(202).end();
        setImmediate(() => {
          const stop = stopProcess;
          if (stop !== undefined) void stop().catch(() => undefined);
        });
      };
      const readBoundedRequestBody = (
        request: IncomingMessage,
        response: ServerResponse,
        onBody: (chunks: readonly Buffer[]) => void,
      ) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let rejected = false;
        request.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > 2048) {
            rejected = true;
            response.writeHead(413).end();
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        request.on("end", () => {
          if (rejected) return;
          onBody(chunks);
        });
      };
      const handleAdopt = (request: IncomingMessage, response: ServerResponse) => {
        readBoundedRequestBody(request, response, (chunks) => {
          let decoded: { supervisorIdentity: string; generation: number } | undefined;
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
            const result = Schema.decodeUnknownOption(
              Schema.Struct({
                supervisorIdentity: Schema.String.check(Schema.isMinLength(32)),
                generation: Schema.Int.check(Schema.isGreaterThan(0)),
              }),
            )(value);
            if (result._tag === "Some") decoded = result.value;
          } catch {
            decoded = undefined;
          }
          if (decoded === undefined || adoptSupervisor === undefined) {
            response.writeHead(503).end();
            return;
          }
          void runWithContext(adoptSupervisor(decoded.supervisorIdentity, decoded.generation)).then(
            () => {
              response.writeHead(204).end();
            },
            () => response.writeHead(503).end(),
          );
        });
      };
      const validateRevisionBody = (chunks: readonly Buffer[]) => {
        let value: unknown;
        try {
          value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        } catch {
          return undefined;
        }
        return Schema.decodeUnknownOption(
          Schema.Struct({
            revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
          }),
        )(value);
      };
      const queueRevision = (revision: string, response: ServerResponse) => {
        const editStartedAt = now();
        const authorityEpoch = revisionAuthorityEpoch;
        const operation = revisionQueue.then(async () => {
          if (revisionAuthorityFailedEpoch === authorityEpoch)
            throw new Error("source-revision-authority-ended");
          try {
            await runWithContext(onSourceRevision(revision));
          } catch (error) {
            if (authorityEpoch === revisionAuthorityEpoch)
              revisionAuthorityFailedEpoch = authorityEpoch;
            throw error;
          }
        });
        revisionQueue = operation.then(
          () => undefined,
          () => undefined,
        );
        void operation.then(
          () => {
            const active = running.get(sessionId);
            if (active !== undefined) {
              const readyAt = now();
              running.set(sessionId, {
                ...active,
                revision,
                readyAt,
                lastEditDurationMs: Math.max(0, readyAt - editStartedAt),
                editCount: active.editCount + 1,
              });
            }
            response.writeHead(204).end();
          },
          () => response.writeHead(503).end(),
        );
      };
      const handleRevision = (request: IncomingMessage, response: ServerResponse) =>
        readBoundedRequestBody(request, response, (chunks) => {
          const decoded = validateRevisionBody(chunks);
          if (decoded === undefined || decoded._tag === "None") {
            response.writeHead(400).end();
            return;
          }
          queueRevision(decoded.value.revision, response);
        });
      const routes = {
        "/status": {
          method: "GET",
          token: controlToken,
          handle: (_request: IncomingMessage, response: ServerResponse) => handleStatus(response),
        },
        "/stop": {
          method: "POST",
          token: controlToken,
          handle: (_request: IncomingMessage, response: ServerResponse) => handleStop(response),
        },
        "/adopt": { method: "POST", token: controlToken, handle: handleAdopt },
        "/revision": { method: "POST", token: revisionToken, handle: handleRevision },
      };
      const server: Server = createServer((request, response) => {
        const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        const route = routes[requestPath as keyof typeof routes];
        if (
          route === undefined ||
          request.method !== route.method ||
          request.headers.authorization !== `Bearer ${route.token}`
        ) {
          response.writeHead(404).end();
          return;
        }
        route.handle(request, response);
      });
      const address = yield* Effect.tryPromise({
        try: () =>
          new Promise<string>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
              server.off("error", reject);
              const bound = server.address();
              if (bound === null || typeof bound === "string")
                reject(new Error("revision-server-address-unavailable"));
              else resolve(`http://127.0.0.1:${bound.port}`);
            });
          }),
        catch: () => new PreviewWebRuntimeError({ reason: "revision-listener-start-failed" }),
      });
      return {
        server,
        endpoint: address,
        url: `${address}/revision`,
        revisionToken,
        controlToken,
        adoptSupervisor,
        setStopProcess: (stop: () => Promise<void>) => {
          stopProcess = stop;
        },
        close: Effect.tryPromise({
          try: () => new Promise<void>((resolve) => server.close(() => resolve())),
          catch: () => new PreviewWebRuntimeError({ reason: "revision-listener-stop-failed" }),
        }),
      };
    });
  const stop = (sessionId: string) =>
    Effect.gen(function* () {
      const unconfirmed = unconfirmedStarts.get(sessionId);
      if (unconfirmed !== undefined) {
        yield* unconfirmed.retryCleanup();
        unconfirmedStarts.delete(sessionId);
        adoptionHandlers.delete(sessionId);
        return;
      }
      const process = running.get(sessionId);
      if (process !== undefined) {
        yield* process.stop;
        running.delete(sessionId);
        children.delete(sessionId);
        adoptionHandlers.delete(sessionId);
        processTree.delete(sessionId);
        return;
      }
      const record = yield* readRecord(sessionId);
      if (record === undefined) return;
      yield* stopRecordedSupervisor(sessionId, record);
    });
  const remoteAvailability = (sessionId: string) =>
    Effect.gen(function* () {
      const record = yield* Effect.result(readRecord(sessionId));
      if (Result.isFailure(record)) return "transient-failure" as const;
      if (record.success === undefined) return "missing" as const;
      const response = yield* Effect.result(supervisorRequest(record.success, "status"));
      if (Result.isFailure(response)) return "transient-failure" as const;
      if (response.success.status === 503) return "missing" as const;
      if (response.success.status !== 200) return "transient-failure" as const;
      const json = yield* Effect.result(response.success.json);
      if (Result.isFailure(json)) return "transient-failure" as const;
      const decoded = Schema.decodeUnknownOption(PreviewWebProcessMeasurementsSchema)(json.success);
      if (decoded._tag === "None") return "transient-failure" as const;
      return (yield* probeWeb(readiness, decoded.value.port))
        ? ("ready" as const)
        : ("transient-failure" as const);
    }).pipe(Effect.catch(() => Effect.succeed("transient-failure" as const)));
  const start: PreviewWebRuntimeApi["start"] = (input) => {
    let interruptCleanup: Effect.Effect<
      void,
      PreviewWebRuntimeError,
      FileSystem.FileSystem | HttpClient.HttpClient
    > = Effect.void;
    return Effect.gen(function* () {
      const runtimeContext = yield* Effect.context<FileSystem.FileSystem | HttpClient.HttpClient>();
      const runWithContext = Effect.runPromiseWith(runtimeContext);
      if (hasActiveStart(input.sessionId))
        return yield* Effect.fail(
          new PreviewWebRuntimeError({ reason: "supervisor-already-running" }),
        );
      const request = makePreviewWebProcessRequest(input);
      if (request === undefined)
        return yield* Effect.fail(
          new PreviewWebRuntimeError({ reason: "invalid-web-runtime-input" }),
        );
      const port = yield* Effect.tryPromise({
        try: () => portChecker(input.port),
        catch: () => new PreviewWebRuntimeError({ reason: "listener-check-failed" }),
      });
      if (!port.available)
        return yield* Effect.fail(new PreviewWebRuntimeError({ reason: "listener-port-occupied" }));
      const revisionEndpoint = yield* serveRevisionEvents(
        input.sessionId,
        input.onSourceRevision,
        input.onSupervisorAdopt,
      );
      const processRequest = {
        ...request,
        env: {
          ...request.env,
          TIARA_PREVIEW_REVISION_URL: revisionEndpoint.url,
          TIARA_PREVIEW_REVISION_TOKEN: revisionEndpoint.revisionToken,
        },
      };
      const child = yield* Effect.tryPromise({
        try: (signal) => starter(processRequest, signal),
        catch: () => new PreviewWebRuntimeError({ reason: "web-process-start-failed" }),
      }).pipe(Effect.tapError(() => revisionEndpoint.close));
      let removeSignalHandlers = () => undefined;
      const retryUnconfirmedCleanup = () =>
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: child.kill,
            catch: () => new PreviewWebRuntimeError({ reason: "web-process-cleanup-failed" }),
          });
          yield* removeRecord(input.sessionId);
          yield* revisionEndpoint.close;
          yield* Effect.sync(removeSignalHandlers);
        });
      const onUnconfirmedCleanup = () =>
        Effect.gen(function* () {
          unconfirmedStarts.set(input.sessionId, { retryCleanup: retryUnconfirmedCleanup });
          yield* writeRecord({
            sessionId: input.sessionId,
            endpoint: revisionEndpoint.endpoint,
            controlToken: revisionEndpoint.controlToken,
          });
        });
      const onConfirmedCleanup = () => Effect.sync(removeSignalHandlers);
      let stopForSignal: Effect.Effect<
        void,
        PreviewWebRuntimeError,
        FileSystem.FileSystem | HttpClient.HttpClient
      > = cleanupUnreadyWebProcess(
        child,
        revisionEndpoint,
        onUnconfirmedCleanup,
        onConfirmedCleanup,
      ).pipe(Effect.asVoid);
      const onInterrupt = () => {
        void runWithContext(stopForSignal);
      };
      const onTerminate = () => {
        void runWithContext(stopForSignal);
      };
      const removeParentExitHandler = registerParentExitCleanup(child.pid);
      globalThis.process.once("SIGINT", onInterrupt);
      globalThis.process.once("SIGTERM", onTerminate);
      removeSignalHandlers = () => {
        globalThis.process.off("SIGINT", onInterrupt);
        globalThis.process.off("SIGTERM", onTerminate);
        removeParentExitHandler();
      };
      interruptCleanup = cleanupUnreadyWebProcess(
        child,
        revisionEndpoint,
        onUnconfirmedCleanup,
        onConfirmedCleanup,
      ).pipe(Effect.asVoid);
      const startedAt = yield* ensureWebProcessReady(
        child,
        revisionEndpoint,
        readiness,
        input.port,
        now,
        options.startupTimeoutMs ?? 30_000,
        options.pollIntervalMs ?? 100,
        onUnconfirmedCleanup,
        onConfirmedCleanup,
      );
      const processIdentity = yield* captureProcessIdentity(
        child,
        revisionEndpoint,
        onUnconfirmedCleanup,
        onConfirmedCleanup,
      );
      const supervisorRecord = makeSupervisorRecord(
        input.sessionId,
        revisionEndpoint,
        processIdentity,
      );
      const stopProcess = Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: child.kill,
          catch: () => new PreviewWebRuntimeError({ reason: "web-process-cleanup-failed" }),
        });
        if (processIdentity !== undefined) yield* terminateRecordedProcessGroup(supervisorRecord);
        yield* Effect.sync(removeSignalHandlers);
        // Once child.kill resolves, ownership cleanup is complete; publish that before closing
        // the loopback endpoint so a separate stop command can distinguish success from a crash.
        yield* removeRecord(input.sessionId);
        yield* revisionEndpoint.close;
      });
      const preserveUnconfirmedRecordWrite = () =>
        Effect.gen(function* () {
          unconfirmedStarts.set(input.sessionId, { retryCleanup: () => stopProcess });
          yield* Effect.result(writeRecord(supervisorRecord));
          yield* Effect.result(revisionEndpoint.close);
        });
      interruptCleanup = Effect.gen(function* () {
        const cleanup = yield* Effect.result(stopProcess);
        if (Result.isFailure(cleanup)) yield* preserveUnconfirmedRecordWrite();
        running.delete(input.sessionId);
        children.delete(input.sessionId);
        adoptionHandlers.delete(input.sessionId);
        processTree.delete(input.sessionId);
        if (Result.isSuccess(cleanup)) unconfirmedStarts.delete(input.sessionId);
      });
      stopForSignal = stopProcess;
      const process: PreviewWebProcess = {
        sessionId: input.sessionId,
        revision: input.revision,
        port: input.port,
        pid: child.pid,
        startedAt,
        readyAt: now(),
        startupDurationMs: Math.max(0, now() - startedAt),
        lastEditDurationMs: null,
        editCount: 0,
        stop: stopProcess,
      };
      running.set(input.sessionId, process);
      children.set(input.sessionId, child);
      retainAdoptionHandler(input.sessionId, revisionEndpoint.adoptSupervisor);
      yield* recordProcessTreeSample(input.sessionId, child.pid);
      yield* Effect.gen(function* () {
        while (children.get(input.sessionId) === child) {
          yield* Effect.sleep(options.processTreeSamplingIntervalMs ?? 1_000);
          if (children.get(input.sessionId) === child)
            yield* recordProcessTreeSample(input.sessionId, child.pid);
        }
      }).pipe(Effect.forkDetach);
      const persisted = yield* Effect.result(writeRecord(supervisorRecord));
      yield* rollbackFailedRecordWrite(
        persisted,
        stopProcess,
        input.sessionId,
        preserveUnconfirmedRecordWrite,
      );
      revisionEndpoint.setStopProcess(() => runWithContext(stop(input.sessionId)));
      watchProcessExit(
        input.sessionId,
        child,
        supervisorRecord,
        removeSignalHandlers,
        revisionEndpoint,
        runtimeContext,
      );
      return process;
    }).pipe(Effect.onInterrupt(() => interruptCleanup));
  };
  return {
    start,
    stop,
    status: (sessionId: string) =>
      Effect.gen(function* () {
        const local = running.get(sessionId);
        const measurements = local ?? (yield* remoteMeasurements(sessionId));
        return measurements === undefined ? false : yield* probeWeb(readiness, measurements.port);
      }),
    measurements: (sessionId: string) =>
      Effect.gen(function* () {
        const local = running.get(sessionId);
        if (local !== undefined) return measurementsFor(local);
        return yield* remoteMeasurements(sessionId);
      }),
    adoptSupervisor: (sessionId: string, supervisorIdentity: string, generation: number) =>
      Effect.gen(function* () {
        const local = running.get(sessionId);
        if (local !== undefined) {
          if (inputIsInvalidSupervisorAdoption(supervisorIdentity, generation))
            return yield* Effect.fail(
              new PreviewWebRuntimeError({ reason: "invalid-supervisor-adoption" }),
            );
          const adopt = adoptionHandlers.get(sessionId);
          if (adopt === undefined)
            return yield* Effect.fail(
              new PreviewWebRuntimeError({ reason: "supervisor-adoption-rejected" }),
            );
          const adopted = yield* Effect.result(adopt(supervisorIdentity, generation));
          if (Result.isFailure(adopted))
            return yield* Effect.fail(
              new PreviewWebRuntimeError({ reason: "supervisor-adoption-rejected" }),
            );
          return;
        }
        const record = yield* readRecord(sessionId);
        if (record === undefined)
          return yield* Effect.fail(
            new PreviewWebRuntimeError({ reason: "supervisor-record-unavailable" }),
          );
        const response = yield* supervisorRequest(record, "adopt", {
          supervisorIdentity,
          generation,
        });
        if (response.status !== 204)
          return yield* Effect.fail(
            new PreviewWebRuntimeError({ reason: "supervisor-adoption-rejected" }),
          );
      }),
    availability: (sessionId: string) =>
      Effect.suspend(() => {
        const local = running.get(sessionId);
        return local === undefined
          ? remoteAvailability(sessionId)
          : probeWeb(readiness, local.port).pipe(
              Effect.map((reachable) =>
                reachable ? ("ready" as const) : ("transient-failure" as const),
              ),
            );
      }),
  } satisfies PreviewWebRuntimeApi;
};

const inputIsInvalidSupervisorAdoption = (supervisorIdentity: string, generation: number) =>
  supervisorIdentity.length < 32 || !Number.isSafeInteger(generation) || generation < 1;

const probeWeb = (readiness: ReadinessChecker, port: number) =>
  Effect.tryPromise({
    try: () =>
      readiness({
        mode: "fast",
        dependency: "sheet-web",
        origin: `http://127.0.0.1:${port}/ready`,
        timeoutMs: 1_000,
        optional: false,
      }),
    catch: () => new Error("web-readiness-probe-failed"),
  }).pipe(
    Effect.map(
      (result) =>
        result.reachable &&
        result.status !== undefined &&
        result.status >= 200 &&
        result.status < 300,
    ),
    Effect.catch(() => Effect.succeed(false)),
  );
