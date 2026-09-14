import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DETERMINISTIC_PORTS, runLauncher } from "../packages/developer-launcher/src/index";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDirectory = path.join(repository, ".artifacts");
const evidencePath = path.join(evidenceDirectory, "development-evidence.json");
const fastPort = DETERMINISTIC_PORTS["sheet-web"];

const localProcessEnvironment = () =>
  Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "NODE_PATH", "NPM_CONFIG_USER_AGENT"]
      .map((key) => [key, process.env[key]])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

type LauncherCheck = {
  readonly command: string;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly plannedProcesses: readonly string[];
  readonly errors: readonly string[];
};

type SettledResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

type FastProcess = {
  readonly child: ReturnType<typeof spawn>;
  readonly spawnError: { value: Error | undefined };
};

const settle = async <T>(task: () => Promise<T>): Promise<SettledResult<T>> => {
  try {
    return { ok: true, value: await task() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const runCheck = async (args: readonly string[], options = {}): Promise<LauncherCheck> => {
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
  };
};

const waitForReady = (processHandle: FastProcess, timeoutMs: number) =>
  new Promise<void>((resolve, reject) => {
    const { child, spawnError } = processHandle;
    if (spawnError.value !== undefined) {
      reject(spawnError.value);
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Fast process did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);
    let output = "";
    const onOutput = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes("Local:")) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Fast process exited with code ${code ?? "unknown"}`));
    };
    const onError = (error: Error) => {
      spawnError.value = error;
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onOutput);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", onOutput);
    child.once("exit", onExit);
    child.once("error", onError);
  });

const startFastProcess = (): FastProcess => {
  const spawnError: FastProcess["spawnError"] = { value: undefined };
  const child = spawn(
    "pnpm",
    ["exec", "vp", "dev", "--host", "127.0.0.1", "--port", String(fastPort), "--strictPort"],
    {
      cwd: path.join(repository, "packages/sheet-web"),
      env: {
        ...localProcessEnvironment(),
        APP_BASE_URL: `http://127.0.0.1:${fastPort}`,
        AUTH_BASE_URL: `http://127.0.0.1:${DETERMINISTIC_PORTS["sheet-auth"]}`,
        SHEET_ZERO_BASE_URL: `http://127.0.0.1:${DETERMINISTIC_PORTS["zero-cache"]}`,
        SHEET_WORKFLOWS_BASE_URL: `http://127.0.0.1:${DETERMINISTIC_PORTS["sheet-workflows"]}`,
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  child.on("error", (error) => {
    spawnError.value = error;
  });
  return { child, spawnError };
};

const terminateProcess = (child: ReturnType<typeof spawn>, signal: NodeJS.Signals) => {
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
};

const waitForExit = (child: ReturnType<typeof spawn>, timeoutMs: number) =>
  new Promise<boolean>((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

const stopProcess = async ({ child, spawnError }: FastProcess) => {
  if (spawnError.value !== undefined || child.pid === undefined) return;
  terminateProcess(child, "SIGTERM");
  if (await waitForExit(child, 5_000)) return;
  terminateProcess(child, "SIGKILL");
  throw new Error("Fast process did not exit after termination");
};

const measureFastAttempt = async () => {
  const startedAt = performance.now();
  const processHandle = startFastProcess();
  try {
    await waitForReady(processHandle, 90_000);
    return Math.round((performance.now() - startedAt) * 100) / 100;
  } finally {
    await stopProcess(processHandle);
  }
};

const measureFastReady = async () => {
  const measurementsMs: number[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    measurementsMs.push(await measureFastAttempt());
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

const resolveLauncherCheck = (result: SettledResult<LauncherCheck>, command: string) =>
  result.ok ? result.value : failedLauncherCheck(command, result.error);

const collectFailures = (
  checks: readonly LauncherCheck[],
  readinessResult: SettledResult<readonly number[]>,
) => [
  ...checks.filter(({ ok }) => !ok).map(({ command }) => `${command} failed`),
  ...(readinessResult.ok ? [] : [`Fast readiness failed: ${readinessResult.error}`]),
];

const collectResults = async (composeEnvironment: string) => {
  const fastResult = await settle(() => runCheck(["fast", "up"]));
  const [composeResult, kubernetesResult, readinessResult] = await Promise.all([
    settle(() => runCheck(["compose", "build", "--env-file", composeEnvironment])),
    settle(() => runCheck(["kubernetes", "validate"])),
    settle(measureFastReady),
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
      "Fast timings start a local sheet-web watch process and wait for Vite's local startup announcement.",
      "No production or development service endpoint, credential, database, cluster, or external integration is contacted.",
      "The timing series is evidence only. It has no p95 or p99 blocking threshold.",
      ...(result.readinessResult.ok ? [] : [`Readiness error: ${result.readinessResult.error}`]),
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
