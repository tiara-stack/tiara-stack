import { Cause, Duration, Effect, Exit, Match, Option, Schema } from "effect";
import path from "node:path";
import { checkHttpAccess, checkHttpReadiness, checkTcpAccess, isHttpReady } from "./access";
import {
  executeCompose,
  type ComposeExecutionContext,
  type ComposeExecutionResult,
  type ComposeStateAdapter,
} from "./compose-execution";
import type { KubernetesModeConfig } from "./config";
import { makeDiagnostic, makeWarning } from "./diagnostics";
import {
  currentProcessExit,
  makeExecutionResultFromContext,
  observeProcessExit,
  processSignals,
  reasonFields,
  redactExecutionText,
  statusCodeFields,
  terminalOutput,
  type ProcessExitObservation,
} from "./execution-shared";
import { spawnProcess, startLongLivedProcess } from "./executor";
import type { DevelopmentLifecycleObservationType } from "./lifecycle-types";
import type { ModePlan } from "./plan";
import { fastServices } from "./types";
import type {
  AccessCheckResult,
  AccessChecker,
  Diagnostic,
  FastService,
  KubernetesAction,
  LauncherOutput,
  ProcessExecutor,
  ProcessRequest,
  ProcessResult,
  ProcessStarter,
  PlannedProcess,
  ReadinessState,
  ReadinessChecker,
  RunningProcess,
  TcpAccessChecker,
} from "./types";

const defaultDependencyTimeoutMs = 2_000;
const defaultStartupTimeoutMs = 30_000;
const defaultReadinessTimeoutMs = 30_000;
const defaultCleanupTimeoutMs = 2_000;
const defaultPollIntervalMs = 100;

export type FastPrerequisiteKind = "http-access" | "http-ready" | "tcp-access";

export interface FastPrerequisite {
  readonly dependency: string;
  readonly origin: string;
  readonly kind: FastPrerequisiteKind;
  readonly timeoutMs: number;
  readonly optional: boolean;
}

export interface FastReadinessTarget {
  readonly dependency: FastService;
  readonly origin: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}

/** The executable context shared by the terminal adapter and tests. */
export interface FastExecutionContext {
  readonly mode: "fast";
  readonly action: "up";
  readonly selectedService: FastService;
  readonly processRequest: ProcessRequest;
  readonly prerequisites: readonly FastPrerequisite[];
  readonly readiness: FastReadinessTarget;
  readonly plannedOutput: LauncherOutput;
}

type LifecycleObservationDetail =
  | {
      readonly type: "validated";
    }
  | {
      readonly type: "prerequisite";
      readonly dependency: string;
      readonly origin: string;
      readonly kind: FastPrerequisiteKind;
      readonly status: "checking" | "passed" | "failed";
      readonly responseStatus?: number;
      readonly reason?: string;
    }
  | {
      readonly type: "started";
      readonly pid?: number;
    }
  | {
      readonly type: "readiness";
      readonly status: "ready" | "blocked";
      readonly origin: string;
      readonly responseStatus?: number;
      readonly reason?: string;
    }
  | {
      readonly type: "exited";
      readonly phase: "startup" | "running";
      readonly exitCode: number;
    }
  | {
      readonly type: "cleanup";
      readonly status: "started" | "completed" | "failed";
      readonly reason?: string;
    }
  | {
      readonly type: "terminal";
      readonly outcome: FastExecutionOutcomeStatus;
      readonly exitCode: number;
      readonly readiness?: ReadinessState;
      readonly diagnostics?: readonly Diagnostic[];
      readonly warnings?: readonly Diagnostic[];
    };

export type LifecycleObservation = LifecycleObservationDetail & {
  readonly sequence: number;
  readonly mode: "fast";
  readonly action: "up";
  readonly service: FastService;
};

export type FastExecutionOutcomeStatus = "completed" | "stopped" | "blocked" | "failed";

export interface FastExecutionOutcome {
  readonly status: FastExecutionOutcomeStatus;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly diagnostic?: Diagnostic;
  readonly cleanupDiagnostic?: Diagnostic;
}

export interface FastExecutionResult {
  readonly output: LauncherOutput;
  readonly observations: readonly LifecycleObservation[];
  readonly outcome: FastExecutionOutcome;
  readonly readyOutput?: LauncherOutput;
}

export type KubernetesExecutionPhase = "validation" | "pre-preview" | "preview" | "post-preview";

export interface KubernetesExecutionTarget {
  readonly context: string;
  readonly namespace: string;
  readonly release: string;
  readonly registry: string;
  readonly imageTag: string | null;
  readonly kubeconfig?: string;
}

export interface KubernetesExecutionStep {
  readonly id: string;
  readonly phase: KubernetesExecutionPhase;
  readonly planned: PlannedProcess;
  readonly request: ProcessRequest;
}

/** Private execution data derived from validated Kubernetes configuration. */
export interface KubernetesExecutionContext {
  readonly mode: "kubernetes";
  readonly action: Extract<KubernetesAction, "validate" | "preview">;
  readonly target: KubernetesExecutionTarget;
  readonly steps: readonly KubernetesExecutionStep[];
  readonly plannedOutput: LauncherOutput;
}

export type KubernetesLifecycleObservationDetail =
  | { readonly type: "validated" }
  | {
      readonly type: "step";
      readonly id: string;
      readonly phase: KubernetesExecutionPhase;
      readonly status: "started" | "completed" | "failed" | "stopped";
      readonly exitCode?: number;
      readonly reason?: string;
    }
  | {
      readonly type: "cleanup";
      readonly status: "started" | "completed" | "failed";
      readonly reason?: string;
    }
  | {
      readonly type: "terminal";
      readonly outcome: FastExecutionOutcomeStatus;
      readonly exitCode: number;
      readonly readiness?: ReadinessState;
      readonly diagnostics?: readonly Diagnostic[];
      readonly warnings?: readonly Diagnostic[];
    };

export type KubernetesLifecycleObservation = KubernetesLifecycleObservationDetail & {
  readonly sequence: number;
  readonly mode: "kubernetes";
  readonly action: Extract<KubernetesAction, "validate" | "preview">;
  readonly service: "kubernetes";
};

export interface KubernetesExecutionOutcome {
  readonly status: FastExecutionOutcomeStatus;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly diagnostic?: Diagnostic;
  readonly cleanupDiagnostic?: Diagnostic;
}

export interface KubernetesExecutionResult {
  readonly output: LauncherOutput;
  readonly observations: readonly KubernetesLifecycleObservation[];
  readonly outcome: KubernetesExecutionOutcome;
}

export type DevelopmentLifecycleObservation = DevelopmentLifecycleObservationType;
export type DevelopmentExecutionContext =
  | FastExecutionContext
  | ComposeExecutionContext
  | KubernetesExecutionContext;
export type DevelopmentExecutionResult =
  | FastExecutionResult
  | ComposeExecutionResult
  | KubernetesExecutionResult;

export interface KubernetesExecutionOptions {
  readonly executor?: ProcessExecutor;
  readonly processStarter?: ProcessStarter;
  readonly interruptions?: Effect.Effect<NodeJS.Signals>;
  readonly startupTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly output?: "inherit" | "stderr" | "capture";
  readonly onObservation?: (observation: KubernetesLifecycleObservation) => void;
}

export interface DevelopmentExecutionOptions {
  readonly accessChecker?: AccessChecker;
  readonly readinessChecker?: ReadinessChecker;
  readonly tcpAccessChecker?: TcpAccessChecker;
  readonly processStarter?: ProcessStarter;
  readonly executor?: ProcessExecutor;
  readonly interruptions?: Effect.Effect<NodeJS.Signals>;
  readonly dependencyTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly readinessTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly finiteTimeoutMs?: number;
  readonly stateAdapter?: ComposeStateAdapter;
  readonly output?: "inherit" | "stderr" | "capture";
  readonly onObservation?: (observation: DevelopmentLifecycleObservation) => void;
}

export interface FastExecutionOptions {
  readonly accessChecker?: AccessChecker;
  readonly readinessChecker?: ReadinessChecker;
  readonly tcpAccessChecker?: TcpAccessChecker;
  readonly processStarter?: ProcessStarter;
  readonly interruptions?: Effect.Effect<NodeJS.Signals>;
  readonly dependencyTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly readinessTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly output?: "inherit" | "stderr" | "capture";
  readonly onObservation?: (observation: LifecycleObservation) => void;
}

type PrerequisitePhase = {
  readonly errors: readonly Diagnostic[];
  readonly warnings: readonly Diagnostic[];
};

type ProcessPhase =
  | { readonly type: "stopped"; readonly signal: NodeJS.Signals }
  | {
      readonly type: "startup-exit";
      readonly result: ProcessResult;
      readonly readinessResult?: AccessCheckResult;
    }
  | { readonly type: "ready" }
  | { readonly type: "running-exit"; readonly result: ProcessResult };

type CleanupState = {
  diagnostic?: Diagnostic;
};

type ExecutionState = {
  sequence: number;
  observations: LifecycleObservation[];
};

class FastStartupTimeout extends Error {
  readonly _tag = "FastStartupTimeout";
}

const FastServiceSchema = Schema.Literals(fastServices);
const isFastService = Schema.is(FastServiceSchema);

const withoutTrailingSlash = (origin: string) => origin.replace(/\/$/, "");

const safeOrigin = (value: string) => {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "<invalid endpoint>";
  }
};

const withReadyPath = (origin: string) => `${withoutTrailingSlash(origin)}/ready`;

const withJwksPath = (origin: string) => `${withoutTrailingSlash(origin)}/jwks`;

const requiredEnvironment = (
  environment: Readonly<Record<string, string>>,
  key: string,
  service: FastService,
) => {
  const value = environment[key];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Fast execution context is missing ${key} for ${service}`);
  }
  return value;
};

const urlFor = (output: LauncherOutput, name: string) => {
  const plannedUrl = output.urls.find((url) => url.name === name);
  if (plannedUrl === undefined)
    throw new Error(`Fast execution context is missing the ${name} URL`);
  return plannedUrl.url;
};

const fastReadinessUrlNames = {
  "sheet-web": "app",
  "sheet-auth": "sheet-auth",
  "sheet-db-server": "sheet-db-server",
  "sheet-workflows": "sheet-workflows",
  "sheet-bot": "sheet-bot",
} as const satisfies Readonly<Record<FastService, string>>;

const httpPrerequisite = (
  dependency: string,
  origin: string,
  timeoutMs: number,
  optional = false,
): FastPrerequisite => ({
  dependency,
  origin,
  kind: "http-access",
  timeoutMs,
  optional,
});

const httpReadyPrerequisite = (
  dependency: string,
  origin: string,
  timeoutMs: number,
  optional = false,
): FastPrerequisite => ({
  dependency,
  origin,
  kind: "http-ready",
  timeoutMs,
  optional,
});

const tcpPrerequisite = (
  dependency: string,
  origin: string,
  timeoutMs: number,
  optional = false,
): FastPrerequisite => ({
  dependency,
  origin,
  kind: "tcp-access",
  timeoutMs,
  optional,
});

const fastPrerequisites = (
  selectedService: FastService,
  output: LauncherOutput,
  environment: Readonly<Record<string, string>>,
  timeoutMs: number,
): readonly FastPrerequisite[] =>
  Match.value(selectedService).pipe(
    Match.when("sheet-web", () => [
      httpPrerequisite("auth", urlFor(output, "auth"), timeoutMs),
      httpPrerequisite("zero", urlFor(output, "zero"), timeoutMs),
      httpPrerequisite("workflows", urlFor(output, "workflows"), timeoutMs),
    ]),
    Match.when("sheet-auth", () => [
      tcpPrerequisite(
        "postgres",
        requiredEnvironment(environment, "POSTGRES_URL", selectedService),
        timeoutMs,
      ),
      tcpPrerequisite(
        "redis",
        requiredEnvironment(environment, "REDIS_URL", selectedService),
        timeoutMs,
      ),
      httpPrerequisite(
        "sheet-auth JWKS",
        requiredEnvironment(environment, "SHEET_AUTH_OAUTH_JWKS_URL", selectedService),
        timeoutMs,
      ),
    ]),
    Match.when("sheet-db-server", () => [
      tcpPrerequisite(
        "postgres",
        requiredEnvironment(environment, "POSTGRES_URL", selectedService),
        timeoutMs,
      ),
      httpReadyPrerequisite(
        "sheet-auth",
        withReadyPath(requiredEnvironment(environment, "SHEET_AUTH_ISSUER", selectedService)),
        timeoutMs,
      ),
    ]),
    Match.when("sheet-workflows", () => {
      const issuer = requiredEnvironment(environment, "SHEET_AUTH_ISSUER", selectedService);
      const prerequisites: FastPrerequisite[] = [
        tcpPrerequisite(
          "postgres",
          requiredEnvironment(environment, "POSTGRES_URL", selectedService),
          timeoutMs,
        ),
        httpReadyPrerequisite("sheet-auth", withReadyPath(issuer), timeoutMs),
        httpPrerequisite("sheet-auth JWKS", withJwksPath(issuer), timeoutMs),
      ];
      if (environment.SHEET_WORKFLOWS_ROLE === "api") {
        const runnerHost = requiredEnvironment(
          environment,
          "WORKFLOWS_RUNNER_HOST",
          selectedService,
        );
        const runnerPort = requiredEnvironment(
          environment,
          "WORKFLOWS_RUNNER_PORT",
          selectedService,
        );
        prerequisites.push(
          httpReadyPrerequisite(
            "sheet-workflows runner",
            withReadyPath(`http://${runnerHost}:${runnerPort}`),
            timeoutMs,
          ),
        );
      }
      return prerequisites;
    }),
    Match.when("sheet-bot", () => [
      tcpPrerequisite(
        "redis",
        requiredEnvironment(environment, "REDIS_URL", selectedService),
        timeoutMs,
      ),
      httpReadyPrerequisite(
        "sheet-auth",
        withReadyPath(requiredEnvironment(environment, "SHEET_AUTH_ISSUER", selectedService)),
        timeoutMs,
      ),
      httpPrerequisite(
        "sheet-zero-cache",
        requiredEnvironment(environment, "ZERO_CACHE_SERVER", selectedService),
        timeoutMs,
      ),
      httpReadyPrerequisite(
        "sheet-workflows",
        withReadyPath(
          requiredEnvironment(environment, "SHEET_WORKFLOWS_BASE_URL", selectedService),
        ),
        timeoutMs,
      ),
      httpPrerequisite(
        "sheet-web",
        requiredEnvironment(environment, "SHEET_WEB_BASE_URL", selectedService),
        timeoutMs,
      ),
    ]),
    Match.exhaustive,
  );

export const makeFastExecutionContext = (
  output: LauncherOutput,
  cwd: string,
  options: Pick<
    FastExecutionOptions,
    "dependencyTimeoutMs" | "startupTimeoutMs" | "readinessTimeoutMs" | "pollIntervalMs"
  > = {},
): FastExecutionContext => {
  if (!output.ok || output.mode !== "fast" || output.action !== "up") {
    throw new Error("Fast execution requires a valid Fast up plan");
  }
  if (output.selectedServices.length !== 1) {
    throw new Error("Fast execution requires exactly one selected service");
  }
  const selectedService = output.selectedServices[0];
  if (selectedService === undefined || !isFastService(selectedService)) {
    throw new Error("Fast execution has an invalid selected service");
  }
  const planned = output.plannedProcesses.find(({ id }) => id === selectedService);
  if (planned === undefined || planned.packageName !== selectedService) {
    throw new Error(`Fast execution has no executable plan for ${selectedService}`);
  }
  const processRequest: ProcessRequest = {
    command: planned.command,
    args: planned.args,
    cwd: path.resolve(cwd, "packages", planned.packageName),
    env: planned.environment,
    timeoutMs: options.startupTimeoutMs ?? defaultStartupTimeoutMs,
    kind: "runtime",
    readOnly: false,
  };
  const readinessOrigin = urlFor(output, fastReadinessUrlNames[selectedService]);
  const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
  return {
    mode: "fast",
    action: "up",
    selectedService,
    processRequest,
    prerequisites: fastPrerequisites(
      selectedService,
      output,
      planned.environment,
      options.dependencyTimeoutMs ?? defaultDependencyTimeoutMs,
    ),
    readiness: {
      dependency: selectedService,
      origin: withReadyPath(readinessOrigin),
      timeoutMs: options.readinessTimeoutMs ?? defaultReadinessTimeoutMs,
      pollIntervalMs: pollIntervalMs < 0 ? 0 : pollIntervalMs,
    },
    plannedOutput: output,
  };
};

const notify = (
  state: ExecutionState,
  context: FastExecutionContext,
  observation: LifecycleObservationDetail,
  observer?: (observation: LifecycleObservation) => void,
) =>
  Effect.sync(() => {
    const next = {
      sequence: state.sequence + 1,
      mode: context.mode,
      action: context.action,
      service: context.selectedService,
      ...observation,
    } as LifecycleObservation;
    state.sequence = next.sequence;
    state.observations.push(next);
    observer?.(next);
  });

const checkPrerequisite = (
  prerequisite: FastPrerequisite,
  accessChecker: AccessChecker,
  readinessChecker: ReadinessChecker,
  tcpAccessChecker: TcpAccessChecker,
) => {
  const request = {
    mode: "fast" as const,
    dependency: prerequisite.dependency,
    origin: prerequisite.origin,
    timeoutMs: prerequisite.timeoutMs,
    optional: prerequisite.optional,
  };
  return Effect.tryPromise(() =>
    Match.value(prerequisite.kind).pipe(
      Match.when("tcp-access", () => tcpAccessChecker(prerequisite.origin, prerequisite.timeoutMs)),
      Match.when("http-ready", () => readinessChecker(request)),
      Match.when("http-access", () => accessChecker(request)),
      Match.exhaustive,
    ),
  ).pipe(
    Effect.catch(() =>
      Effect.succeed({
        reachable: false,
        reason: "dependency check failed",
      } satisfies AccessCheckResult),
    ),
  );
};

const prerequisiteDiagnostic = (
  context: FastExecutionContext,
  prerequisite: FastPrerequisite,
  result: AccessCheckResult,
) =>
  makeDiagnostic(
    result.timedOut ? "dependency-timeout" : "access-failed",
    `${prerequisite.dependency} at ${safeOrigin(prerequisite.origin)} did not pass its ${prerequisite.kind} check${result.status === undefined ? "" : ` (HTTP ${result.status})`}`,
    `Check the approved Fast dependency endpoint for ${context.selectedService} and retry.`,
    {
      mode: context.mode,
      action: context.action,
      dependency: prerequisite.dependency,
      origin: safeOrigin(prerequisite.origin),
    },
  );

interface PrerequisiteReport {
  readonly error: Diagnostic | undefined;
  readonly warning: Diagnostic | undefined;
}

const prerequisiteReport = (
  context: FastExecutionContext,
  prerequisite: FastPrerequisite,
  result: AccessCheckResult,
  state: ExecutionState,
  observer?: (observation: LifecycleObservation) => void,
): Effect.Effect<PrerequisiteReport> => {
  const failure = result.reachable
    ? undefined
    : prerequisiteDiagnostic(context, prerequisite, result);
  return notify(
    state,
    context,
    {
      type: "prerequisite",
      dependency: prerequisite.dependency,
      origin: safeOrigin(prerequisite.origin),
      kind: prerequisite.kind,
      status: result.reachable ? "passed" : "failed",
      ...statusCodeFields(result),
      ...reasonFields(result),
    },
    observer,
  ).pipe(
    Effect.as({
      error: prerequisite.optional ? undefined : failure,
      warning:
        prerequisite.optional && failure !== undefined
          ? makeWarning(failure.code, failure.message, failure.remediation, failure)
          : undefined,
    }),
  );
};

const collectPrerequisiteReports = (reports: readonly PrerequisiteReport[]): PrerequisitePhase =>
  reports.reduce(
    (phase, report) => ({
      errors: report.error === undefined ? phase.errors : [...phase.errors, report.error],
      warnings: report.warning === undefined ? phase.warnings : [...phase.warnings, report.warning],
    }),
    { errors: [] as Diagnostic[], warnings: [] as Diagnostic[] },
  );

const runPrerequisites = (
  context: FastExecutionContext,
  options: FastExecutionOptions,
  state: ExecutionState,
): Effect.Effect<PrerequisitePhase> =>
  Effect.gen(function* () {
    const accessChecker = options.accessChecker ?? checkHttpAccess;
    const readinessChecker = options.readinessChecker ?? checkHttpReadiness;
    const tcpAccessChecker = options.tcpAccessChecker ?? checkTcpAccess;
    yield* Effect.forEach(
      context.prerequisites,
      (prerequisite) =>
        notify(
          state,
          context,
          {
            type: "prerequisite",
            dependency: prerequisite.dependency,
            origin: safeOrigin(prerequisite.origin),
            kind: prerequisite.kind,
            status: "checking",
          },
          options.onObservation,
        ),
      { discard: true },
    );
    const checks = yield* Effect.all(
      context.prerequisites.map((prerequisite) =>
        checkPrerequisite(prerequisite, accessChecker, readinessChecker, tcpAccessChecker),
      ),
      { concurrency: "unbounded" },
    );
    const reports = yield* Effect.forEach(context.prerequisites, (prerequisite, index) =>
      prerequisiteReport(
        context,
        prerequisite,
        checks[index] ?? { reachable: false, reason: "dependency check failed" },
        state,
        options.onObservation,
      ),
    );
    return collectPrerequisiteReports(reports);
  });

const readinessDiagnostic = (context: FastExecutionContext, result?: AccessCheckResult) =>
  makeDiagnostic(
    "dependency-timeout",
    `${context.selectedService} did not become ready at ${safeOrigin(context.readiness.origin)}${
      result?.status === undefined ? "" : ` (HTTP ${result.status})`
    }`,
    `Fix ${context.selectedService} startup and make GET ${safeOrigin(context.readiness.origin)}/ready return a 2xx response before the readiness deadline.`,
    {
      mode: context.mode,
      action: context.action,
      dependency: context.selectedService,
      origin: safeOrigin(context.readiness.origin),
    },
  );

type ReadinessProbe =
  | { readonly type: "exited"; readonly exit: ProcessResult }
  | { readonly type: "check"; readonly check: AccessCheckResult };

const startupExit = (
  context: FastExecutionContext,
  options: FastExecutionOptions,
  state: ExecutionState,
  result: ProcessResult,
) =>
  notify(
    state,
    context,
    { type: "exited", phase: "startup", exitCode: result.exitCode },
    options.onObservation,
  ).pipe(Effect.as({ type: "startup-exit" as const, result } satisfies ProcessPhase));

const readinessProbe = (
  context: FastExecutionContext,
  options: FastExecutionOptions,
  processExit: ProcessExitObservation,
  timeoutMs: number,
): Effect.Effect<ReadinessProbe> => {
  const readinessChecker = options.readinessChecker ?? checkHttpReadiness;
  const check = Effect.tryPromise(() =>
    readinessChecker({
      mode: context.mode,
      dependency: context.readiness.dependency,
      origin: context.readiness.origin,
      timeoutMs,
      optional: false,
    }),
  ).pipe(
    Effect.catch(() =>
      Effect.succeed({
        reachable: false,
        reason: "readiness check failed",
      } satisfies AccessCheckResult),
    ),
    Effect.map((result) => ({ type: "check" as const, check: result })),
  );
  return Effect.raceFirst(
    processExit.effect.pipe(Effect.map((exit) => ({ type: "exited" as const, exit }))),
    check,
  );
};

const readyOrStartupExit = (
  context: FastExecutionContext,
  options: FastExecutionOptions,
  processExit: ProcessExitObservation,
  state: ExecutionState,
  result: AccessCheckResult,
): Effect.Effect<ProcessPhase> =>
  Effect.gen(function* () {
    yield* Effect.yieldNow;
    const exitedBeforeReady = currentProcessExit(processExit);
    if (exitedBeforeReady !== undefined) {
      return yield* startupExit(context, options, state, exitedBeforeReady);
    }
    yield* notify(
      state,
      context,
      {
        type: "readiness",
        status: "ready",
        origin: safeOrigin(context.readiness.origin),
        ...statusCodeFields(result),
      },
      options.onObservation,
    );
    return { type: "ready" } satisfies ProcessPhase;
  });

const waitForNextReadinessProbe = (deadline: number, pollIntervalMs: number) => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Effect.succeed(false);
  const pause = Math.min(pollIntervalMs, remaining);
  return pause > 0
    ? Effect.sleep(Duration.millis(pause)).pipe(Effect.as(true))
    : Effect.succeed(true);
};

const waitForReadiness = (
  context: FastExecutionContext,
  options: FastExecutionOptions,
  running: RunningProcess,
  state: ExecutionState,
): Effect.Effect<ProcessPhase> =>
  // fallow-ignore-next-line complexity
  Effect.gen(function* () {
    const processExit = observeProcessExit(running);
    const deadline = Date.now() + context.readiness.timeoutMs;
    let lastResult: AccessCheckResult | undefined;
    while (Date.now() < deadline) {
      const currentExit = currentProcessExit(processExit);
      if (currentExit !== undefined) {
        return yield* startupExit(context, options, state, currentExit);
      }
      const result = yield* readinessProbe(
        context,
        options,
        processExit,
        Math.min(1_000, deadline - Date.now()),
      );
      if (result.type === "exited") {
        return yield* startupExit(context, options, state, result.exit);
      }
      lastResult = result.check;
      if (isHttpReady(result.check))
        return yield* readyOrStartupExit(context, options, processExit, state, result.check);
      if (!(yield* waitForNextReadinessProbe(deadline, context.readiness.pollIntervalMs))) break;
    }
    yield* notify(
      state,
      context,
      {
        type: "readiness",
        status: "blocked",
        origin: safeOrigin(context.readiness.origin),
        ...(lastResult === undefined ? {} : statusCodeFields(lastResult)),
        ...(lastResult?.reason === undefined ? {} : { reason: lastResult.reason }),
      },
      options.onObservation,
    );
    return {
      type: "startup-exit",
      result: { exitCode: 1, timedOut: true } satisfies ProcessResult,
      ...(lastResult === undefined ? {} : { readinessResult: lastResult }),
    } satisfies ProcessPhase;
  });

const processAfterReadiness = (
  context: FastExecutionContext,
  options: FastExecutionOptions,
  running: RunningProcess,
  state: ExecutionState,
): Effect.Effect<ProcessPhase> => {
  const processExit = observeProcessExit(running);
  return Effect.raceFirst(
    processExit.effect.pipe(
      Effect.tap((result) =>
        notify(
          state,
          context,
          { type: "exited", phase: "running", exitCode: result.exitCode },
          options.onObservation,
        ),
      ),
      Effect.map((result) => ({ type: "running-exit" as const, result })),
    ),
    (options.interruptions ?? processSignals).pipe(
      Effect.map((signal) => ({ type: "stopped" as const, signal })),
    ),
  );
};

const cleanupProcess = (
  context: FastExecutionContext,
  options: FastExecutionOptions,
  running: RunningProcess,
  state: ExecutionState,
  cleanupState: CleanupState,
) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      yield* notify(state, context, { type: "cleanup", status: "started" }, options.onObservation);
      const cleanupExit = yield* Effect.exit(
        Effect.tryPromise(() => running.kill()).pipe(
          Effect.timeout(Duration.millis(options.cleanupTimeoutMs ?? defaultCleanupTimeoutMs)),
        ),
      );
      if (Exit.isSuccess(cleanupExit)) {
        yield* notify(
          state,
          context,
          { type: "cleanup", status: "completed" },
          options.onObservation,
        );
        return;
      }
      const cleanupDiagnostic = makeDiagnostic(
        "cleanup-failed",
        `${context.selectedService} process cleanup could not be verified within ${options.cleanupTimeoutMs ?? defaultCleanupTimeoutMs}ms`,
        `Stop the ${context.selectedService} process tree manually, verify that it is gone, and retry Fast mode.`,
        { mode: context.mode, action: context.action, dependency: context.selectedService },
      );
      cleanupState.diagnostic = cleanupDiagnostic;
      yield* notify(
        state,
        context,
        { type: "cleanup", status: "failed", reason: cleanupDiagnostic.message },
        options.onObservation,
      );
    }),
  );

const processStartDiagnostic = (
  context: FastExecutionContext,
  cause: Cause.Cause<unknown>,
): Diagnostic => {
  const error = Cause.squash(cause);
  if (error instanceof FastStartupTimeout) {
    return makeDiagnostic(
      "dependency-timeout",
      `${context.selectedService} did not start within the ${context.processRequest.timeoutMs}ms startup deadline`,
      `Fix ${context.selectedService} startup and retry Fast mode before the bounded startup deadline.`,
      { mode: context.mode, action: context.action, dependency: context.selectedService },
    );
  }
  return makeDiagnostic(
    "dependency-unavailable",
    `${context.selectedService} could not be started`,
    `Run pnpm install, verify the ${context.selectedService} development tooling is available, and retry Fast mode.`,
    { mode: context.mode, action: context.action, dependency: context.selectedService },
  );
};

const processExitDiagnostic = (
  context: FastExecutionContext,
  result: ProcessResult,
  phase: "startup" | "running",
) =>
  makeDiagnostic(
    "required-dependency-failed",
    `${context.selectedService} exited with code ${result.exitCode} ${phase === "startup" ? "before becoming ready" : "after becoming ready"}`,
    `Inspect the ${context.selectedService} process logs, fix the startup failure, and retry Fast mode.`,
    { mode: context.mode, action: context.action, dependency: context.selectedService },
  );

const resultWithTerminal = (
  context: FastExecutionContext,
  state: ExecutionState,
  status: FastExecutionOutcomeStatus,
  exitCode: number,
  diagnostic?: Diagnostic,
  cleanupDiagnostic?: Diagnostic,
  readyOutput?: LauncherOutput,
): FastExecutionResult => {
  return makeExecutionResultFromContext(
    context.plannedOutput,
    state.observations,
    terminalOutput,
    status,
    exitCode,
    diagnostic,
    cleanupDiagnostic,
    readyOutput,
  );
};

const emitTerminal = (
  context: FastExecutionContext,
  state: ExecutionState,
  outcome: FastExecutionOutcome,
  observer?: (observation: LifecycleObservation) => void,
  diagnostics: readonly Diagnostic[] = [],
  readiness?: ReadinessState,
  warnings: readonly Diagnostic[] = [],
) => {
  const next = {
    type: "terminal" as const,
    outcome: outcome.status,
    exitCode: outcome.exitCode,
    ...(readiness === undefined ? {} : { readiness }),
    ...(diagnostics.length === 0 ? {} : { diagnostics }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
  return notify(state, context, next, observer);
};

type PrerequisiteStage =
  | { readonly type: "passed" }
  | { readonly type: "stopped"; readonly signal: NodeJS.Signals }
  | { readonly type: "failed"; readonly phase: PrerequisitePhase };

type ProcessStage =
  | {
      readonly type: "failed";
      readonly cause: Cause.Cause<unknown>;
      readonly cleanupDiagnostic: Diagnostic | undefined;
    }
  | {
      readonly type: "stopped";
      readonly signal: NodeJS.Signals;
      readonly cleanupDiagnostic: Diagnostic | undefined;
    }
  | {
      readonly type: "phase";
      readonly phase: ProcessPhase;
      readonly cleanupDiagnostic: Diagnostic | undefined;
    };

const interrupted = (options: FastExecutionOptions) =>
  (options.interruptions ?? processSignals).pipe(
    Effect.map((signal) => ({ type: "stopped" as const, signal })),
  );

const finishExecution = (
  context: FastExecutionContext,
  state: ExecutionState,
  options: FastExecutionOptions,
  result: FastExecutionResult,
): Effect.Effect<FastExecutionResult> =>
  emitTerminal(
    context,
    state,
    result.outcome,
    options.onObservation,
    result.output.errors,
    result.output.readiness,
    result.output.warnings,
  ).pipe(Effect.as(result));

const readyOutputFor = (context: FastExecutionContext, state: ExecutionState) =>
  state.observations.some(
    (observation) => observation.type === "readiness" && observation.status === "ready",
  )
    ? { ...context.plannedOutput, readiness: "ready" as const }
    : undefined;

const stoppedResult = (
  context: FastExecutionContext,
  state: ExecutionState,
  signal: NodeJS.Signals,
  cleanupDiagnostic: Diagnostic | undefined,
) => {
  const status = cleanupDiagnostic === undefined ? "stopped" : "failed";
  return resultWithTerminal(
    context,
    state,
    status,
    status === "stopped" ? signalExitCode(signal) : 2,
    undefined,
    cleanupDiagnostic,
    readyOutputFor(context, state),
  );
};

const runPrerequisiteStage = (
  context: FastExecutionContext,
  options: FastExecutionOptions,
  state: ExecutionState,
): Effect.Effect<PrerequisiteStage> =>
  Effect.gen(function* () {
    const prerequisiteExit = yield* Effect.exit(
      Effect.raceFirst(
        runPrerequisites(context, options, state).pipe(
          Effect.map((phase) => ({ type: "prerequisites" as const, phase })),
        ),
        interrupted(options),
      ),
    );
    if (Exit.isFailure(prerequisiteExit)) {
      return {
        type: "failed",
        phase: {
          errors: [
            makeDiagnostic(
              "access-failed",
              "Fast prerequisites could not be checked",
              "Retry the Fast command after verifying the development dependencies.",
              { mode: context.mode, action: context.action },
            ),
          ],
          warnings: [],
        },
      } satisfies PrerequisiteStage;
    }
    if (prerequisiteExit.value.type === "stopped") {
      return prerequisiteExit.value satisfies PrerequisiteStage;
    }
    return prerequisiteExit.value.phase.errors.length === 0
      ? ({ type: "passed" } satisfies PrerequisiteStage)
      : ({ type: "failed", phase: prerequisiteExit.value.phase } satisfies PrerequisiteStage);
  });

const startFastProcess = (context: FastExecutionContext, options: FastExecutionOptions) => {
  const starter = options.processStarter ?? startLongLivedProcess;
  const startupTimeoutMs = options.startupTimeoutMs ?? context.processRequest.timeoutMs;
  const processRequest =
    options.output === undefined
      ? context.processRequest
      : { ...context.processRequest, output: options.output };
  return Effect.timeoutOption(
    Effect.tryPromise({
      try: (signal) => starter(processRequest, signal),
      catch: (cause) => cause,
    }),
    Duration.millis(startupTimeoutMs),
  ).pipe(
    Effect.flatMap((running) =>
      Option.isNone(running)
        ? Effect.fail(new FastStartupTimeout(`Fast ${context.selectedService} startup timed out`))
        : Effect.succeed(running.value),
    ),
  );
};

const runProcessStage = (
  context: FastExecutionContext,
  options: FastExecutionOptions,
  state: ExecutionState,
): Effect.Effect<ProcessStage> => {
  const cleanupState: CleanupState = {};
  return Effect.gen(function* () {
    const processExit = yield* Effect.exit(
      Effect.raceFirst(
        Effect.scoped(
          Effect.gen(function* () {
            const running = yield* Effect.acquireRelease(
              startFastProcess(context, options),
              (process) => cleanupProcess(context, options, process, state, cleanupState),
              { interruptible: true },
            );
            yield* notify(
              state,
              context,
              { type: "started", ...(running.pid === undefined ? {} : { pid: running.pid }) },
              options.onObservation,
            );
            return yield* waitForReadiness(context, options, running, state).pipe(
              Effect.flatMap((phase) =>
                phase.type === "ready"
                  ? processAfterReadiness(context, options, running, state)
                  : Effect.succeed(phase),
              ),
            );
          }),
        ).pipe(Effect.map((phase) => ({ type: "phase" as const, phase }))),
        interrupted(options),
      ),
    );
    if (Exit.isFailure(processExit)) {
      return {
        type: "failed",
        cause: processExit.cause,
        cleanupDiagnostic: cleanupState.diagnostic,
      } satisfies ProcessStage;
    }
    if (processExit.value.type === "stopped") {
      return {
        type: "stopped",
        signal: processExit.value.signal,
        cleanupDiagnostic: cleanupState.diagnostic,
      } satisfies ProcessStage;
    }
    return {
      type: "phase",
      phase: processExit.value.phase,
      cleanupDiagnostic: cleanupState.diagnostic,
    } satisfies ProcessStage;
  });
};

const resultForProcessPhase = (
  context: FastExecutionContext,
  state: ExecutionState,
  phase: ProcessPhase,
  cleanupDiagnostic: Diagnostic | undefined,
): FastExecutionResult =>
  Match.value(phase).pipe(
    Match.when({ type: "stopped" }, ({ signal }) =>
      stoppedResult(context, state, signal, cleanupDiagnostic),
    ),
    Match.when({ type: "startup-exit" }, ({ result, readinessResult }) =>
      resultWithTerminal(
        context,
        state,
        "blocked",
        2,
        result.timedOut
          ? readinessDiagnostic(context, readinessResult)
          : processExitDiagnostic(context, result, "startup"),
        cleanupDiagnostic,
      ),
    ),
    Match.when({ type: "ready" }, () =>
      resultWithTerminal(
        context,
        state,
        "failed",
        2,
        makeDiagnostic(
          "required-dependency-failed",
          "Fast execution ended without a terminal process state",
          "Retry the Fast command and inspect the launcher diagnostics.",
          { mode: context.mode, action: context.action },
        ),
        cleanupDiagnostic,
      ),
    ),
    Match.when({ type: "running-exit" }, ({ result }) => {
      const readyOutput = { ...context.plannedOutput, readiness: "ready" as const };
      if (result.exitCode === 0) {
        return cleanupDiagnostic === undefined
          ? resultWithTerminal(context, state, "completed", 0, undefined, undefined, readyOutput)
          : resultWithTerminal(
              context,
              state,
              "failed",
              2,
              cleanupDiagnostic,
              undefined,
              readyOutput,
            );
      }
      return resultWithTerminal(
        context,
        state,
        "failed",
        result.exitCode,
        processExitDiagnostic(context, result, "running"),
        cleanupDiagnostic,
        readyOutput,
      );
    }),
    Match.exhaustive,
  );

const resultForProcessStage = (
  context: FastExecutionContext,
  state: ExecutionState,
  stage: ProcessStage,
): FastExecutionResult =>
  Match.value(stage).pipe(
    Match.when({ type: "failed" }, ({ cause, cleanupDiagnostic }) =>
      resultWithTerminal(
        context,
        state,
        cleanupDiagnostic === undefined ? "blocked" : "failed",
        2,
        processStartDiagnostic(context, cause),
        cleanupDiagnostic,
      ),
    ),
    Match.when({ type: "stopped" }, ({ signal, cleanupDiagnostic }) =>
      stoppedResult(context, state, signal, cleanupDiagnostic),
    ),
    Match.when({ type: "phase" }, ({ phase, cleanupDiagnostic }) =>
      resultForProcessPhase(context, state, phase, cleanupDiagnostic),
    ),
    Match.exhaustive,
  );

const executeFastEffect = (
  context: FastExecutionContext,
  options: FastExecutionOptions,
): Effect.Effect<FastExecutionResult, never, never> =>
  Effect.gen(function* () {
    const state = { sequence: 0, observations: [] as LifecycleObservation[] };
    yield* notify(state, context, { type: "validated" }, options.onObservation);
    const prerequisiteStage = yield* runPrerequisiteStage(context, options, state);
    if (prerequisiteStage.type === "stopped") {
      return yield* finishExecution(
        context,
        state,
        options,
        stoppedResult(context, state, prerequisiteStage.signal, undefined),
      );
    }
    if (prerequisiteStage.type === "failed") {
      const result = resultWithTerminal(
        context,
        state,
        "blocked",
        2,
        prerequisiteStage.phase.errors[0],
      );
      const output = {
        ...result,
        output: {
          ...result.output,
          errors: prerequisiteStage.phase.errors,
          warnings: [...result.output.warnings, ...prerequisiteStage.phase.warnings],
        },
      } satisfies FastExecutionResult;
      return yield* finishExecution(context, state, options, output);
    }
    const processStage = yield* runProcessStage(context, options, state);
    return yield* finishExecution(
      context,
      state,
      options,
      resultForProcessStage(context, state, processStage),
    );
  });

const signalExitCode = (signal: NodeJS.Signals) => (signal === "SIGINT" ? 130 : 143);

export const executeFast = (
  context: FastExecutionContext,
  options: FastExecutionOptions = {},
): Effect.Effect<FastExecutionResult> => executeFastEffect(context, options);

export const runFastExecution = (
  context: FastExecutionContext,
  options: FastExecutionOptions = {},
): Promise<FastExecutionResult> => Effect.runPromise(executeFast(context, options));

const defaultKubernetesStepTimeoutMs = 2 * 60_000;
const defaultKubernetesStartupTimeoutMs = 30_000;
const kubernetesPreviewTimeoutMs = 10 * 60_000;
const kubernetesWorkloadDetailTimeoutMs = 10_000;

const kubernetesStepTimeouts: Readonly<Record<string, number>> = {
  "kubernetes-preview": kubernetesPreviewTimeoutMs,
};

const kubernetesStepTimeoutMs = (id: string) =>
  kubernetesStepTimeouts[id] ?? defaultKubernetesStepTimeoutMs;

const kubernetesStepPhase = (
  action: KubernetesExecutionContext["action"],
  id: string,
  index: number,
  previewIndex: number,
): KubernetesExecutionPhase => {
  if (action === "validate") return "validation";
  if (id === "kubernetes-preview") return "preview";
  return previewIndex >= 0 && index > previewIndex ? "post-preview" : "pre-preview";
};

export const makeKubernetesExecutionContext = (
  config: KubernetesModeConfig,
  plan: ModePlan,
  plannedOutput: LauncherOutput,
  cwd: string,
  imageTag: string | null = null,
): KubernetesExecutionContext => {
  if (
    config.mode !== "kubernetes" ||
    !plannedOutput.ok ||
    plannedOutput.mode !== "kubernetes" ||
    (plannedOutput.action !== "validate" && plannedOutput.action !== "preview")
  ) {
    throw new Error("Kubernetes execution requires a valid Kubernetes plan");
  }
  const action = plannedOutput.action;
  const previewIndex = plan.plannedProcesses.findIndex(({ id }) => id === "kubernetes-preview");
  const kubeconfig =
    config.environment.KUBECONFIG === undefined
      ? {}
      : { KUBECONFIG: config.environment.KUBECONFIG };
  const steps = plan.plannedProcesses.map((planned, index) => ({
    id: planned.id,
    phase: kubernetesStepPhase(action, planned.id, index, previewIndex),
    planned,
    request: {
      command: planned.command,
      args: planned.args,
      cwd: path.resolve(cwd),
      env: { ...kubeconfig, ...planned.environment },
      timeoutMs: kubernetesStepTimeoutMs(planned.id),
      kind: planned.readOnly ? ("dependency-check" as const) : ("runtime" as const),
      readOnly: planned.readOnly,
    },
  }));
  return {
    mode: "kubernetes",
    action,
    target: {
      context: config.environment.KUBE_CONTEXT,
      namespace: config.environment.KUBE_NAMESPACE,
      release: config.environment.KUBE_RELEASE,
      registry: config.environment.DEV_IMAGE_REGISTRY,
      imageTag,
      ...(config.environment.KUBECONFIG === undefined
        ? {}
        : { kubeconfig: config.environment.KUBECONFIG }),
    },
    steps,
    plannedOutput,
  };
};

type KubernetesExecutionState = {
  sequence: number;
  observations: KubernetesLifecycleObservation[];
};

const notifyKubernetes = (
  state: KubernetesExecutionState,
  context: KubernetesExecutionContext,
  observation: KubernetesLifecycleObservationDetail,
  observer?: (observation: KubernetesLifecycleObservation) => void,
) =>
  Effect.sync(() => {
    const next = {
      sequence: state.sequence + 1,
      mode: context.mode,
      action: context.action,
      service: "kubernetes" as const,
      ...observation,
    } as KubernetesLifecycleObservation;
    state.sequence = next.sequence;
    state.observations.push(next);
    observer?.(next);
  });

class KubernetesStepStartupTimeout extends Error {
  readonly _tag = "KubernetesStepStartupTimeout";
}

type KubernetesStepRun =
  | { readonly type: "completed" }
  | {
      readonly type: "stopped";
      readonly signal: NodeJS.Signals;
      readonly cleanupDiagnostic: Diagnostic | undefined;
    }
  | {
      readonly type: "failed";
      readonly result?: ProcessResult;
      readonly cause?: unknown;
      readonly cleanupDiagnostic: Diagnostic | undefined;
    };

type KubernetesExecutionStage =
  | { readonly type: "completed" }
  | {
      readonly type: "stopped";
      readonly signal: NodeJS.Signals;
      readonly cleanupDiagnostic: Diagnostic | undefined;
    }
  | {
      readonly type: "failed";
      readonly diagnostic: Diagnostic;
      readonly cleanupDiagnostic: Diagnostic | undefined;
    };

type KubernetesProcessRace =
  | { readonly type: "result"; readonly exit: ProcessResult }
  | { readonly type: "stopped"; readonly signal: NodeJS.Signals }
  | { readonly type: "timeout" };

const kubernetesInterruptions = (options: KubernetesExecutionOptions) =>
  (options.interruptions ?? processSignals).pipe(
    Effect.map((signal) => ({ type: "stopped" as const, signal })),
  );

const withKubernetesOutput = (
  request: ProcessRequest,
  output: KubernetesExecutionOptions["output"],
): ProcessRequest => (output === undefined ? request : { ...request, output });

const kubernetesSignalsByExitCode: Readonly<Record<string, NodeJS.Signals>> = {
  "130": "SIGINT",
  "143": "SIGTERM",
};

const signalFromExitCode = (exitCode: number): NodeJS.Signals | undefined =>
  kubernetesSignalsByExitCode[String(exitCode)];

const redactKubernetesOutput = redactExecutionText;

const startKubernetesStep = (
  context: KubernetesExecutionContext,
  step: KubernetesExecutionStep,
  options: KubernetesExecutionOptions,
  starter: ProcessStarter = options.processStarter ?? startLongLivedProcess,
) => {
  const request = withKubernetesOutput(step.request, options.output);
  const startupTimeoutMs = options.startupTimeoutMs ?? defaultKubernetesStartupTimeoutMs;
  return Effect.timeoutOption(
    Effect.tryPromise({
      try: (signal) => starter(request, signal),
      catch: (cause) => cause,
    }),
    Duration.millis(startupTimeoutMs),
  ).pipe(
    Effect.flatMap((running) =>
      Option.isNone(running)
        ? Effect.fail(
            new KubernetesStepStartupTimeout(`${context.action} ${step.id} startup timed out`),
          )
        : Effect.succeed(running.value),
    ),
  );
};

const startKubernetesExecutorProcess = (
  executor: ProcessExecutor,
  request: ProcessRequest,
  signal?: AbortSignal,
): Promise<RunningProcess> => {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const removeAbortListener =
    signal === undefined ? () => undefined : () => signal.removeEventListener("abort", onAbort);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted === true) onAbort();
  const exited = Promise.resolve().then(() =>
    controller.signal.aborted ? { exitCode: 143 } : executor(request, controller.signal),
  );
  exited.then(removeAbortListener, removeAbortListener);
  let killPromise: Promise<void> | undefined;
  const kill = () => {
    if (killPromise !== undefined) return killPromise;
    killPromise = (async () => {
      controller.abort();
      removeAbortListener();
      const terminated = await Promise.race([
        exited.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), defaultCleanupTimeoutMs),
        ),
      ]);
      if (!terminated) throw new Error("Injected process executor did not terminate after abort");
    })();
    return killPromise;
  };
  return Promise.resolve({ pid: undefined, exited, kill });
};

const classifyKubernetesProcessResult = (
  context: KubernetesExecutionContext,
  step: KubernetesExecutionStep,
  state: KubernetesExecutionState,
  options: KubernetesExecutionOptions,
  processResult: ProcessResult,
): Effect.Effect<KubernetesStepRun> =>
  Effect.gen(function* () {
    const signal = signalFromExitCode(processResult.exitCode);
    if (signal !== undefined) {
      yield* notifyKubernetes(
        state,
        context,
        {
          type: "step",
          id: step.id,
          phase: step.phase,
          status: "stopped",
          exitCode: processResult.exitCode,
        },
        options.onObservation,
      );
      return {
        type: "stopped" as const,
        signal,
        cleanupDiagnostic: undefined,
      } satisfies Extract<KubernetesStepRun, { type: "stopped" }>;
    }
    if (processResult.exitCode === 0 && !processResult.timedOut) {
      yield* notifyKubernetes(
        state,
        context,
        { type: "step", id: step.id, phase: step.phase, status: "completed", exitCode: 0 },
        options.onObservation,
      );
      return { type: "completed" as const } satisfies Extract<
        KubernetesStepRun,
        { type: "completed" }
      >;
    }
    const processDetail = processResult.stderr?.trim() || processResult.stdout?.trim();
    yield* notifyKubernetes(
      state,
      context,
      {
        type: "step",
        id: step.id,
        phase: step.phase,
        status: "failed",
        exitCode: processResult.exitCode,
        ...(processDetail === undefined ? {} : { reason: redactKubernetesOutput(processDetail) }),
      },
      options.onObservation,
    );
    return {
      type: "failed" as const,
      result: processResult,
      cleanupDiagnostic: undefined,
    } satisfies Extract<KubernetesStepRun, { type: "failed" }>;
  });

const timedOutKubernetesStep = (
  context: KubernetesExecutionContext,
  step: KubernetesExecutionStep,
  state: KubernetesExecutionState,
  options: KubernetesExecutionOptions,
): Effect.Effect<KubernetesStepRun> =>
  Effect.gen(function* () {
    yield* notifyKubernetes(
      state,
      context,
      {
        type: "step",
        id: step.id,
        phase: step.phase,
        status: "failed",
        exitCode: 1,
        reason: `command exceeded its ${step.request.timeoutMs}ms execution deadline`,
      },
      options.onObservation,
    );
    return {
      type: "failed" as const,
      result: { exitCode: 1, timedOut: true },
      cleanupDiagnostic: undefined,
    } satisfies Extract<KubernetesStepRun, { type: "failed" }>;
  });

const failedKubernetesStep = (
  context: KubernetesExecutionContext,
  step: KubernetesExecutionStep,
  state: KubernetesExecutionState,
  options: KubernetesExecutionOptions,
  cause: unknown,
  reason: string,
  exitCode: number,
  cleanupDiagnostic: Diagnostic | undefined,
): Effect.Effect<KubernetesStepRun> =>
  Effect.gen(function* () {
    yield* notifyKubernetes(
      state,
      context,
      {
        type: "step",
        id: step.id,
        phase: step.phase,
        status: "failed",
        exitCode,
        reason,
      },
      options.onObservation,
    );
    return {
      type: "failed",
      cause,
      cleanupDiagnostic,
    } satisfies Extract<KubernetesStepRun, { type: "failed" }>;
  });

const stoppedKubernetesStep = (
  context: KubernetesExecutionContext,
  step: KubernetesExecutionStep,
  state: KubernetesExecutionState,
  options: KubernetesExecutionOptions,
  signal: NodeJS.Signals,
  exitCode?: number,
): Effect.Effect<KubernetesStepRun> =>
  Effect.gen(function* () {
    yield* notifyKubernetes(
      state,
      context,
      {
        type: "step",
        id: step.id,
        phase: step.phase,
        status: "stopped",
        ...(exitCode === undefined ? {} : { exitCode }),
      },
      options.onObservation,
    );
    return {
      type: "stopped",
      signal,
      cleanupDiagnostic: undefined,
    } satisfies Extract<KubernetesStepRun, { type: "stopped" }>;
  });

const raceKubernetesProcess = (
  processExit: Effect.Effect<ProcessResult, unknown>,
  interruption: Effect.Effect<{ readonly type: "stopped"; readonly signal: NodeJS.Signals }>,
  timeoutMs: number,
  onTimeout?: () => Effect.Effect<void>,
): Effect.Effect<KubernetesProcessRace, unknown> => {
  const timeout = Effect.sleep(Duration.millis(timeoutMs)).pipe(
    Effect.tap(() => (onTimeout === undefined ? Effect.void : onTimeout())),
    Effect.map(() => ({ type: "timeout" as const })),
  );
  return Effect.raceFirst(
    Effect.raceFirst(
      processExit.pipe(Effect.map((exit) => ({ type: "result" as const, exit }))),
      interruption,
    ),
    timeout,
  );
};

type KubernetesCleanupState = {
  requested: boolean;
  diagnostic?: Diagnostic;
};

const cleanupKubernetesStep = (
  context: KubernetesExecutionContext,
  step: KubernetesExecutionStep,
  options: KubernetesExecutionOptions,
  running: RunningProcess,
  state: KubernetesExecutionState,
  cleanupState: KubernetesCleanupState,
) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      if (!cleanupState.requested) return;
      yield* notifyKubernetes(
        state,
        context,
        { type: "cleanup", status: "started" },
        options.onObservation,
      );
      const cleanupExit = yield* Effect.exit(
        Effect.tryPromise(() => running.kill()).pipe(
          Effect.timeout(Duration.millis(options.cleanupTimeoutMs ?? defaultCleanupTimeoutMs)),
        ),
      );
      if (Exit.isSuccess(cleanupExit)) {
        yield* notifyKubernetes(
          state,
          context,
          { type: "cleanup", status: "completed" },
          options.onObservation,
        );
        return;
      }
      const cleanupDiagnostic = makeDiagnostic(
        "cleanup-failed",
        `${step.id} local command cleanup could not be verified within ${options.cleanupTimeoutMs ?? defaultCleanupTimeoutMs}ms`,
        `Stop the local ${step.id} process manually and inspect the shared Kubernetes preview for incomplete work. No automatic rollback is attempted.`,
        { mode: context.mode, action: context.action, dependency: step.id },
      );
      cleanupState.diagnostic = cleanupDiagnostic;
      yield* notifyKubernetes(
        state,
        context,
        { type: "cleanup", status: "failed", reason: cleanupDiagnostic.message },
        options.onObservation,
      );
    }),
  );

const runKubernetesStepWithStarter = (
  context: KubernetesExecutionContext,
  step: KubernetesExecutionStep,
  options: KubernetesExecutionOptions,
  state: KubernetesExecutionState,
  starter?: ProcessStarter,
): Effect.Effect<KubernetesStepRun> => {
  const cleanupState: KubernetesCleanupState = { requested: false };
  const interruption = kubernetesInterruptions(options).pipe(
    Effect.tap(() => Effect.sync(() => (cleanupState.requested = true))),
  );
  const started = Effect.scoped(
    Effect.gen(function* () {
      const running = yield* Effect.acquireRelease(
        startKubernetesStep(context, step, options, starter),
        (process) => cleanupKubernetesStep(context, step, options, process, state, cleanupState),
        { interruptible: true },
      );
      yield* notifyKubernetes(
        state,
        context,
        { type: "step", id: step.id, phase: step.phase, status: "started" },
        options.onObservation,
      );
      const processExit = observeProcessExit(running);
      const result = yield* raceKubernetesProcess(
        processExit.effect,
        interruption,
        step.request.timeoutMs,
        () => Effect.sync(() => (cleanupState.requested = true)),
      );
      if (result.type === "stopped") {
        return yield* stoppedKubernetesStep(context, step, state, options, result.signal);
      }
      if (result.type === "timeout") {
        return yield* timedOutKubernetesStep(context, step, state, options);
      }
      return yield* classifyKubernetesProcessResult(context, step, state, options, result.exit);
    }),
  ).pipe(
    Effect.catch((cause: unknown) =>
      failedKubernetesStep(
        context,
        step,
        state,
        options,
        cause,
        cause instanceof Error
          ? redactKubernetesOutput(cause.message)
          : "command could not be started",
        cause instanceof KubernetesStepStartupTimeout ? 1 : 127,
        cleanupState.diagnostic,
      ),
    ),
  );
  return Effect.gen(function* () {
    const result = yield* Effect.raceFirst(started, interruption);
    return result.type === "completed"
      ? result
      : {
          ...result,
          cleanupDiagnostic: cleanupState.diagnostic,
        };
  });
};

const runKubernetesStepWithExecutor = (
  context: KubernetesExecutionContext,
  step: KubernetesExecutionStep,
  options: KubernetesExecutionOptions,
  state: KubernetesExecutionState,
): Effect.Effect<KubernetesStepRun> => {
  const executor = options.executor ?? spawnProcess;
  return runKubernetesStepWithStarter(context, step, options, state, (request, signal) =>
    startKubernetesExecutorProcess(executor, request, signal),
  );
};

const describeKubernetesCause = (cause: unknown) => {
  if (cause instanceof Error) return redactKubernetesOutput(cause.message);
  if (typeof cause === "string") return redactKubernetesOutput(cause);
  try {
    return redactKubernetesOutput(JSON.stringify(cause) ?? "unknown failure");
  } catch {
    return "unknown failure";
  }
};

const kubernetesFailureDetails = (run: Extract<KubernetesStepRun, { type: "failed" }>) => {
  const startupTimedOut = run.cause instanceof KubernetesStepStartupTimeout;
  const processDetail = redactKubernetesOutput(
    run.result?.stderr?.trim() || run.result?.stdout?.trim() || "",
  );
  const causeDetail =
    run.cause === undefined || startupTimedOut ? "" : describeKubernetesCause(run.cause);
  return {
    timedOut: run.result?.timedOut === true || startupTimedOut,
    detail: processDetail || causeDetail,
  };
};

const kubernetesFailureRemediation = (
  context: KubernetesExecutionContext,
  step: KubernetesExecutionStep,
) =>
  context.action === "validate"
    ? "Inspect the Helm lint or template output, fix the chart or development values, then retry the same command."
    : `Inspect the failed ${step.id} evidence, fix the development deployment or gate, then retry the same command. Shared preview resources are not rolled back automatically.`;

const kubernetesStepDiagnostic = (
  context: KubernetesExecutionContext,
  step: KubernetesExecutionStep,
  run: Extract<KubernetesStepRun, { type: "failed" }>,
  workloadDetails: string,
) => {
  const failure = kubernetesFailureDetails(run);
  const exitCode = run.result === undefined ? "" : ` with exit code ${run.result.exitCode}`;
  const deadline = failure.timedOut ? " before its bounded deadline" : "";
  const commandDetail = failure.detail.length === 0 ? "" : `: ${failure.detail}`;
  const workloadDetail = workloadDetails.length === 0 ? "" : `; workloads:\n${workloadDetails}`;
  return makeDiagnostic(
    failure.timedOut ? "dependency-timeout" : "required-dependency-failed",
    `${step.id} failed${exitCode}${deadline}${commandDetail}${workloadDetail}`,
    kubernetesFailureRemediation(context, step),
    { mode: context.mode, action: context.action, dependency: step.id },
  );
};

const workloadDetailRequest = (context: KubernetesExecutionContext): ProcessRequest | undefined => {
  if (
    context.action !== "preview" ||
    context.target.context.trim() === "" ||
    context.target.namespace.trim() === ""
  ) {
    return undefined;
  }
  return {
    command: "kubectl",
    args: [
      "--context",
      context.target.context,
      "--namespace",
      context.target.namespace,
      "get",
      "pods,deployments,statefulsets,jobs",
      "-o",
      "wide",
    ],
    cwd: context.steps[0]?.request.cwd ?? process.cwd(),
    env: context.target.kubeconfig === undefined ? {} : { KUBECONFIG: context.target.kubeconfig },
    timeoutMs: kubernetesWorkloadDetailTimeoutMs,
    kind: "dependency-check",
    readOnly: true,
    output: "capture",
  };
};

type KubernetesWorkloadDetailsResult =
  | { readonly type: "details"; readonly text: string }
  | { readonly type: "stopped"; readonly signal: NodeJS.Signals };

const workloadDetailsFromProcessResult = (
  processResult: ProcessResult,
): KubernetesWorkloadDetailsResult => {
  const signal = signalFromExitCode(processResult.exitCode);
  if (signal !== undefined) return { type: "stopped", signal };
  return {
    type: "details",
    text: redactKubernetesOutput(
      (processResult.stdout?.trim() || processResult.stderr?.trim() || "").slice(0, 64 * 1024),
    ),
  };
};

const collectKubernetesWorkloadDetailsWithStarter = (
  request: ProcessRequest,
  options: KubernetesExecutionOptions,
  starter: ProcessStarter = options.processStarter ?? startLongLivedProcess,
): Effect.Effect<KubernetesWorkloadDetailsResult> => {
  const cleanupState: KubernetesCleanupState = { requested: false };
  const interruption = kubernetesInterruptions(options).pipe(
    Effect.tap(() => Effect.sync(() => (cleanupState.requested = true))),
  );
  const start = Effect.timeoutOption(
    Effect.tryPromise({
      try: (signal) => starter({ ...request, output: "capture" }, signal),
      catch: (cause) => cause,
    }),
    Duration.millis(kubernetesWorkloadDetailTimeoutMs),
  ).pipe(
    Effect.flatMap((running) =>
      Option.isNone(running)
        ? Effect.fail(new Error("workload detail probe timed out"))
        : Effect.succeed(running.value),
    ),
  );
  const run = Effect.scoped(
    Effect.gen(function* () {
      const running = yield* Effect.acquireRelease(
        start,
        (process) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              if (!cleanupState.requested) return;
              yield* Effect.exit(
                Effect.tryPromise(() => process.kill()).pipe(
                  Effect.timeout(Duration.millis(defaultCleanupTimeoutMs)),
                ),
              );
            }),
          ),
        { interruptible: true },
      );
      const processExit = observeProcessExit(running);
      const timeout = Effect.sleep(Duration.millis(kubernetesWorkloadDetailTimeoutMs)).pipe(
        Effect.tap(() => Effect.sync(() => (cleanupState.requested = true))),
        Effect.map(() => ({ type: "timeout" as const })),
      );
      const result = yield* Effect.raceFirst(
        Effect.raceFirst(
          processExit.effect.pipe(Effect.map((exit) => ({ type: "result" as const, exit }))),
          interruption,
        ),
        timeout,
      );
      if (result.type === "stopped") return result;
      if (result.type === "timeout") return { type: "details" as const, text: "" };
      return workloadDetailsFromProcessResult(result.exit);
    }),
  );
  return Effect.gen(function* () {
    const result = yield* Effect.exit(Effect.raceFirst(run, interruption));
    if (Exit.isFailure(result)) return { type: "details" as const, text: "" };
    return result.value;
  });
};

const collectKubernetesWorkloadDetails = (
  context: KubernetesExecutionContext,
  step: KubernetesExecutionStep,
  options: KubernetesExecutionOptions,
): Effect.Effect<KubernetesWorkloadDetailsResult> => {
  if (step.phase === "validation" || step.phase === "pre-preview") {
    return Effect.succeed({ type: "details", text: "" });
  }
  const request = workloadDetailRequest(context);
  if (request === undefined) return Effect.succeed({ type: "details", text: "" });
  return options.executor === undefined
    ? collectKubernetesWorkloadDetailsWithStarter(request, options)
    : collectKubernetesWorkloadDetailsWithStarter(request, options, (probeRequest, signal) =>
        startKubernetesExecutorProcess(options.executor ?? spawnProcess, probeRequest, signal),
      );
};

const runKubernetesSteps = (
  context: KubernetesExecutionContext,
  options: KubernetesExecutionOptions,
  state: KubernetesExecutionState,
): Effect.Effect<KubernetesExecutionStage> =>
  Effect.gen(function* () {
    for (const step of context.steps) {
      const run = yield* options.executor === undefined
        ? runKubernetesStepWithStarter(context, step, options, state)
        : runKubernetesStepWithExecutor(context, step, options, state);
      if (run.type === "completed") continue;
      if (run.type === "stopped") {
        return {
          type: "stopped",
          signal: run.signal,
          cleanupDiagnostic: run.cleanupDiagnostic,
        } satisfies Extract<KubernetesExecutionStage, { type: "stopped" }>;
      }
      const workloadDetails = yield* collectKubernetesWorkloadDetails(context, step, options);
      if (workloadDetails.type === "stopped") {
        return {
          type: "failed",
          diagnostic: kubernetesStepDiagnostic(
            context,
            step,
            run,
            `workload detail collection was interrupted by ${workloadDetails.signal}`,
          ),
          cleanupDiagnostic: run.cleanupDiagnostic,
        } satisfies Extract<KubernetesExecutionStage, { type: "failed" }>;
      }
      return {
        type: "failed",
        diagnostic: kubernetesStepDiagnostic(context, step, run, workloadDetails.text),
        cleanupDiagnostic: run.cleanupDiagnostic,
      } satisfies Extract<KubernetesExecutionStage, { type: "failed" }>;
    }
    return { type: "completed" } satisfies Extract<KubernetesExecutionStage, { type: "completed" }>;
  });

const incompleteKubernetesDiagnostic = (
  context: KubernetesExecutionContext,
  signal: NodeJS.Signals,
) => {
  const isPreview = context.action === "preview";
  return makeDiagnostic(
    "preview-incomplete",
    isPreview
      ? `preview was interrupted by ${signal}; shared Kubernetes preview resources may be incomplete.`
      : `validate was interrupted by ${signal}; the local Helm lint and render steps did not complete.`,
    isPreview
      ? "Inspect the shared development preview before continuing. The launcher does not issue rollback, deletion, or teardown commands on cancellation."
      : "Rerun the same validate command. No shared Kubernetes resource was changed.",
    { mode: context.mode, action: context.action },
  );
};

const kubernetesResultForStage = (
  context: KubernetesExecutionContext,
  stage: KubernetesExecutionStage,
): KubernetesExecutionResult =>
  Match.value(stage).pipe(
    Match.when({ type: "completed" }, () => ({
      output: { ...context.plannedOutput, readiness: "completed" as const },
      observations: [],
      outcome: { status: "completed" as const, ok: true, exitCode: 0 },
    })),
    Match.when({ type: "stopped" }, ({ signal, cleanupDiagnostic }) => {
      const incomplete = incompleteKubernetesDiagnostic(context, signal);
      if (cleanupDiagnostic !== undefined) {
        return {
          output: {
            ...context.plannedOutput,
            ok: false,
            readiness: "blocked" as const,
            errors: [incomplete, cleanupDiagnostic],
          },
          observations: [],
          outcome: {
            status: "failed" as const,
            ok: false,
            exitCode: 2,
            diagnostic: incomplete,
            cleanupDiagnostic,
          },
        };
      }
      return {
        output: {
          ...context.plannedOutput,
          readiness: "stopped" as const,
          warnings: [
            ...context.plannedOutput.warnings,
            { ...incomplete, kind: "warning" as const },
          ],
        },
        observations: [],
        outcome: {
          status: "stopped" as const,
          ok: true,
          exitCode: signal === "SIGINT" ? 130 : 143,
        },
      };
    }),
    Match.when({ type: "failed" }, ({ diagnostic, cleanupDiagnostic }) => {
      const status = cleanupDiagnostic === undefined ? ("blocked" as const) : ("failed" as const);
      return {
        output: {
          ...context.plannedOutput,
          ok: false,
          readiness: "blocked" as const,
          errors: [diagnostic, ...(cleanupDiagnostic === undefined ? [] : [cleanupDiagnostic])],
        },
        observations: [],
        outcome: {
          status,
          ok: false,
          exitCode: 2,
          diagnostic,
          ...(cleanupDiagnostic === undefined ? {} : { cleanupDiagnostic }),
        },
      };
    }),
    Match.exhaustive,
  );

const finishKubernetesExecution = (
  context: KubernetesExecutionContext,
  state: KubernetesExecutionState,
  stage: KubernetesExecutionStage,
  options: KubernetesExecutionOptions,
) =>
  Effect.gen(function* () {
    const result = kubernetesResultForStage(context, stage);
    const diagnostics = result.output.errors;
    const warnings = result.output.warnings;
    yield* notifyKubernetes(
      state,
      context,
      {
        type: "terminal",
        outcome: result.outcome.status,
        exitCode: result.outcome.exitCode,
        readiness: result.output.readiness,
        ...(diagnostics.length === 0 ? {} : { diagnostics }),
        ...(warnings.length === 0 ? {} : { warnings }),
      },
      options.onObservation,
    );
    return { ...result, observations: state.observations };
  });

const executeKubernetesEffect = (
  context: KubernetesExecutionContext,
  options: KubernetesExecutionOptions,
): Effect.Effect<KubernetesExecutionResult, never, never> =>
  Effect.gen(function* () {
    const state: KubernetesExecutionState = { sequence: 0, observations: [] };
    yield* notifyKubernetes(state, context, { type: "validated" }, options.onObservation);
    const stage = yield* Effect.exit(runKubernetesSteps(context, options, state));
    if (Exit.isFailure(stage)) {
      const diagnostic = makeDiagnostic(
        "required-dependency-failed",
        `Kubernetes ${context.action} execution failed before producing a terminal step result`,
        "Retry the same Kubernetes command and inspect the launcher diagnostics.",
        { mode: context.mode, action: context.action },
      );
      return yield* finishKubernetesExecution(
        context,
        state,
        { type: "failed", diagnostic, cleanupDiagnostic: undefined },
        options,
      );
    }
    return yield* finishKubernetesExecution(context, state, stage.value, options);
  });

export const executeKubernetes = (
  context: KubernetesExecutionContext,
  options: KubernetesExecutionOptions = {},
): Effect.Effect<KubernetesExecutionResult> => executeKubernetesEffect(context, options);

export const runKubernetesExecution = (
  context: KubernetesExecutionContext,
  options: KubernetesExecutionOptions = {},
): Promise<KubernetesExecutionResult> => Effect.runPromise(executeKubernetes(context, options));

export const executeDevelopment = (
  context: DevelopmentExecutionContext,
  options: DevelopmentExecutionOptions = {},
): Effect.Effect<DevelopmentExecutionResult> => {
  const fastOptions: FastExecutionOptions = {
    ...(options.accessChecker === undefined ? {} : { accessChecker: options.accessChecker }),
    ...(options.readinessChecker === undefined
      ? {}
      : { readinessChecker: options.readinessChecker }),
    ...(options.tcpAccessChecker === undefined
      ? {}
      : { tcpAccessChecker: options.tcpAccessChecker }),
    ...(options.processStarter === undefined ? {} : { processStarter: options.processStarter }),
    ...(options.interruptions === undefined ? {} : { interruptions: options.interruptions }),
    ...(options.dependencyTimeoutMs === undefined
      ? {}
      : { dependencyTimeoutMs: options.dependencyTimeoutMs }),
    ...(options.startupTimeoutMs === undefined
      ? {}
      : { startupTimeoutMs: options.startupTimeoutMs }),
    ...(options.readinessTimeoutMs === undefined
      ? {}
      : { readinessTimeoutMs: options.readinessTimeoutMs }),
    ...(options.cleanupTimeoutMs === undefined
      ? {}
      : { cleanupTimeoutMs: options.cleanupTimeoutMs }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.output === undefined ? {} : { output: options.output }),
    ...(options.onObservation === undefined
      ? {}
      : {
          onObservation: (observation: LifecycleObservation) =>
            options.onObservation?.(observation),
        }),
  };
  return Match.value(context).pipe(
    Match.when({ mode: "kubernetes" }, (kubernetes) =>
      executeKubernetesEffect(kubernetes, options),
    ),
    Match.when({ mode: "compose" }, (compose) => executeCompose(compose, options)),
    Match.when({ mode: "fast" }, (fast) => executeFastEffect(fast, fastOptions)),
    Match.exhaustive,
  );
};

export const runDevelopmentExecution = (
  context: DevelopmentExecutionContext,
  options: DevelopmentExecutionOptions = {},
): Promise<DevelopmentExecutionResult> => Effect.runPromise(executeDevelopment(context, options));
export {
  executeCompose,
  makeComposeExecutionContext,
  makeComposeStateAdapter,
  runComposeExecution,
  type ComposeCleanupRequest,
  type ComposeCleanupResult,
  type ComposeContainerQuery,
  type ComposeContainerState,
  type ComposeExecutionContext,
  type ComposeExecutionContextOptions,
  type ComposeExecutionOptions,
  type ComposeExecutionOutcome,
  type ComposeExecutionOutcomeStatus,
  type ComposeExecutionResult,
  type ComposeExecutionStep,
  type ComposeLifecycleObservation,
  type ComposeReadinessRequest,
  type ComposeStateAdapter,
} from "./compose-execution";
