#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { makeFastExecutionContext, runFastExecution, runKubernetesExecution } from "./execution";
import { spawnProcess, startLongLivedProcess } from "./executor";
import { makeDiagnostic } from "./diagnostics";
import {
  getKubernetesExecutionContext,
  renderLauncherOutput,
  runLauncherFromParsed,
} from "./index";
import type { LauncherOutput, ProcessExecutor } from "./types";
import { normalizeChangedSurfaces, type CommandOptions } from "./commands";

const commonFlags = {
  envFile: Flag.string("env-file").pipe(Flag.optional),
  service: Flag.string("service").pipe(Flag.optional),
  confirm: Flag.boolean("confirm").pipe(Flag.withDefault(false)),
  confirmDevelopment: Flag.boolean("confirm-development").pipe(Flag.withDefault(false)),
  tag: Flag.string("tag").pipe(Flag.optional),
  changedSurface: Flag.string("changed-surface").pipe(Flag.between(0, Number.MAX_SAFE_INTEGER)),
  json: Flag.boolean("json").pipe(Flag.withDefault(false)),
};

const launcherOptions = (config: {
  readonly operands: ReadonlyArray<string>;
  readonly envFile: Option.Option<string>;
  readonly service: Option.Option<string>;
  readonly confirm: boolean;
  readonly confirmDevelopment: boolean;
  readonly tag: Option.Option<string>;
  readonly changedSurface: ReadonlyArray<string>;
  readonly json: boolean;
}): CommandOptions => ({
  json: config.json,
  help: false,
  envFile: Option.getOrNull(config.envFile),
  service: Option.getOrNull(config.service),
  confirm: config.confirm,
  confirmDevelopment: config.confirmDevelopment,
  tag: Option.getOrNull(config.tag),
  changedSurfaces: config.changedSurface.flatMap(normalizeChangedSurfaces),
});

// fallow-ignore-next-line complexity
const executeComposePlan = async (
  result: Awaited<ReturnType<typeof runLauncherFromParsed>>,
  json: boolean,
) => {
  // startLongLivedProcess owns lifecycle timeout and ignores request.timeoutMs.
  const longLivedTimeoutMs = 2_147_000_000;
  if (!result.output.ok || result.output.plannedProcesses.length === 0) return result;
  let longLivedStarted = false;
  for (const planned of result.output.plannedProcesses) {
    const request = {
      command: planned.command,
      args: planned.args,
      cwd: process.cwd(),
      env: planned.environment,
      timeoutMs: planned.longLived ? longLivedTimeoutMs : 30 * 60_000,
      kind: "runtime" as const,
      readOnly: planned.readOnly,
      output: json ? ("stderr" as const) : ("inherit" as const),
    };
    let processResult;
    if (planned.longLived) {
      let running: Awaited<ReturnType<typeof startLongLivedProcess>> | undefined;
      let signal: NodeJS.Signals | undefined;
      let stopPromise: Promise<void> | undefined;
      let executionError: unknown;
      let resolveSignal!: () => void;
      const signalReceived = new Promise<void>((resolve) => {
        resolveSignal = resolve;
      });
      const stop = (received: NodeJS.Signals) => {
        signal = received;
        resolveSignal();
        if (running !== undefined) {
          stopPromise ??= running.kill();
          void stopPromise.catch(() => undefined);
        }
      };
      const onInterrupt = () => stop("SIGINT");
      const onTerminate = () => stop("SIGTERM");
      process.once("SIGINT", onInterrupt);
      process.once("SIGTERM", onTerminate);
      try {
        try {
          running = await startLongLivedProcess(request);
        } catch (error) {
          executionError = error;
        }
        if (running === undefined) {
          processResult = {
            exitCode: 127,
            timedOut: false,
            stderr:
              executionError instanceof Error ? executionError.message : String(executionError),
          };
        } else {
          longLivedStarted = true;
          if (!json) {
            process.stdout.write(
              renderLauncherOutput({ ...result.output, readiness: "ready" }, false),
            );
          }
          if (signal !== undefined) stop(signal);
          try {
            processResult = await Promise.race([
              running.exited,
              signalReceived.then(() => ({
                exitCode: signal === "SIGINT" ? 130 : 143,
                timedOut: false,
                stderr: undefined,
              })),
            ]);
            await stopPromise;
          } catch (error) {
            executionError = error;
            processResult = {
              exitCode: 1,
              timedOut: false,
              stderr: error instanceof Error ? error.message : String(error),
            };
          }
        }
      } finally {
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onTerminate);
      }
      if (signal !== undefined && executionError === undefined) {
        const stopped = { ...result.output, readiness: "stopped" as const };
        return {
          ...result,
          exitCode: signal === "SIGINT" ? 130 : 143,
          output: stopped,
          stdout: renderLauncherOutput(stopped, json),
        };
      }
    } else {
      processResult = await spawnProcess(request);
    }
    if (processResult.exitCode === 0 && !processResult.timedOut) continue;
    if (
      !processResult.timedOut &&
      (processResult.exitCode === 130 || processResult.exitCode === 143)
    ) {
      const stopped = { ...result.output, readiness: "stopped" as const };
      return {
        ...result,
        exitCode: processResult.exitCode,
        output: stopped,
        stdout: renderLauncherOutput(stopped, json),
      };
    }
    const failure = makeDiagnostic(
      processResult.timedOut ? "dependency-timeout" : "required-dependency-failed",
      `${planned.id} failed with exit code ${processResult.exitCode}${
        processResult.stderr === undefined ? "" : `: ${processResult.stderr}`
      }`,
      `Fix ${planned.id} and retry the same pnpm dev command. No later Compose process was started.`,
      { mode: "compose", action: result.output.action ?? "setup" },
    );
    const blocked = {
      ...result.output,
      ok: false,
      readiness: "blocked" as const,
      errors: [failure],
    };
    return {
      ...result,
      exitCode: 2,
      output: blocked,
      stdout: renderLauncherOutput(blocked, json),
    } satisfies Awaited<ReturnType<typeof runLauncherFromParsed>>;
  }
  const completedOutput = {
    ...result.output,
    readiness: longLivedStarted ? ("stopped" as const) : ("ready" as const),
  };
  return {
    ...result,
    output: completedOutput,
    stdout: renderLauncherOutput(completedOutput, json),
  };
};

// fallow-ignore-next-line complexity
export const executeKubernetesPlan = async (
  result: Awaited<ReturnType<typeof runLauncherFromParsed>>,
  json: boolean,
  executor?: ProcessExecutor,
): Promise<Awaited<ReturnType<typeof runLauncherFromParsed>>> => {
  if (!result.output.ok || result.output.plannedProcesses.length === 0) return result;
  const context = getKubernetesExecutionContext(result);
  if (context === undefined) {
    const failure = makeDiagnostic(
      "dependency-unavailable",
      "Kubernetes execution context was not retained from validated configuration",
      "Recreate the Kubernetes plan through the launcher command and retry.",
      { mode: "kubernetes", action: result.output.action ?? "preview" },
    );
    const blocked = {
      ...result.output,
      ok: false,
      readiness: "blocked" as const,
      errors: [failure],
    };
    return { ...result, exitCode: 2, stdout: renderLauncherOutput(blocked, json), output: blocked };
  }
  const execution = await runKubernetesExecution(
    context,
    executor === undefined
      ? { output: json ? "stderr" : "inherit" }
      : { executor, output: json ? "stderr" : "inherit" },
  );
  return {
    ...result,
    exitCode: execution.outcome.exitCode,
    stdout: renderLauncherOutput(execution.output, json),
    output: execution.output,
  };
};

// Effect CLI owns executable flag syntax. runLauncher keeps a second parser for
// callers that provide raw argv directly, while this path passes typed values
// through one CommandOptions contract.
// fallow-ignore-next-line complexity
const runParsedCommand = (config: Parameters<typeof launcherOptions>[0]) =>
  // fallow-ignore-next-line complexity
  Effect.tryPromise({
    // fallow-ignore-next-line complexity
    try: async () => {
      let result = await runLauncherFromParsed(config.operands, launcherOptions(config));
      if (result.output.mode === "compose" && result.output.action !== null) {
        result = await executeComposePlan(result, config.json);
      }
      if (
        result.output.mode === "kubernetes" &&
        (result.output.action === "validate" || result.output.action === "preview")
      ) {
        result = await executeKubernetesPlan(result, config.json);
      }
      if (result.output.ok && result.output.mode === "fast" && result.output.action === "up") {
        let readinessPrinted = false;
        try {
          const context = makeFastExecutionContext(result.output, process.cwd());
          const execution = await runFastExecution(context, {
            output: config.json ? "stderr" : "inherit",
            onObservation: (observation) => {
              if (observation.type !== "readiness" || observation.status !== "ready") return;
              readinessPrinted = true;
              process.stdout.write(
                renderLauncherOutput({ ...result.output, readiness: "ready" }, config.json),
              );
            },
          });
          if (!readinessPrinted) {
            process.stdout.write(renderLauncherOutput(execution.output, config.json));
          }
          if (readinessPrinted) {
            const diagnostics = [
              execution.outcome.diagnostic,
              execution.outcome.cleanupDiagnostic,
            ].filter(
              (diagnostic): diagnostic is NonNullable<typeof diagnostic> =>
                diagnostic !== undefined,
            );
            for (const diagnostic of diagnostics) {
              process.stderr.write(
                `[${diagnostic.code}] ${diagnostic.message}\n  remediation: ${diagnostic.remediation}\n`,
              );
            }
          }
          process.exitCode = execution.outcome.exitCode;
        } catch (cause) {
          const detail = cause instanceof Error ? `: ${cause.message}` : "";
          if (readinessPrinted) {
            process.exitCode = 1;
            process.stderr.write(
              `[required-dependency-failed] Fast execution failed after readiness${detail}\n` +
                "  remediation: Inspect the Fast launcher and process diagnostics.\n",
            );
          } else {
            const blocked = {
              ...result.output,
              ok: false,
              readiness: "blocked" as const,
              errors: [
                makeDiagnostic(
                  "dependency-unavailable",
                  `Fast execution could not be prepared${detail}`,
                  "Retry pnpm dev fast up after checking the validated Fast plan.",
                  { mode: "fast", action: "up" },
                ),
              ],
            } satisfies LauncherOutput;
            process.exitCode = 2;
            process.stdout.write(renderLauncherOutput(blocked, config.json));
          }
        }
        return null;
      }
      process.exitCode = result.exitCode;
      const output = result.stdout.trimEnd();
      return output.length === 0 ? null : output;
    },
    catch: (cause) => {
      process.exitCode = 1;
      return cause instanceof Error
        ? cause
        : new Error("The development launcher failed before it could produce a result.");
    },
  }).pipe(
    Effect.flatMap((output) => (output === null ? Effect.void : Console.log(output))),
    Effect.catch((error: unknown) =>
      Console.error(error instanceof Error ? error.message : "The development launcher failed."),
    ),
  );

export const command = Command.make(
  "dev",
  {
    operands: Argument.string("command").pipe(Argument.variadic()),
    ...commonFlags,
  },
  runParsedCommand,
).pipe(
  Command.withDescription(
    "Select a safe TiaraStack development mode or run read-only prerequisite checks",
  ),
  Command.withExamples([
    { command: "pnpm dev", description: "Print the launcher help" },
    { command: "pnpm dev fast up", description: "Plan the Fast sheet-web slice" },
    { command: "pnpm dev doctor --json", description: "Run prerequisite checks as JSON" },
  ]),
);

// fallow-ignore-next-line code-duplication
export const main = Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
);

export const runMain = () => NodeRuntime.runMain(main);

const canonicalPath = (value: string) => {
  try {
    return realpathSync(value);
  } catch {
    return path.normalize(path.resolve(value));
  }
};

const isMain = () => {
  if (!process.argv[1]) return false;
  return canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url));
};

if (isMain()) runMain();
