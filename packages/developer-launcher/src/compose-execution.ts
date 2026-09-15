import { Cause, Duration, Effect, Exit, Match, Option, Predicate, Schema } from "effect";
import { readEnvironmentFile } from "./config";
import { makeDiagnostic } from "./diagnostics";
import {
  currentProcessExit,
  makeExecutionResultFromContext,
  observeProcessExit,
  processSignals,
  reasonFields,
  statusCodeFields,
  terminalOutput,
} from "./execution-shared";
import { spawnProcess, startLongLivedProcess } from "./executor";
import {
  composeServices,
  type AccessCheckResult,
  type ComposeAction,
  type ComposeService,
  type Diagnostic,
  type LauncherOutput,
  type ProcessExecutor,
  type ProcessRequest,
  type ProcessResult,
  type ProcessStarter,
  type RunningProcess,
} from "./types";

const defaultComposeFiniteTimeoutMs = 30 * 60_000;
const defaultComposeStartupTimeoutMs = 150_000;
const defaultComposeCleanupTimeoutMs = 15_000;
const composeInspectionTimeoutMs = 5_000;
const composeApplicationStartupGraceMs = 30_000;
const composeApplicationRetryIntervalMs = 5_000;
const defaultComposePollIntervalMs = composeApplicationRetryIntervalMs;
const composeApplicationRetries = 20;
const longLivedProcessTimeoutMs = 2_147_000_000;

export interface ComposeExecutionStep {
  readonly id: string;
  readonly request: ProcessRequest;
  readonly longLived: boolean;
}

export interface ComposeExecutionContext {
  readonly mode: "compose";
  readonly action: ComposeAction;
  readonly selectedServices: readonly ComposeService[];
  readonly projectName: string;
  readonly checkoutState: string;
  readonly cwd: string;
  readonly envFile: string | null;
  readonly environment: Readonly<Record<string, string>>;
  readonly steps: readonly ComposeExecutionStep[];
  readonly plannedOutput: LauncherOutput;
  readonly readinessTimeoutMs: number;
  readonly pollIntervalMs: number;
}

export interface ComposeExecutionContextOptions {
  readonly environment?: Readonly<Record<string, string>>;
  readonly finiteTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly readinessTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface ComposeContainerState {
  readonly id: string;
  readonly service: ComposeService;
  readonly name?: string;
  readonly oneOff?: boolean;
  readonly state: "created" | "running" | "restarting" | "paused" | "exited" | "dead" | "unknown";
  readonly exitCode?: number;
}

export interface ComposeContainerQuery {
  readonly projectName: string;
  readonly envFile: string | null;
  readonly cwd: string;
  readonly services: readonly ComposeService[];
  readonly timeoutMs: number;
}

export interface ComposeReadinessRequest {
  readonly projectName: string;
  readonly service: ComposeService;
  readonly container: ComposeContainerState;
  readonly timeoutMs: number;
}

export interface ComposeCleanupRequest {
  readonly projectName: string;
  readonly envFile: string | null;
  readonly cwd: string;
  readonly services: readonly ComposeService[];
  readonly containers: readonly ComposeContainerState[];
  readonly timeoutMs: number;
}

export interface ComposeCleanupResult {
  readonly verified: boolean;
  readonly remaining: readonly ComposeContainerState[];
  readonly reason?: string;
}

export interface ComposeStateAdapter {
  readonly listApplicationContainers: (
    request: ComposeContainerQuery,
  ) => Promise<readonly ComposeContainerState[]>;
  readonly probeApplicationReadiness: (
    request: ComposeReadinessRequest,
  ) => Promise<AccessCheckResult>;
  readonly stopApplicationContainers: (
    request: ComposeCleanupRequest,
  ) => Promise<ComposeCleanupResult>;
}

type ComposeLifecycleObservationDetail =
  | {
      readonly type: "validated";
    }
  | {
      readonly type: "step";
      readonly id: string;
      readonly status: "started" | "completed" | "failed";
      readonly exitCode?: number;
      readonly reason?: string;
    }
  | {
      readonly type: "started";
      readonly containers: readonly string[];
    }
  | {
      readonly type: "readiness";
      readonly service: ComposeService;
      readonly status: "checking" | "ready" | "blocked";
      readonly allSelected?: boolean;
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
      readonly containers: readonly string[];
      readonly reason?: string;
    }
  | {
      readonly type: "terminal";
      readonly outcome: ComposeExecutionOutcomeStatus;
      readonly exitCode: number;
    };

export type ComposeLifecycleObservation = ComposeLifecycleObservationDetail & {
  readonly sequence: number;
  readonly mode: "compose";
  readonly action: ComposeAction;
  readonly selectedServices: readonly ComposeService[];
};

export type ComposeExecutionOutcomeStatus = "completed" | "stopped" | "blocked" | "failed";

export interface ComposeExecutionOutcome {
  readonly status: ComposeExecutionOutcomeStatus;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly diagnostic?: Diagnostic;
  readonly cleanupDiagnostic?: Diagnostic;
}

export interface ComposeExecutionResult {
  readonly output: LauncherOutput;
  readonly observations: readonly ComposeLifecycleObservation[];
  readonly outcome: ComposeExecutionOutcome;
  readonly readyOutput?: LauncherOutput;
}

export interface ComposeExecutionOptions {
  readonly executor?: ProcessExecutor;
  readonly processStarter?: ProcessStarter;
  readonly stateAdapter?: ComposeStateAdapter;
  readonly interruptions?: Effect.Effect<NodeJS.Signals>;
  readonly finiteTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly readinessTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly output?: "inherit" | "stderr";
  readonly onObservation?: (observation: ComposeLifecycleObservation) => void;
}

type ComposeProcessPhase =
  | { readonly type: "stopped"; readonly signal: NodeJS.Signals }
  | {
      readonly type: "startup-exit";
      readonly result: ProcessResult;
      readonly service?: ComposeService;
      readonly readinessResult?: AccessCheckResult;
    }
  | { readonly type: "ready" }
  | { readonly type: "running-exit"; readonly result: ProcessResult };

type ComposeProcessStage =
  | {
      readonly type: "failed";
      readonly cause: Cause.Cause<unknown>;
      readonly cleanupDiagnostic?: Diagnostic;
    }
  | {
      readonly type: "stopped";
      readonly signal: NodeJS.Signals;
      readonly cleanupDiagnostic?: Diagnostic;
    }
  | {
      readonly type: "phase";
      readonly phase: ComposeProcessPhase;
      readonly cleanupDiagnostic?: Diagnostic;
    };

type ExecutionState = {
  sequence: number;
  observations: ComposeLifecycleObservation[];
};

type OwnedContainers = Map<string, ComposeContainerState>;

type ReadyComposeContainer = {
  readonly service: ComposeService;
  readonly state: ComposeContainerState["state"];
};

type StateInspection = { failed: boolean };

type CleanupState = { diagnostic?: Diagnostic; performed: boolean };

type ContainerOwnership = {
  readonly baselineIds: ReadonlySet<string>;
  readonly baselineKnown: boolean;
};

class ComposeStartupTimeout extends Error {
  readonly _tag = "ComposeStartupTimeout";
}

const isComposeService = (value: string): value is ComposeService =>
  (composeServices as readonly string[]).includes(value);

const isComposeAction = (value: string): value is ComposeAction =>
  ["up", "build", "down", "seed", "reset"].includes(value);

const isHttpReady = (result: AccessCheckResult) =>
  result.reachable && result.status !== undefined && result.status >= 200 && result.status < 300;

const isRunning = (container: ComposeContainerState) =>
  container.state === "running" || container.state === "restarting";

const firstArgumentValue = (args: readonly string[], flag: string) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};

const composeProjectFromOutput = (output: LauncherOutput) => {
  const projectName = output.plannedProcesses
    .flatMap(({ args }) => [firstArgumentValue(args, "--project-name")])
    .find((value): value is string => value !== undefined);
  if (projectName !== undefined) return projectName;
  const checkoutState = output.checkoutState?.replace(/^Checkout State /, "");
  if (checkoutState === undefined || checkoutState === "") {
    throw new Error("Compose execution is missing its Checkout State project");
  }
  return checkoutState;
};

const envFileFromOutput = (output: LauncherOutput) =>
  output.plannedProcesses
    .flatMap(({ args }) => [firstArgumentValue(args, "--env-file")])
    .find((value): value is string => value !== undefined) ?? null;

const publicComposeEnvironment = (output: LauncherOutput) =>
  Object.fromEntries(
    [
      ["SHEET_WEB_PUBLIC_BASE_URL", "app"],
      ["SHEET_AUTH_PUBLIC_BASE_URL", "auth"],
      ["SHEET_ZERO_PUBLIC_BASE_URL", "zero"],
      ["SHEET_WORKFLOWS_PUBLIC_BASE_URL", "workflows"],
    ].flatMap(([key, name]) => {
      const url = output.urls.find((plannedUrl) => plannedUrl.name === name)?.url;
      return url === undefined ? [] : [[key, url]];
    }),
  );

const readValidatedEnvironmentFile = (filePath: string) => {
  const file = readEnvironmentFile(filePath);
  if (file.errors.length > 0) {
    throw new Error(
      file.errors
        .map(
          ({ code, message, remediation }) => `[${code}] ${message}\n  remediation: ${remediation}`,
        )
        .join("\n"),
    );
  }
  return file.values;
};

export const makeComposeExecutionContext = (
  output: LauncherOutput,
  cwd: string,
  options: ComposeExecutionContextOptions = {},
): ComposeExecutionContext => {
  if (
    !output.ok ||
    output.mode !== "compose" ||
    output.action === null ||
    !isComposeAction(output.action)
  ) {
    throw new Error("Compose execution requires a valid Compose action plan");
  }
  if (
    output.selectedServices.length === 0 ||
    output.selectedServices.some((value) => !isComposeService(value))
  ) {
    throw new Error("Compose execution has an invalid selected service");
  }
  const selectedServices = output.selectedServices.filter(isComposeService);
  const action = output.action;
  const projectName = composeProjectFromOutput(output);
  const envFile = envFileFromOutput(output);
  const fileEnvironment =
    options.environment === undefined && envFile !== null
      ? readValidatedEnvironmentFile(envFile)
      : {};
  const environment = {
    ...publicComposeEnvironment(output),
    ...fileEnvironment,
    ...options.environment,
  };
  const finiteTimeoutMs = options.finiteTimeoutMs ?? defaultComposeFiniteTimeoutMs;
  const startupTimeoutMs = options.startupTimeoutMs ?? defaultComposeStartupTimeoutMs;
  const readinessTimeoutMs =
    options.readinessTimeoutMs ??
    composeApplicationStartupGraceMs +
      composeApplicationRetryIntervalMs * composeApplicationRetries;
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? defaultComposePollIntervalMs);
  const steps = output.plannedProcesses.map((planned) => ({
    id: planned.id,
    request: {
      command: planned.command,
      args: planned.args,
      cwd,
      env: environment,
      timeoutMs: planned.longLived ? startupTimeoutMs : finiteTimeoutMs,
      kind: "runtime" as const,
      readOnly: planned.readOnly,
    },
    longLived: planned.longLived,
  }));
  if (action === "up" && steps.filter(({ longLived }) => longLived).length !== 1) {
    throw new Error("Compose up execution requires one long-lived application step");
  }
  if (action !== "up" && steps.some(({ longLived }) => longLived)) {
    throw new Error("Finite Compose actions cannot contain a long-lived step");
  }
  return {
    mode: "compose",
    action,
    selectedServices,
    projectName,
    checkoutState: output.checkoutState ?? `Checkout State ${projectName}`,
    cwd,
    envFile,
    environment,
    steps,
    plannedOutput: output,
    readinessTimeoutMs,
    pollIntervalMs,
  };
};

const composePrefix = (projectName: string, envFile: string | null) => [
  "compose",
  "--project-name",
  projectName,
  ...(envFile === null ? [] : ["--env-file", envFile]),
];

const parseExitCode = (value: unknown) => {
  const parsed = Predicate.isNumber(value)
    ? value
    : Predicate.isString(value) && value !== ""
      ? Number(value)
      : Number.NaN;
  return Number.isInteger(parsed) ? parsed : undefined;
};

const containerStateMatchers: readonly (readonly [
  (value: string) => boolean,
  ComposeContainerState["state"],
])[] = [
  [(value) => value.startsWith("up") || value === "running", "running"],
  [(value) => value.startsWith("restarting"), "restarting"],
  [(value) => value.startsWith("created"), "created"],
  [(value) => value.startsWith("paused"), "paused"],
  [(value) => value.startsWith("dead"), "dead"],
  [(value) => value.startsWith("exit"), "exited"],
];

const normalizeContainerState = (value: string): ComposeContainerState["state"] =>
  containerStateMatchers.find(([matches]) => matches(value))?.[1] ?? "unknown";

// fallow-ignore-next-line complexity
const containerState = (value: unknown): ComposeContainerState | undefined => {
  let item: Readonly<Record<string, unknown>>;
  try {
    item = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(value);
  } catch {
    return undefined;
  }
  const property = (key: string) => (Predicate.hasProperty(item, key) ? item[key] : undefined);
  const serviceValue = property("Service") ?? property("service");
  const idValue = property("ID") ?? property("Id") ?? property("id");
  if (!Predicate.isString(serviceValue) || !isComposeService(serviceValue)) return undefined;
  if (!Predicate.isString(idValue) || idValue.length === 0) return undefined;
  const rawStateValue = property("State") ?? property("state") ?? property("Status");
  const rawState = (Predicate.isString(rawStateValue) ? rawStateValue : "").toLowerCase();
  const state = normalizeContainerState(rawState);
  const name = property("Name") ?? property("name");
  const oneOffValue = property("IsOneOff") ?? property("isOneOff");
  const oneOff = Predicate.isBoolean(oneOffValue)
    ? oneOffValue
    : Predicate.isString(oneOffValue)
      ? oneOffValue.toLowerCase() === "true"
      : undefined;
  const exitCode = parseExitCode(property("ExitCode") ?? property("exitCode"));
  return {
    id: idValue,
    service: serviceValue,
    ...(typeof name === "string" ? { name } : {}),
    ...(oneOff === undefined ? {} : { oneOff }),
    state,
    ...(exitCode === undefined ? {} : { exitCode }),
  } satisfies ComposeContainerState;
};

const parseComposePs = (stdout: string): readonly ComposeContainerState[] => {
  const text = stdout.trim();
  if (text === "") return [];
  const values: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) values.push(...parsed);
    else values.push(parsed);
  } catch {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try {
        values.push(JSON.parse(line));
      } catch {
        throw new Error("Docker Compose returned an unreadable container state");
      }
    }
  }
  return values.flatMap((value) => {
    const state = containerState(value);
    return state === undefined ? [] : [state];
  });
};

const probeScript =
  "fetch('http://127.0.0.1:3000/ready').then((response) => { process.stdout.write(String(response.status)); process.exit(response.ok ? 0 : 1); }).catch(() => process.exit(1))";

const statusFromOutput = (result: ProcessResult) => {
  const match = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/\b([2-5][0-9]{2})\b/);
  return match === null ? undefined : Number(match[1]);
};

const isSuccessfulProcess = (result: ProcessResult) => result.exitCode === 0 && !result.timedOut;

export const makeComposeStateAdapter = (
  executor: ProcessExecutor = spawnProcess,
  cwd = process.cwd(),
): ComposeStateAdapter => {
  const runDocker = (
    args: readonly string[],
    timeoutMs: number,
    readOnly: boolean,
  ): Promise<ProcessResult> =>
    executor({
      command: "docker",
      args,
      cwd,
      env: {},
      timeoutMs,
      kind: "runtime",
      readOnly,
      output: "capture",
    });

  const listApplicationContainers = async (request: ComposeContainerQuery) => {
    const result = await runDocker(
      [
        ...composePrefix(request.projectName, request.envFile),
        "ps",
        "--all",
        "--format",
        "json",
        ...request.services,
      ],
      request.timeoutMs,
      true,
    );
    if (!isSuccessfulProcess(result))
      throw new Error("Compose container state could not be inspected");
    return parseComposePs(result.stdout ?? "");
  };

  const probeApplicationReadiness = async (request: ComposeReadinessRequest) => {
    const result = await runDocker(
      ["exec", request.container.id, "node", "-e", probeScript],
      request.timeoutMs,
      true,
    );
    const status = statusFromOutput(result);
    return {
      reachable:
        isSuccessfulProcess(result) && status !== undefined && status >= 200 && status < 300,
      ...(status === undefined ? {} : { status }),
      ...(result.timedOut
        ? { timedOut: true, reason: "in-container readiness probe timed out" }
        : isSuccessfulProcess(result)
          ? {}
          : { reason: `GET /ready failed for ${request.service}` }),
    } satisfies AccessCheckResult;
  };

  // fallow-ignore-next-line complexity
  const stopApplicationContainers = async (
    request: ComposeCleanupRequest,
  ): Promise<ComposeCleanupResult> => {
    const containers = [
      ...new Map(request.containers.map((container) => [container.id, container])).values(),
    ];
    if (containers.length === 0) return { verified: true, remaining: [] };
    const ids = containers.map(({ id }) => id);
    const query: ComposeContainerQuery = {
      projectName: request.projectName,
      envFile: request.envFile,
      cwd: request.cwd,
      services: request.services,
      timeoutMs: request.timeoutMs,
    };
    const stopGraceSeconds = Math.max(1, Math.floor(request.timeoutMs / 3_000));
    await runDocker(
      ["stop", "--time", String(stopGraceSeconds), "--", ...ids],
      request.timeoutMs,
      false,
    );
    let states: readonly ComposeContainerState[] = [];
    let stateError: unknown;
    try {
      states = await listApplicationContainers(query);
    } catch (error) {
      stateError = error;
    }
    const requested = new Set(ids);
    let remaining = states.filter(
      (container) => requested.has(container.id) && isRunning(container),
    );
    if (remaining.length > 0 || stateError !== undefined) {
      const escalationIds = remaining.length > 0 ? remaining.map(({ id }) => id) : ids;
      await runDocker(
        ["kill", "--signal", "SIGKILL", "--", ...escalationIds],
        request.timeoutMs,
        false,
      );
      try {
        states = await listApplicationContainers(query);
        stateError = undefined;
      } catch (error) {
        stateError = error;
      }
      remaining = states.filter((container) => requested.has(container.id) && isRunning(container));
    }
    if (stateError !== undefined) {
      return {
        verified: false,
        remaining,
        reason:
          stateError instanceof Error
            ? stateError.message
            : "container termination could not be inspected",
      };
    }
    return {
      verified: remaining.length === 0,
      remaining,
      ...(remaining.length === 0 ? {} : { reason: "application containers are still running" }),
    };
  };

  return { listApplicationContainers, probeApplicationReadiness, stopApplicationContainers };
};

const interrupted = (options: ComposeExecutionOptions) =>
  (options.interruptions ?? processSignals).pipe(
    Effect.map((signal) => ({ type: "stopped" as const, signal })),
  );

const notify = (
  state: ExecutionState,
  context: ComposeExecutionContext,
  observation: ComposeLifecycleObservationDetail,
  observer?: (observation: ComposeLifecycleObservation) => void,
) =>
  Effect.sync(() => {
    const next = {
      sequence: state.sequence + 1,
      mode: context.mode,
      action: context.action,
      selectedServices: context.selectedServices,
      ...observation,
    } as ComposeLifecycleObservation;
    state.sequence = next.sequence;
    state.observations.push(next);
    observer?.(next);
  });

const composeQuery = (
  context: ComposeExecutionContext,
  timeoutMs: number,
): ComposeContainerQuery => ({
  projectName: context.projectName,
  envFile: context.envFile,
  cwd: context.cwd,
  services: context.selectedServices,
  timeoutMs,
});

const addOwnedContainers = (
  owned: OwnedContainers,
  containers: readonly ComposeContainerState[],
  ownership?: ContainerOwnership,
) => {
  for (const container of containers) {
    if (
      ownership !== undefined &&
      (!ownership.baselineKnown || ownership.baselineIds.has(container.id))
    ) {
      continue;
    }
    owned.set(container.id, container);
  }
};

const stateSnapshot = (
  context: ComposeExecutionContext,
  adapter: ComposeStateAdapter,
  owned: OwnedContainers,
  timeoutMs: number,
  inspection: StateInspection,
  ownership?: ContainerOwnership,
) =>
  Effect.tryPromise(() => adapter.listApplicationContainers(composeQuery(context, timeoutMs))).pipe(
    Effect.map((containers) => {
      inspection.failed = false;
      addOwnedContainers(owned, containers, ownership);
      return containers;
    }),
    Effect.catch(() => {
      inspection.failed = true;
      return Effect.succeed<readonly ComposeContainerState[]>([]);
    }),
  );

const boundedComposeTimeout = (deadline: number) =>
  Math.min(composeInspectionTimeoutMs, Math.max(1, deadline - Date.now()));

const readinessDiagnostic = (
  context: ComposeExecutionContext,
  service: ComposeService,
  result?: AccessCheckResult,
) =>
  makeDiagnostic(
    "dependency-timeout",
    `${service} did not become ready in Checkout State ${context.projectName}${
      result?.status === undefined ? "" : ` (HTTP ${result.status})`
    }`,
    `Fix ${service} startup and make GET /ready return a 2xx response inside its Compose container before the readiness deadline.`,
    { mode: context.mode, action: context.action, dependency: service },
  );

const processExitDiagnostic = (
  context: ComposeExecutionContext,
  service: ComposeService,
  result: ProcessResult,
  phase: "startup" | "running",
) =>
  makeDiagnostic(
    "required-dependency-failed",
    `${service} Compose execution exited with code ${result.exitCode} ${phase === "startup" ? "before becoming ready" : "after becoming ready"}`,
    `Inspect the ${service} container logs, fix the startup failure, and retry Compose ${context.action}.`,
    { mode: context.mode, action: context.action, dependency: service },
  );

const stepDiagnostic = (
  context: ComposeExecutionContext,
  step: ComposeExecutionStep,
  result: ProcessResult,
) =>
  makeDiagnostic(
    result.timedOut ? "dependency-timeout" : "required-dependency-failed",
    `${step.id} failed with exit code ${result.exitCode}`,
    `Fix ${step.id} and retry pnpm dev compose ${context.action}. No later Compose step was started.`,
    { mode: context.mode, action: context.action, dependency: step.id },
  );

const startupDiagnostic = (context: ComposeExecutionContext, cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return makeDiagnostic(
    error instanceof ComposeStartupTimeout ? "dependency-timeout" : "dependency-unavailable",
    error instanceof ComposeStartupTimeout
      ? `Compose applications did not start within ${context.steps.find(({ longLived }) => longLived)?.request.timeoutMs ?? defaultComposeStartupTimeoutMs}ms`
      : "Compose applications could not be attached",
    error instanceof ComposeStartupTimeout
      ? "Fix Compose application startup and retry before the bounded startup deadline."
      : "Verify Docker Compose is available and retry the same Compose command.",
    { mode: context.mode, action: context.action },
  );
};

const resultWithTerminal = (
  context: ComposeExecutionContext,
  state: ExecutionState,
  status: ComposeExecutionOutcomeStatus,
  exitCode: number,
  diagnostic?: Diagnostic,
  cleanupDiagnostic?: Diagnostic,
  readyOutput?: LauncherOutput,
): ComposeExecutionResult => {
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
  context: ComposeExecutionContext,
  state: ExecutionState,
  result: ComposeExecutionResult,
  observer?: (observation: ComposeLifecycleObservation) => void,
) =>
  notify(
    state,
    context,
    { type: "terminal", outcome: result.outcome.status, exitCode: result.outcome.exitCode },
    observer,
  ).pipe(Effect.as(result));

const readyOutputFor = (context: ComposeExecutionContext, state: ExecutionState) =>
  state.observations.some(
    (observation) =>
      observation.type === "readiness" && observation.status === "ready" && observation.allSelected,
  )
    ? { ...context.plannedOutput, readiness: "ready" as const }
    : undefined;

const cleanupDiagnostic = (
  context: ComposeExecutionContext,
  reason?: string,
  timeoutMs = defaultComposeCleanupTimeoutMs,
) =>
  makeDiagnostic(
    "cleanup-failed",
    `Compose application container cleanup could not be verified within ${timeoutMs}ms${reason === undefined ? "" : `: ${reason}`}`,
    `Inspect Checkout State ${context.projectName}, stop its selected application containers manually, and verify that they are terminated.`,
    { mode: context.mode, action: context.action },
  );

type OwnedContainerCleanup = {
  readonly containers: readonly ComposeContainerState[];
  readonly failure: Diagnostic | undefined;
};

const stateCleanupFailure = (
  context: ComposeExecutionContext,
  options: ComposeExecutionOptions,
  inspection: StateInspection,
  ownership: ContainerOwnership,
) => {
  const timeoutMs = options.cleanupTimeoutMs ?? defaultComposeCleanupTimeoutMs;
  if (!ownership.baselineKnown) {
    return cleanupDiagnostic(
      context,
      "pre-start application container state could not be established",
      timeoutMs,
    );
  }
  return inspection.failed
    ? cleanupDiagnostic(context, "container state could not be inspected", timeoutMs)
    : undefined;
};

const stopContainers = (
  context: ComposeExecutionContext,
  options: ComposeExecutionOptions,
  adapter: ComposeStateAdapter,
  containers: readonly ComposeContainerState[],
): Effect.Effect<Diagnostic | undefined> => {
  const timeoutMs = options.cleanupTimeoutMs ?? defaultComposeCleanupTimeoutMs;
  return Effect.exit(
    Effect.tryPromise(() =>
      adapter.stopApplicationContainers({
        projectName: context.projectName,
        envFile: context.envFile,
        cwd: context.cwd,
        services: context.selectedServices,
        containers,
        timeoutMs,
      }),
    ).pipe(Effect.timeout(Duration.millis(timeoutMs))),
  ).pipe(
    Effect.map((exit) => {
      if (Exit.isFailure(exit))
        return cleanupDiagnostic(context, "container state could not be inspected", timeoutMs);
      return exit.value.verified
        ? undefined
        : cleanupDiagnostic(context, exit.value.reason, timeoutMs);
    }),
  );
};

// fallow-ignore-next-line complexity
const stopOwnedContainers = (
  context: ComposeExecutionContext,
  options: ComposeExecutionOptions,
  adapter: ComposeStateAdapter,
  owned: OwnedContainers,
  inspection: StateInspection,
  ownership: ContainerOwnership,
): Effect.Effect<OwnedContainerCleanup> =>
  // fallow-ignore-next-line complexity
  Effect.gen(function* () {
    if (owned.size === 0 || inspection.failed) {
      yield* stateSnapshot(
        context,
        adapter,
        owned,
        options.cleanupTimeoutMs ?? defaultComposeCleanupTimeoutMs,
        inspection,
        ownership,
      );
    }
    const containers = [...owned.values()];
    let failure = stateCleanupFailure(context, options, inspection, ownership);
    if (failure === undefined && containers.length > 0) {
      failure = yield* stopContainers(context, options, adapter, containers);
    }
    return { containers, failure };
  });

const cleanupCompose = (
  context: ComposeExecutionContext,
  options: ComposeExecutionOptions,
  adapter: ComposeStateAdapter,
  running: RunningProcess,
  owned: OwnedContainers,
  state: ExecutionState,
  cleanupState: CleanupState,
  inspection: StateInspection,
  ownership: ContainerOwnership,
) =>
  // fallow-ignore-next-line complexity
  Effect.gen(function* () {
    cleanupState.performed = true;
    if (owned.size === 0 || inspection.failed) {
      yield* stateSnapshot(
        context,
        adapter,
        owned,
        options.cleanupTimeoutMs ?? defaultComposeCleanupTimeoutMs,
        inspection,
        ownership,
      );
    }
    const containers = [...owned.values()];
    yield* notify(
      state,
      context,
      { type: "cleanup", status: "started", containers: containers.map(({ id }) => id) },
      options.onObservation,
    );
    const processExit = yield* Effect.exit(
      Effect.tryPromise(() => running.kill()).pipe(
        Effect.timeout(Duration.millis(options.cleanupTimeoutMs ?? defaultComposeCleanupTimeoutMs)),
      ),
    );
    let failure = stateCleanupFailure(context, options, inspection, ownership);
    if (failure === undefined && Exit.isFailure(processExit)) {
      failure = cleanupDiagnostic(
        context,
        "the attached Compose command did not terminate",
        options.cleanupTimeoutMs ?? defaultComposeCleanupTimeoutMs,
      );
    }
    const containerCleanup = yield* stopOwnedContainers(
      context,
      options,
      adapter,
      owned,
      inspection,
      ownership,
    );
    failure ??= containerCleanup.failure;
    if (failure === undefined) {
      yield* notify(
        state,
        context,
        {
          type: "cleanup",
          status: "completed",
          containers: containerCleanup.containers.map(({ id }) => id),
        },
        options.onObservation,
      );
    } else {
      cleanupState.diagnostic = failure;
      yield* notify(
        state,
        context,
        {
          type: "cleanup",
          status: "failed",
          containers: containerCleanup.containers.map(({ id }) => id),
          reason: failure.message,
        },
        options.onObservation,
      );
    }
  });

const cleanupOrphanedComposeContainers = (
  context: ComposeExecutionContext,
  options: ComposeExecutionOptions,
  adapter: ComposeStateAdapter,
  owned: OwnedContainers,
  state: ExecutionState,
  cleanupState: CleanupState,
  inspection: StateInspection,
  ownership: ContainerOwnership,
): Effect.Effect<Diagnostic | undefined> =>
  Effect.gen(function* () {
    cleanupState.performed = true;
    if (owned.size === 0 || inspection.failed) {
      yield* stateSnapshot(
        context,
        adapter,
        owned,
        options.cleanupTimeoutMs ?? defaultComposeCleanupTimeoutMs,
        inspection,
        ownership,
      );
    }
    const initialContainers = [...owned.values()];
    yield* notify(
      state,
      context,
      { type: "cleanup", status: "started", containers: initialContainers.map(({ id }) => id) },
      options.onObservation,
    );
    const containerCleanup = yield* stopOwnedContainers(
      context,
      options,
      adapter,
      owned,
      inspection,
      ownership,
    );
    const containers = containerCleanup.containers;
    if (containerCleanup.failure === undefined) {
      yield* notify(
        state,
        context,
        { type: "cleanup", status: "completed", containers: containers.map(({ id }) => id) },
        options.onObservation,
      );
      return undefined;
    }
    cleanupState.diagnostic = containerCleanup.failure;
    yield* notify(
      state,
      context,
      {
        type: "cleanup",
        status: "failed",
        containers: containers.map(({ id }) => id),
        reason: containerCleanup.failure.message,
      },
      options.onObservation,
    );
    return containerCleanup.failure;
  });

const startComposeProcess = (
  context: ComposeExecutionContext,
  step: ComposeExecutionStep,
  options: ComposeExecutionOptions,
) => {
  const starter = options.processStarter ?? startLongLivedProcess;
  const request =
    options.output === undefined ? step.request : { ...step.request, output: options.output };
  const startupTimeoutMs = options.startupTimeoutMs ?? step.request.timeoutMs;
  return Effect.timeoutOption(
    Effect.tryPromise({
      try: (signal) => starter({ ...request, timeoutMs: longLivedProcessTimeoutMs }, signal),
      catch: (cause) => cause,
    }),
    Duration.millis(startupTimeoutMs),
  ).pipe(
    Effect.flatMap((running) =>
      Option.isNone(running)
        ? Effect.fail(new ComposeStartupTimeout("Compose application startup timed out"))
        : Effect.succeed(running.value),
    ),
  );
};

type ReadinessResult = Extract<ComposeProcessPhase, { readonly type: "ready" | "startup-exit" }>;

const isPreExistingOneOff = (container: ComposeContainerState, ownership: ContainerOwnership) =>
  ownership.baselineIds.has(container.id) && container.oneOff === true;

const composeServiceReadiness = (
  context: ComposeExecutionContext,
  adapter: ComposeStateAdapter,
  containers: readonly ComposeContainerState[],
  service: ComposeService,
  deadline: number,
  ownership: ContainerOwnership,
  readyContainers: Map<string, ReadyComposeContainer>,
) => {
  const runningContainers = containers.filter(
    (container) =>
      container.service === service &&
      !isPreExistingOneOff(container, ownership) &&
      isRunning(container),
  );
  if (runningContainers.length === 0) {
    return Effect.succeed<AccessCheckResult>({
      reachable: false,
      reason: "application container is not running",
    });
  }
  const containersToProbe = runningContainers.filter((container) => {
    const ready = readyContainers.get(container.id);
    return ready === undefined || ready.service !== service || ready.state !== container.state;
  });
  if (containersToProbe.length === 0) {
    return Effect.succeed<AccessCheckResult>({ reachable: true, status: 200 });
  }
  return Effect.all(
    containersToProbe.map((container) =>
      Effect.tryPromise(() =>
        adapter.probeApplicationReadiness({
          projectName: context.projectName,
          service,
          container,
          timeoutMs: boundedComposeTimeout(deadline),
        }),
      ).pipe(
        Effect.catch(() =>
          Effect.succeed({
            reachable: false,
            reason: "in-container readiness probe failed",
          } satisfies AccessCheckResult),
        ),
        Effect.map((result) => [container, result] as const),
      ),
    ),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((results) => {
      for (const [container, result] of results) {
        if (isHttpReady(result)) {
          readyContainers.set(container.id, { service, state: container.state });
        } else {
          readyContainers.delete(container.id);
        }
      }
      return (
        results.find(([, result]) => !isHttpReady(result))?.[1] ??
        (runningContainers.every(({ id }) => readyContainers.has(id))
          ? { reachable: true, status: 200 }
          : { reachable: false, reason: "in-container readiness probe failed" })
      );
    }),
  );
};

const pruneReadyComposeContainers = (
  readyContainers: Map<string, ReadyComposeContainer>,
  containers: readonly ComposeContainerState[],
) => {
  for (const [id, ready] of readyContainers) {
    const current = containers.find((container) => container.id === id);
    if (
      current === undefined ||
      current.service !== ready.service ||
      current.state !== ready.state ||
      !isRunning(current)
    ) {
      readyContainers.delete(id);
    }
  }
};

const composeReadinessChecks = (
  context: ComposeExecutionContext,
  adapter: ComposeStateAdapter,
  containers: readonly ComposeContainerState[],
  deadline: number,
  ownership: ContainerOwnership,
  readyContainers: Map<string, ReadyComposeContainer>,
) =>
  Effect.all(
    context.selectedServices.map((service) =>
      composeServiceReadiness(
        context,
        adapter,
        containers,
        service,
        deadline,
        ownership,
        readyContainers,
      ).pipe(Effect.map((result) => [service, result] as const)),
    ),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((entries) => new Map(entries)));

const exitedComposeContainer = (
  containers: readonly ComposeContainerState[],
  selectedServices: readonly ComposeService[],
  ownership: ContainerOwnership,
  owned: OwnedContainers,
) =>
  containers.find(
    (container) =>
      selectedServices.includes(container.service) &&
      !isPreExistingOneOff(container, ownership) &&
      owned.has(container.id) &&
      !isRunning(container) &&
      container.state !== "created",
  );

// fallow-ignore-next-line complexity
const waitForComposeReadiness = (
  context: ComposeExecutionContext,
  options: ComposeExecutionOptions,
  adapter: ComposeStateAdapter,
  running: RunningProcess,
  owned: OwnedContainers,
  state: ExecutionState,
  inspection: StateInspection,
  ownership: ContainerOwnership,
) =>
  // fallow-ignore-next-line complexity
  Effect.gen(function* () {
    const processExit = observeProcessExit(running);
    const deadline = Date.now() + (options.readinessTimeoutMs ?? context.readinessTimeoutMs);
    const readyServices = new Set<ComposeService>();
    const readyContainers = new Map<string, ReadyComposeContainer>();
    let lastChecks = new Map<ComposeService, AccessCheckResult>();
    for (const service of context.selectedServices) {
      yield* notify(
        state,
        context,
        { type: "readiness", service, status: "checking" },
        options.onObservation,
      );
    }
    while (Date.now() < deadline) {
      const exited = currentProcessExit(processExit);
      if (exited !== undefined) {
        yield* notify(
          state,
          context,
          { type: "exited", phase: "startup", exitCode: exited.exitCode },
          options.onObservation,
        );
        return { type: "startup-exit" as const, result: exited } satisfies ReadinessResult;
      }
      const containers = yield* stateSnapshot(
        context,
        adapter,
        owned,
        boundedComposeTimeout(deadline),
        inspection,
        ownership,
      );
      const terminalContainer = exitedComposeContainer(
        containers,
        context.selectedServices,
        ownership,
        owned,
      );
      if (terminalContainer !== undefined) {
        const result = {
          exitCode: terminalContainer.exitCode ?? 1,
          stderr: `${terminalContainer.service} container is ${terminalContainer.state}`,
        } satisfies ProcessResult;
        yield* notify(
          state,
          context,
          { type: "exited", phase: "startup", exitCode: result.exitCode },
          options.onObservation,
        );
        return {
          type: "startup-exit" as const,
          result,
          service: terminalContainer.service,
        } satisfies ReadinessResult;
      }
      pruneReadyComposeContainers(readyContainers, containers);
      const checks = yield* composeReadinessChecks(
        context,
        adapter,
        containers,
        deadline,
        ownership,
        readyContainers,
      );
      lastChecks = checks;
      for (const service of context.selectedServices) {
        const result = checks.get(service);
        if (result === undefined || !isHttpReady(result)) {
          readyServices.delete(service);
          continue;
        }
        if (readyServices.has(service)) continue;
        readyServices.add(service);
        yield* notify(
          state,
          context,
          {
            type: "readiness",
            service,
            status: "ready",
            allSelected: readyServices.size === context.selectedServices.length,
            ...statusCodeFields(result),
          },
          options.onObservation,
        );
      }
      if (readyServices.size === context.selectedServices.length)
        return { type: "ready" } satisfies ReadinessResult;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const pause = Math.min(options.pollIntervalMs ?? context.pollIntervalMs, remaining);
      if (pause > 0) yield* Effect.sleep(Duration.millis(pause));
    }
    for (const service of context.selectedServices) {
      if (readyServices.has(service)) continue;
      const result = lastChecks.get(service) ?? { reachable: false };
      yield* notify(
        state,
        context,
        {
          type: "readiness",
          service,
          status: "blocked",
          ...statusCodeFields(result),
          ...reasonFields(result),
        },
        options.onObservation,
      );
    }
    const lastService = context.selectedServices.find((service) => !readyServices.has(service));
    const lastResult = lastService === undefined ? undefined : lastChecks.get(lastService);
    return {
      type: "startup-exit" as const,
      result: { exitCode: 1, timedOut: true } satisfies ProcessResult,
      ...(lastService === undefined ? {} : { service: lastService }),
      ...(lastResult === undefined ? {} : { readinessResult: lastResult }),
    } satisfies ReadinessResult;
  });

const processAfterComposeReadiness = (
  context: ComposeExecutionContext,
  options: ComposeExecutionOptions,
  running: RunningProcess,
  state: ExecutionState,
): Effect.Effect<ComposeProcessPhase> => {
  const processExit = observeProcessExit(running);
  const exitPhase: Effect.Effect<ComposeProcessPhase> = processExit.effect.pipe(
    Effect.tap((result) =>
      notify(
        state,
        context,
        { type: "exited", phase: "running", exitCode: result.exitCode },
        options.onObservation,
      ),
    ),
    Effect.map((result) => ({ type: "running-exit" as const, result })),
  );
  const interruption: Effect.Effect<ComposeProcessPhase> = interrupted(options).pipe(
    Effect.map(({ signal }) => ({ type: "stopped" as const, signal })),
  );
  return Effect.raceFirst(exitPhase, interruption);
};

const runComposeProcess = (
  context: ComposeExecutionContext,
  options: ComposeExecutionOptions,
  state: ExecutionState,
  step: ComposeExecutionStep,
): Effect.Effect<ComposeProcessStage> => {
  const adapter =
    options.stateAdapter ?? makeComposeStateAdapter(options.executor ?? spawnProcess, context.cwd);
  const owned: OwnedContainers = new Map();
  const cleanupState: CleanupState = { performed: false };
  const inspection: StateInspection = { failed: false };
  return Effect.gen(function* () {
    const baseline: OwnedContainers = new Map();
    const baselineInspection: StateInspection = { failed: false };
    yield* stateSnapshot(
      context,
      adapter,
      baseline,
      composeInspectionTimeoutMs,
      baselineInspection,
    );
    const ownership: ContainerOwnership = {
      baselineIds: new Set(baseline.keys()),
      baselineKnown: !baselineInspection.failed,
    };
    const lifecycle = { acquired: false };
    const scopedProcess = Effect.scoped(
      Effect.gen(function* () {
        const acquisition = startComposeProcess(context, step, options).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              lifecycle.acquired = true;
            }),
          ),
        );
        const running = yield* Effect.acquireRelease(
          acquisition,
          (process) =>
            cleanupCompose(
              context,
              options,
              adapter,
              process,
              owned,
              state,
              cleanupState,
              inspection,
              ownership,
            ),
          { interruptible: true },
        );
        yield* stateSnapshot(
          context,
          adapter,
          owned,
          composeInspectionTimeoutMs,
          inspection,
          ownership,
        );
        yield* notify(
          state,
          context,
          { type: "started", containers: [...owned.keys()] },
          options.onObservation,
        );
        const phase = yield* waitForComposeReadiness(
          context,
          options,
          adapter,
          running,
          owned,
          state,
          inspection,
          ownership,
        ).pipe(
          Effect.flatMap((readiness) =>
            readiness.type === "ready"
              ? processAfterComposeReadiness(context, options, running, state)
              : Effect.succeed(readiness),
          ),
        );
        return phase;
      }),
    ).pipe(Effect.map((phase) => ({ type: "phase" as const, phase })));
    const interruption: Effect.Effect<{
      readonly type: "stopped";
      readonly signal: NodeJS.Signals;
    }> = interrupted(options).pipe(
      Effect.map(({ signal }) => ({ type: "stopped" as const, signal })),
    );
    const stageExit = yield* Effect.exit(Effect.raceFirst(scopedProcess, interruption));
    if (!lifecycle.acquired && !cleanupState.performed) {
      yield* cleanupOrphanedComposeContainers(
        context,
        options,
        adapter,
        owned,
        state,
        cleanupState,
        inspection,
        ownership,
      );
    }
    if (Exit.isFailure(stageExit)) {
      return {
        type: "failed",
        cause: stageExit.cause,
        ...(cleanupState.diagnostic === undefined
          ? {}
          : { cleanupDiagnostic: cleanupState.diagnostic }),
      } satisfies ComposeProcessStage;
    }
    if (stageExit.value.type === "stopped") {
      return {
        type: "stopped",
        signal: stageExit.value.signal,
        ...(cleanupState.diagnostic === undefined
          ? {}
          : { cleanupDiagnostic: cleanupState.diagnostic }),
      } satisfies ComposeProcessStage;
    }
    return {
      type: "phase",
      phase: stageExit.value.phase,
      ...(cleanupState.diagnostic === undefined
        ? {}
        : { cleanupDiagnostic: cleanupState.diagnostic }),
    } satisfies ComposeProcessStage;
  });
};

const resultForComposePhase = (
  context: ComposeExecutionContext,
  state: ExecutionState,
  phase: ComposeProcessPhase,
  cleanupFailure: Diagnostic | undefined,
): ComposeExecutionResult =>
  Match.value(phase).pipe(
    Match.when({ type: "stopped" }, ({ signal }) => {
      const status = cleanupFailure === undefined ? "stopped" : "failed";
      return resultWithTerminal(
        context,
        state,
        status,
        status === "stopped" ? (signal === "SIGINT" ? 130 : 143) : 2,
        undefined,
        cleanupFailure,
        readyOutputFor(context, state),
      );
    }),
    Match.when({ type: "startup-exit" }, ({ result, service, readinessResult }) => {
      const selectedService = service ?? context.selectedServices[0] ?? "sheet-web";
      const diagnostic = result.timedOut
        ? readinessDiagnostic(context, selectedService, readinessResult)
        : processExitDiagnostic(context, selectedService, result, "startup");
      return resultWithTerminal(context, state, "blocked", 2, diagnostic, cleanupFailure);
    }),
    Match.when({ type: "running-exit" }, ({ result }) => {
      const readyOutput = { ...context.plannedOutput, readiness: "ready" as const };
      if (result.exitCode === 0 && cleanupFailure === undefined) {
        return resultWithTerminal(
          context,
          state,
          "completed",
          0,
          undefined,
          undefined,
          readyOutput,
        );
      }
      if (result.exitCode === 0) {
        return resultWithTerminal(
          context,
          state,
          "failed",
          2,
          undefined,
          cleanupFailure,
          readyOutput,
        );
      }
      return resultWithTerminal(
        context,
        state,
        "failed",
        result.exitCode,
        processExitDiagnostic(
          context,
          context.selectedServices[0] ?? "sheet-web",
          result,
          "running",
        ),
        cleanupFailure,
        readyOutput,
      );
    }),
    Match.when({ type: "ready" }, () =>
      resultWithTerminal(
        context,
        state,
        "failed",
        2,
        makeDiagnostic(
          "required-dependency-failed",
          "Compose execution ended without a terminal application state",
          "Retry the Compose command and inspect the launcher diagnostics.",
          { mode: context.mode, action: context.action },
        ),
        cleanupFailure,
      ),
    ),
    Match.exhaustive,
  );

const runFiniteStep = (
  context: ComposeExecutionContext,
  options: ComposeExecutionOptions,
  state: ExecutionState,
  step: ComposeExecutionStep,
): Effect.Effect<
  | { readonly type: "completed"; readonly result: ProcessResult }
  | { readonly type: "stopped"; readonly signal: NodeJS.Signals }
  | { readonly type: "failed"; readonly result: ProcessResult }
> =>
  Effect.gen(function* () {
    yield* notify(
      state,
      context,
      { type: "step", id: step.id, status: "started" },
      options.onObservation,
    );
    const executor = options.executor ?? spawnProcess;
    type FiniteRace =
      | { readonly type: "completed"; readonly result: ProcessResult }
      | { readonly type: "stopped"; readonly signal: NodeJS.Signals };
    const completedProcess: Effect.Effect<FiniteRace> = Effect.tryPromise(() =>
      executor({
        ...step.request,
        timeoutMs: options.finiteTimeoutMs ?? step.request.timeoutMs,
        output: options.output ?? "inherit",
      }),
    ).pipe(
      Effect.map((result) => ({ type: "completed" as const, result })),
      Effect.catch(() =>
        Effect.succeed({
          type: "completed" as const,
          result: {
            exitCode: 127,
            stderr: "Compose step could not be executed",
          } satisfies ProcessResult,
        }),
      ),
    );
    const interruption: Effect.Effect<FiniteRace> = interrupted(options).pipe(
      Effect.map(({ signal }) => ({ type: "stopped" as const, signal })),
    );
    const result = yield* Effect.exit(Effect.raceFirst(completedProcess, interruption));
    if (Exit.isFailure(result)) {
      const failed = {
        exitCode: 127,
        stderr: "Compose step could not be executed",
      } satisfies ProcessResult;
      yield* notify(
        state,
        context,
        {
          type: "step",
          id: step.id,
          status: "failed",
          exitCode: failed.exitCode,
          reason: failed.stderr,
        },
        options.onObservation,
      );
      return { type: "failed" as const, result: failed };
    }
    if (result.value.type === "stopped") {
      return result.value satisfies { readonly type: "stopped"; readonly signal: NodeJS.Signals };
    }
    if (!result.value.result.timedOut && [130, 143].includes(result.value.result.exitCode)) {
      return {
        type: "stopped" as const,
        signal: result.value.result.exitCode === 130 ? "SIGINT" : "SIGTERM",
      };
    }
    if (!isSuccessfulProcess(result.value.result)) {
      yield* notify(
        state,
        context,
        {
          type: "step",
          id: step.id,
          status: "failed",
          exitCode: result.value.result.exitCode,
          reason: result.value.result.timedOut ? "Compose step timed out" : "Compose step failed",
        },
        options.onObservation,
      );
      return { type: "failed" as const, result: result.value.result };
    }
    yield* notify(
      state,
      context,
      { type: "step", id: step.id, status: "completed", exitCode: result.value.result.exitCode },
      options.onObservation,
    );
    return { type: "completed" as const, result: result.value.result };
  });

type FiniteStepsResult =
  | { readonly type: "completed" }
  | { readonly type: "stopped"; readonly signal: NodeJS.Signals }
  | {
      readonly type: "failed";
      readonly step: ComposeExecutionStep;
      readonly result: ProcessResult;
    };

const runFiniteSteps = (
  context: ComposeExecutionContext,
  options: ComposeExecutionOptions,
  state: ExecutionState,
  steps: readonly ComposeExecutionStep[],
): Effect.Effect<FiniteStepsResult> =>
  Effect.gen(function* () {
    for (const step of steps) {
      const result = yield* runFiniteStep(context, options, state, step);
      if (result.type === "stopped") return result;
      if (result.type === "failed") return { type: "failed", step, result: result.result };
    }
    return { type: "completed" };
  });

const executeComposeEffect = (
  context: ComposeExecutionContext,
  options: ComposeExecutionOptions,
): Effect.Effect<ComposeExecutionResult> =>
  Effect.gen(function* () {
    const state: ExecutionState = { sequence: 0, observations: [] };
    yield* notify(state, context, { type: "validated" }, options.onObservation);
    const finiteSteps =
      context.action === "up" ? context.steps.filter(({ longLived }) => !longLived) : context.steps;
    const finiteResult = yield* runFiniteSteps(context, options, state, finiteSteps);
    if (finiteResult.type === "stopped") {
      const stopped = resultWithTerminal(
        context,
        state,
        "stopped",
        finiteResult.signal === "SIGINT" ? 130 : 143,
      );
      return yield* emitTerminal(context, state, stopped, options.onObservation);
    }
    if (finiteResult.type === "failed") {
      const failed = resultWithTerminal(
        context,
        state,
        "blocked",
        2,
        stepDiagnostic(context, finiteResult.step, finiteResult.result),
      );
      return yield* emitTerminal(context, state, failed, options.onObservation);
    }
    if (context.action !== "up") {
      const completed = resultWithTerminal(context, state, "completed", 0);
      return yield* emitTerminal(context, state, completed, options.onObservation);
    }
    const applicationStep = context.steps.find(({ longLived }) => longLived);
    if (applicationStep === undefined) {
      const failed = resultWithTerminal(
        context,
        state,
        "failed",
        2,
        makeDiagnostic(
          "required-dependency-failed",
          "Compose up has no application step",
          "Retry the Compose command after checking the generated plan.",
          { mode: context.mode, action: context.action },
        ),
      );
      return yield* emitTerminal(context, state, failed, options.onObservation);
    }
    const processStage = yield* runComposeProcess(context, options, state, applicationStep);
    const result = Match.value(processStage).pipe(
      Match.when({ type: "failed" }, ({ cause, cleanupDiagnostic }) =>
        resultWithTerminal(
          context,
          state,
          "blocked",
          2,
          startupDiagnostic(context, cause),
          cleanupDiagnostic,
        ),
      ),
      Match.when({ type: "stopped" }, ({ signal, cleanupDiagnostic }) =>
        resultWithTerminal(
          context,
          state,
          cleanupDiagnostic === undefined ? "stopped" : "failed",
          cleanupDiagnostic === undefined ? (signal === "SIGINT" ? 130 : 143) : 2,
          undefined,
          cleanupDiagnostic,
          readyOutputFor(context, state),
        ),
      ),
      Match.when({ type: "phase" }, ({ phase, cleanupDiagnostic }) =>
        resultForComposePhase(context, state, phase, cleanupDiagnostic),
      ),
      Match.exhaustive,
    );
    return yield* emitTerminal(context, state, result, options.onObservation);
  });

export const executeCompose = (
  context: ComposeExecutionContext,
  options: ComposeExecutionOptions = {},
): Effect.Effect<ComposeExecutionResult> => executeComposeEffect(context, options);

export const runComposeExecution = (
  context: ComposeExecutionContext,
  options: ComposeExecutionOptions = {},
): Promise<ComposeExecutionResult> => Effect.runPromise(executeCompose(context, options));
