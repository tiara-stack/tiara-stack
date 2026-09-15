import { Effect } from "effect";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DETERMINISTIC_PORTS,
  makeFastExecutionContext,
  runFastExecution,
  runLauncher,
  type AccessChecker,
  type FastExecutionResult,
  type LauncherOutput,
} from "../packages/developer-launcher/src/index";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDirectory = path.join(repository, ".artifacts");
const evidencePath = path.join(evidenceDirectory, "development-evidence.json");

type LauncherCheck = {
  readonly command: string;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly plannedProcesses: readonly string[];
  readonly errors: readonly string[];
};

type PlannedLauncherCheck = LauncherCheck & {
  readonly plan: LauncherOutput;
};

type SettledResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const settle = async <T>(task: () => Promise<T>): Promise<SettledResult<T>> => {
  try {
    return { ok: true, value: await task() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const runCheck = async (args: readonly string[], options = {}): Promise<PlannedLauncherCheck> => {
  const startedAt = performance.now();
  const result = await runLauncher([...args, "--json"], {
    ...options,
    cwd: repository,
    env: {},
  });
  return {
    command: `pnpm dev ${args.join(" ")}`,
    ok: result.output.ok,
    exitCode: result.exitCode,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    plannedProcesses: result.output.plannedProcesses.map(({ id }) => id),
    errors: result.output.errors.map(({ code, message }) => `${code}: ${message}`),
    plan: result.output,
  };
};

const fastEvidenceTimeoutMs = 180_000;

const localFastPrerequisiteAccess: AccessChecker = async () => ({
  reachable: true,
  status: 204,
});

const localFastExecutionPlan = (plannedOutput: LauncherOutput): LauncherOutput => ({
  ...plannedOutput,
  plannedProcesses: plannedOutput.plannedProcesses.map((process) =>
    process.id === "sheet-web"
      ? {
          ...process,
          environment: {
            ...process.environment,
            AUTH_BASE_URL: `http://localhost:${DETERMINISTIC_PORTS["sheet-auth"]}`,
            SHEET_ZERO_BASE_URL: `http://localhost:${DETERMINISTIC_PORTS["zero-cache"]}`,
            SHEET_WORKFLOWS_BASE_URL: `http://localhost:${DETERMINISTIC_PORTS["sheet-workflows"]}`,
          },
        }
      : process,
  ),
});

const makeInterruptionSignal = () => {
  let resolve!: (signal: NodeJS.Signals) => void;
  const effect = Effect.promise(
    () =>
      new Promise<NodeJS.Signals>((resolver) => {
        resolve = resolver;
      }),
  );
  return { effect, resolve: (signal: NodeJS.Signals) => resolve(signal) };
};

const executionFailure = (execution: FastExecutionResult) => {
  const diagnostics = [
    execution.outcome.diagnostic?.message,
    execution.outcome.cleanupDiagnostic?.message,
  ].filter((message): message is string => message !== undefined);
  const detail = diagnostics.length === 0 ? "no diagnostic was returned" : diagnostics.join("; ");
  return new Error(
    `Fast execution ended with ${execution.outcome.status} before evidence was recorded: ${detail}`,
  );
};

const isSuccessfulReadiness = (readyAt: number | undefined, execution: FastExecutionResult) =>
  readyAt !== undefined && execution.output.readiness === "ready" && execution.outcome.ok === true;

const measureFastAttempt = async (plannedOutput: LauncherOutput) => {
  const startedAt = performance.now();
  const stopAfterReady = makeInterruptionSignal();
  let readyAt: number | undefined;
  const context = makeFastExecutionContext(plannedOutput, repository, {
    startupTimeoutMs: fastEvidenceTimeoutMs,
    readinessTimeoutMs: fastEvidenceTimeoutMs,
  });
  const execution = await runFastExecution(context, {
    accessChecker: localFastPrerequisiteAccess,
    interruptions: stopAfterReady.effect,
    output: "stderr",
    onObservation: (observation) => {
      if (observation.type !== "readiness" || observation.status !== "ready") return;
      readyAt ??= performance.now();
      queueMicrotask(() => stopAfterReady.resolve("SIGTERM"));
    },
  });
  if (!isSuccessfulReadiness(readyAt, execution)) {
    throw executionFailure(execution);
  }
  return Math.round((readyAt - startedAt) * 100) / 100;
};

const measureFastReady = async (plannedOutput: LauncherOutput) => {
  const localPlan = localFastExecutionPlan(plannedOutput);
  const measurementsMs: number[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    measurementsMs.push(await measureFastAttempt(localPlan));
  }
  return measurementsMs;
};

const writeComposeBuildEnvironment = () => {
  const directory = path.join(repository, ".artifacts", "development-evidence");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "compose.env");
  writeFileSync(file, "SHEET_WEB_PUBLIC_BASE_URL=http://localhost:3001\n");
  return file;
};

const failedLauncherCheck = (command: string, error: string): LauncherCheck => ({
  command,
  ok: false,
  exitCode: 1,
  durationMs: 0,
  plannedProcesses: [],
  errors: [error],
});

const resolveLauncherCheck = (
  result: SettledResult<PlannedLauncherCheck>,
  command: string,
): LauncherCheck => {
  if (result.ok === false) return failedLauncherCheck(command, result.error);
  const { plan: _plan, ...check } = result.value;
  return check;
};

const collectFailures = (
  checks: readonly LauncherCheck[],
  readinessResult: SettledResult<readonly number[]>,
) => [
  ...checks.filter(({ ok }) => !ok).map(({ command }) => `${command} failed`),
  ...(readinessResult.ok === false ? [`Fast readiness failed: ${readinessResult.error}`] : []),
];

const collectResults = async (composeEnvironment: string) => {
  const fastResult = await settle(() => runCheck(["fast", "up"]));
  const readinessTask =
    fastResult.ok && fastResult.value.ok
      ? settle(() => measureFastReady(fastResult.value.plan))
      : Promise.resolve({
          ok: false,
          error: "Fast planning did not produce an executable plan",
        } satisfies SettledResult<readonly number[]>);
  const [composeResult, kubernetesResult, readinessResult] = await Promise.all([
    settle(() => runCheck(["compose", "build", "--env-file", composeEnvironment])),
    settle(() => runCheck(["kubernetes", "validate"])),
    readinessTask,
  ]);

  const fast = resolveLauncherCheck(fastResult, "pnpm dev fast up");
  const compose = resolveLauncherCheck(
    composeResult,
    `pnpm dev compose build --env-file ${composeEnvironment}`,
  );
  const kubernetes = resolveLauncherCheck(kubernetesResult, "pnpm dev kubernetes validate");
  const checks = [fast, compose, kubernetes];
  const fastStartupToReadyMs = readinessResult.ok ? readinessResult.value : [];
  const failures = collectFailures(checks, readinessResult);
  return { checks, fastStartupToReadyMs, failures, readinessResult };
};

const writeEvidence = (result: Awaited<ReturnType<typeof collectResults>>) => {
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gitSha: process.env.GITHUB_SHA ?? "local",
    networkBoundary: "local-only",
    launcherChecks: result.checks,
    fastStartupToReadyMs: result.fastStartupToReadyMs,
    fastStartupToReadyThreshold: null,
    notes: [
      "Fast timings run the shared Fast execution lifecycle, start a real sheet-web watch process, and stop it after GET /ready returns 2xx.",
      "Launcher validation remains unchanged, but the evidence child receives loopback values for external Fast endpoint settings. Fast prerequisite checks use a bounded local CI adapter. The only network request is the local sheet-web readiness check; no production or development credentials, database, cluster, Discord, or Google Sheets resource is contacted.",
      "Early exit, readiness timeout, and interruption are blocking lifecycle cases covered by the shared Fast execution tests; the execution seam owns process-tree cleanup.",
      "The timing series is evidence only. It has no p95 or p99 blocking threshold.",
      ...(result.readinessResult.ok === false
        ? [`Readiness error: ${result.readinessResult.error}`]
        : []),
    ],
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence));
};

const main = async () => {
  rmSync(evidenceDirectory, { recursive: true, force: true });
  mkdirSync(evidenceDirectory, { recursive: true });
  const composeEnvironment = writeComposeBuildEnvironment();
  const result = await collectResults(composeEnvironment);
  writeEvidence(result);
  if (result.failures.length > 0) throw new Error(result.failures.join("; "));
};

await main();
