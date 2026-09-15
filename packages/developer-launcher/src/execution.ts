import { Cause, Duration, Effect, Exit, Match, Option, Schema } from "effect";
import path from "node:path";
import { checkHttpAccess, checkHttpReadiness, checkTcpAccess, isHttpReady } from "./access";
import { makeDiagnostic, makeWarning } from "./diagnostics";
import { startLongLivedProcess } from "./executor";
import { fastServices } from "./types";
import type {
  AccessCheckResult,
  AccessChecker,
  Diagnostic,
  FastService,
  LauncherOutput,
  ProcessRequest,
  ProcessResult,
  ProcessStarter,
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
  readonly output?: "inherit" | "stderr";
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

const processSignals: Effect.Effect<NodeJS.Signals> = Effect.callback<NodeJS.Signals>((resume) => {
  let settled = false;
  const remove = () => {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  };
  const receive = (signal: NodeJS.Signals) => {
    if (settled) return;
    settled = true;
    remove();
    resume(Effect.succeed(signal));
  };
  const onInterrupt = () => receive("SIGINT");
  const onTerminate = () => receive("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  return Effect.sync(remove);
});

const statusCodeFields = (result: AccessCheckResult) =>
  result.status === undefined ? {} : { responseStatus: result.status };

const reasonFields = (result: AccessCheckResult) =>
  result.reason === undefined ? {} : { reason: result.reason };

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

interface ProcessExitObservation {
  readonly state: { result: ProcessResult | undefined };
  readonly effect: Effect.Effect<ProcessResult>;
}

const observeProcessExit = (running: RunningProcess): ProcessExitObservation => {
  const state: ProcessExitObservation["state"] = { result: undefined };
  const promise = running.exited.then(
    (result) => {
      state.result = result;
      return result;
    },
    () => {
      const result = {
        exitCode: 127,
        stderr: "process exit could not be observed",
      } satisfies ProcessResult;
      state.result = result;
      return result;
    },
  );
  return { state, effect: Effect.promise(() => promise) };
};

const currentProcessExit = (observation: ProcessExitObservation) => observation.state.result;

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
  const detail = error instanceof Error ? `: ${error.message}` : "";
  return makeDiagnostic(
    "dependency-unavailable",
    `${context.selectedService} could not be started${detail}`,
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

const outputWithFailure = (
  output: LauncherOutput,
  diagnostic: Diagnostic,
  cleanupDiagnostic?: Diagnostic,
): LauncherOutput => ({
  ...output,
  ok: false,
  readiness: "blocked",
  errors: [diagnostic, ...(cleanupDiagnostic === undefined ? [] : [cleanupDiagnostic])],
});

const terminalOutput = (
  output: LauncherOutput,
  status: FastExecutionOutcomeStatus,
  diagnostic?: Diagnostic,
  cleanupDiagnostic?: Diagnostic,
): LauncherOutput => {
  if (diagnostic !== undefined) {
    return {
      ...outputWithFailure(output, diagnostic, cleanupDiagnostic),
      readiness: output.readiness === "ready" ? "ready" : "blocked",
    };
  }
  if (cleanupDiagnostic !== undefined) {
    return {
      ...outputWithFailure(output, cleanupDiagnostic),
      readiness: output.readiness === "ready" ? "ready" : "blocked",
    };
  }
  return {
    ...output,
    readiness: status === "stopped" && output.readiness !== "ready" ? "stopped" : output.readiness,
  };
};

const resultWithTerminal = (
  context: FastExecutionContext,
  state: ExecutionState,
  status: FastExecutionOutcomeStatus,
  exitCode: number,
  diagnostic?: Diagnostic,
  cleanupDiagnostic?: Diagnostic,
  readyOutput?: LauncherOutput,
): FastExecutionResult => {
  const baseOutput = readyOutput ?? context.plannedOutput;
  const output = terminalOutput(baseOutput, status, diagnostic, cleanupDiagnostic);
  const outcome: FastExecutionOutcome = {
    status,
    ok: status === "completed" || status === "stopped",
    exitCode,
    ...(diagnostic === undefined ? {} : { diagnostic }),
    ...(cleanupDiagnostic === undefined ? {} : { cleanupDiagnostic }),
  };
  return {
    output,
    observations: state.observations,
    outcome,
    ...(readyOutput === undefined ? {} : { readyOutput }),
  };
};

const emitTerminal = (
  context: FastExecutionContext,
  state: ExecutionState,
  outcome: FastExecutionOutcome,
  observer?: (observation: LifecycleObservation) => void,
) => {
  const next = {
    type: "terminal" as const,
    outcome: outcome.status,
    exitCode: outcome.exitCode,
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
) => emitTerminal(context, state, result.outcome, options.onObservation).pipe(Effect.as(result));

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
        "blocked",
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
