#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
  makeFastExecutionContext,
  runComposeExecution,
  runKubernetesExecution,
  runFastExecution,
  type ComposeExecutionContext,
  type ComposeExecutionOptions,
  type ComposeLifecycleObservation,
} from "./execution";
import { makeDiagnostic } from "./diagnostics";
import {
  getComposeExecutionContext,
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

export interface ComposePlanExecutionOptions extends Omit<
  ComposeExecutionOptions,
  "onObservation" | "output"
> {
  readonly onObservation?: (observation: ComposeLifecycleObservation) => void;
  readonly writeStdout?: (value: string) => void;
  readonly writeStderr?: (value: string) => void;
}

const composeContextDiagnostic = (action: string, cause: unknown) =>
  makeDiagnostic(
    "context-preparation-failed",
    `Compose ${action} execution context was not retained from validated configuration${
      cause instanceof Error ? `: ${cause.message}` : ""
    }`,
    "Recreate the Compose plan through the launcher command and retry without modifying the environment file between planning and execution.",
    { mode: "compose", action },
  );

// fallow-ignore-next-line complexity
export const executeComposePlan = async (
  result: Awaited<ReturnType<typeof runLauncherFromParsed>>,
  json: boolean,
  options: ComposePlanExecutionOptions = {},
) => {
  if (!result.output.ok || result.output.plannedProcesses.length === 0) return result;
  if (result.output.mode !== "compose" || result.output.action === null) return result;
  let context: ComposeExecutionContext | undefined;
  try {
    context = getComposeExecutionContext(result.output);
  } catch (cause) {
    const diagnostic = composeContextDiagnostic(result.output.action, cause);
    const blocked = {
      ...result.output,
      ok: false,
      readiness: "blocked" as const,
      errors: [diagnostic],
    };
    return {
      ...result,
      exitCode: 2,
      stdout: renderLauncherOutput(blocked, json),
      stderr: "",
      output: blocked,
    };
  }
  if (context === undefined) {
    const diagnostic = composeContextDiagnostic(result.output.action, undefined);
    const blocked = {
      ...result.output,
      ok: false,
      readiness: "blocked" as const,
      errors: [diagnostic],
    };
    return {
      ...result,
      exitCode: 2,
      stdout: renderLauncherOutput(blocked, json),
      stderr: "",
      output: blocked,
    };
  }
  let readinessPrinted = false;
  const writeStdout = options.writeStdout ?? ((value: string) => process.stdout.write(value));
  const writeStderr = options.writeStderr ?? ((value: string) => process.stderr.write(value));
  const onObservation = (observation: ComposeLifecycleObservation) => {
    options.onObservation?.(observation);
    if (
      readinessPrinted ||
      observation.type !== "readiness" ||
      observation.status !== "ready" ||
      !observation.allSelected
    ) {
      return;
    }
    readinessPrinted = true;
    writeStdout(renderLauncherOutput({ ...result.output, readiness: "ready" }, json));
  };
  const execution = await runComposeExecution(context, {
    ...options,
    output: json ? "stderr" : "inherit",
    onObservation,
  });
  const diagnostics = [execution.outcome.diagnostic, execution.outcome.cleanupDiagnostic].filter(
    (diagnostic): diagnostic is NonNullable<typeof diagnostic> => diagnostic !== undefined,
  );
  if (readinessPrinted) {
    for (const diagnostic of diagnostics) {
      writeStderr(
        `[${diagnostic.code}] ${diagnostic.message}\n  remediation: ${diagnostic.remediation}\n`,
      );
    }
  }
  return {
    ...result,
    exitCode: execution.outcome.exitCode,
    output: execution.output,
    stdout: readinessPrinted ? "" : renderLauncherOutput(execution.output, json),
    stderr: readinessPrinted
      ? diagnostics
          .map(
            ({ code, message, remediation }) =>
              `[${code}] ${message}\n  remediation: ${remediation}\n`,
          )
          .join("")
      : "",
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
