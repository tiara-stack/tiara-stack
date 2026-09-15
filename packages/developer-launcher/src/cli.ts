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
  type FastExecutionOptions,
  type LifecycleObservation,
  type KubernetesExecutionOptions,
  type KubernetesLifecycleObservation,
} from "./execution";
import { makeDiagnostic } from "./diagnostics";
import {
  getComposeExecutionContext,
  getKubernetesExecutionContext,
  makeLifecycleStreamWriter,
  renderLifecycleTerminal,
  renderLauncherOutput,
  runLauncherFromParsed,
} from "./index";
import type { Diagnostic, LauncherOutput, ProcessExecutor } from "./types";
import { normalizeChangedSurfaces, type CommandOptions } from "./commands";

const commonFlags = {
  envFile: Flag.string("env-file").pipe(Flag.optional),
  service: Flag.string("service").pipe(Flag.optional),
  confirm: Flag.boolean("confirm").pipe(Flag.withDefault(false)),
  confirmDevelopment: Flag.boolean("confirm-development").pipe(Flag.withDefault(false)),
  tag: Flag.string("tag").pipe(Flag.optional),
  changedSurface: Flag.string("changed-surface").pipe(Flag.between(0, Number.MAX_SAFE_INTEGER)),
  json: Flag.boolean("json").pipe(Flag.withDefault(false)),
  jsonStream: Flag.boolean("json-stream").pipe(Flag.withDefault(false)),
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
  readonly jsonStream: boolean;
}): CommandOptions => ({
  json: config.json,
  jsonStream: config.jsonStream,
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
  readonly jsonStream?: boolean;
  readonly onObservation?: (observation: ComposeLifecycleObservation) => void;
  readonly writeStdout?: (value: string) => void;
  readonly writeStderr?: (value: string) => void;
}

const composeContextDiagnostic = (action: string, _cause: unknown) =>
  makeDiagnostic(
    "context-preparation-failed",
    `Compose ${action} execution context was not retained from validated configuration`,
    "Recreate the Compose plan through the launcher command and retry without modifying the environment file between planning and execution.",
    { mode: "compose", action },
  );

const diagnosticText = (diagnostics: readonly Diagnostic[]) =>
  diagnostics
    .map(
      ({ code, message, remediation }) => `[${code}] ${message}\n  remediation: ${remediation}\n`,
    )
    .join("");

const lifecycleStreamFailure = (mode: "compose" | "fast" | "kubernetes", action: string) =>
  makeDiagnostic(
    "dependency-unavailable",
    `${mode} ${action} execution could not produce a terminal lifecycle event`,
    `Retry the ${mode} ${action} command and inspect the launcher diagnostics.`,
    { mode, action },
  );

// fallow-ignore-next-line complexity
export const executeComposePlan = async (
  result: Awaited<ReturnType<typeof runLauncherFromParsed>>,
  json: boolean,
  options: ComposePlanExecutionOptions = {},
) => {
  if (!result.output.ok || result.output.plannedProcesses.length === 0) return result;
  if (result.output.mode !== "compose" || result.output.action === null) return result;
  const jsonStream = options.jsonStream === true;
  const writeStdout = options.writeStdout ?? ((value: string) => process.stdout.write(value));
  const writeStderr = options.writeStderr ?? ((value: string) => process.stderr.write(value));
  const lifecycleStream = jsonStream
    ? makeLifecycleStreamWriter(result.output, writeStdout)
    : undefined;
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
      stdout: jsonStream ? renderLifecycleTerminal(blocked) : renderLauncherOutput(blocked, json),
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
      stdout: jsonStream ? renderLifecycleTerminal(blocked) : renderLauncherOutput(blocked, json),
      stderr: "",
      output: blocked,
    };
  }
  let readinessPrinted = false;
  const onObservation = (observation: ComposeLifecycleObservation) => {
    options.onObservation?.(observation);
    if (jsonStream) {
      lifecycleStream?.writeObservation(observation);
      return;
    }
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
  let execution: Awaited<ReturnType<typeof runComposeExecution>>;
  try {
    execution = await runComposeExecution(context, {
      ...options,
      output: json || jsonStream ? "stderr" : "inherit",
      onObservation,
    });
  } catch {
    if (!jsonStream || lifecycleStream === undefined) throw new Error("Compose execution failed");
    if (lifecycleStream.hasTerminal())
      throw new Error("Compose execution failed after its terminal event");
    const diagnostic = lifecycleStreamFailure("compose", result.output.action);
    const blocked = {
      ...result.output,
      ok: false,
      readiness: "blocked" as const,
      errors: [diagnostic],
    };
    lifecycleStream.writeTerminal(blocked);
    const stderr = diagnosticText(blocked.errors);
    writeStderr(stderr);
    return { ...result, exitCode: 2, stdout: "", stderr, output: blocked };
  }
  const diagnostics = [execution.outcome.diagnostic, execution.outcome.cleanupDiagnostic].filter(
    (diagnostic): diagnostic is NonNullable<typeof diagnostic> => diagnostic !== undefined,
  );
  const diagnosticOutput = diagnosticText(diagnostics);
  if ((jsonStream || readinessPrinted) && diagnosticOutput.length > 0) {
    writeStderr(diagnosticOutput);
  }
  return {
    ...result,
    exitCode: execution.outcome.exitCode,
    output: execution.output,
    stdout: jsonStream || readinessPrinted ? "" : renderLauncherOutput(execution.output, json),
    stderr: jsonStream || readinessPrinted ? diagnosticOutput : "",
  };
};

export interface KubernetesPlanExecutionOptions extends Omit<
  KubernetesExecutionOptions,
  "onObservation" | "output"
> {
  readonly jsonStream?: boolean;
  readonly onObservation?: (observation: KubernetesLifecycleObservation) => void;
  readonly writeStdout?: (value: string) => void;
  readonly writeStderr?: (value: string) => void;
}

// fallow-ignore-next-line complexity
export const executeKubernetesPlan = async (
  result: Awaited<ReturnType<typeof runLauncherFromParsed>>,
  json: boolean,
  executorOrOptions?: ProcessExecutor | KubernetesPlanExecutionOptions,
): Promise<Awaited<ReturnType<typeof runLauncherFromParsed>>> => {
  if (!result.output.ok || result.output.plannedProcesses.length === 0) return result;
  const options: KubernetesPlanExecutionOptions =
    typeof executorOrOptions === "function"
      ? { executor: executorOrOptions }
      : (executorOrOptions ?? {});
  const jsonStream = options.jsonStream === true;
  const writeStdout = options.writeStdout ?? ((value: string) => process.stdout.write(value));
  const writeStderr = options.writeStderr ?? ((value: string) => process.stderr.write(value));
  const lifecycleStream = jsonStream
    ? makeLifecycleStreamWriter(result.output, writeStdout)
    : undefined;
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
    const stdout = jsonStream
      ? renderLifecycleTerminal(blocked)
      : renderLauncherOutput(blocked, json);
    return { ...result, exitCode: 2, stdout, output: blocked };
  }
  let execution: Awaited<ReturnType<typeof runKubernetesExecution>>;
  try {
    execution = await runKubernetesExecution(context, {
      ...options,
      output: json || jsonStream ? "stderr" : "inherit",
      onObservation: (observation) => {
        options.onObservation?.(observation);
        if (jsonStream) lifecycleStream?.writeObservation(observation);
      },
    });
  } catch {
    if (!jsonStream || lifecycleStream === undefined) {
      throw new Error("Kubernetes execution failed");
    }
    if (lifecycleStream.hasTerminal()) {
      throw new Error("Kubernetes execution failed after its terminal event");
    }
    const diagnostic = lifecycleStreamFailure("kubernetes", result.output.action ?? "preview");
    const blocked = {
      ...result.output,
      ok: false,
      readiness: "blocked" as const,
      errors: [diagnostic],
    };
    lifecycleStream.writeTerminal(blocked);
    const stderr = diagnosticText(blocked.errors);
    writeStderr(stderr);
    return { ...result, exitCode: 2, stdout: "", stderr, output: blocked };
  }
  const diagnostics = [execution.outcome.diagnostic, execution.outcome.cleanupDiagnostic].filter(
    (diagnostic): diagnostic is NonNullable<typeof diagnostic> => diagnostic !== undefined,
  );
  const diagnosticOutput = diagnosticText(diagnostics);
  if (jsonStream && diagnosticOutput.length > 0) writeStderr(diagnosticOutput);
  return {
    ...result,
    exitCode: execution.outcome.exitCode,
    stdout: jsonStream ? "" : renderLauncherOutput(execution.output, json),
    stderr: jsonStream ? diagnosticOutput : "",
    output: execution.output,
  };
};

export interface FastPlanExecutionOptions extends Omit<
  FastExecutionOptions,
  "onObservation" | "output"
> {
  readonly jsonStream?: boolean;
  readonly onObservation?: (observation: LifecycleObservation) => void;
  readonly writeStdout?: (value: string) => void;
  readonly writeStderr?: (value: string) => void;
}

// fallow-ignore-next-line complexity
export const executeFastPlan = async (
  result: Awaited<ReturnType<typeof runLauncherFromParsed>>,
  json: boolean,
  options: FastPlanExecutionOptions = {},
) => {
  if (!result.output.ok || result.output.plannedProcesses.length === 0) return result;
  if (result.output.mode !== "fast" || result.output.action !== "up") return result;
  const jsonStream = options.jsonStream === true;
  const writeStdout = options.writeStdout ?? ((value: string) => process.stdout.write(value));
  const writeStderr = options.writeStderr ?? ((value: string) => process.stderr.write(value));
  const lifecycleStream = jsonStream
    ? makeLifecycleStreamWriter(result.output, writeStdout)
    : undefined;
  let readinessPrinted = false;
  try {
    const context = makeFastExecutionContext(result.output, process.cwd());
    const execution = await runFastExecution(context, {
      ...options,
      output: json || jsonStream ? "stderr" : "inherit",
      // fallow-ignore-next-line complexity
      onObservation: (observation) => {
        options.onObservation?.(observation);
        if (jsonStream) {
          const readinessObservation =
            observation.type === "readiness" && observation.status === "ready";
          if (readinessObservation) {
            readinessPrinted = true;
          }
          try {
            lifecycleStream?.writeObservation(observation);
          } catch (cause) {
            if (readinessObservation) readinessPrinted = false;
            throw cause;
          }
          return;
        }
        if (
          readinessPrinted ||
          observation.type !== "readiness" ||
          observation.status !== "ready"
        ) {
          return;
        }
        writeStdout(renderLauncherOutput({ ...result.output, readiness: "ready" }, json));
        readinessPrinted = true;
      },
    });
    const diagnostics = [execution.outcome.diagnostic, execution.outcome.cleanupDiagnostic].filter(
      (diagnostic): diagnostic is NonNullable<typeof diagnostic> => diagnostic !== undefined,
    );
    const diagnosticOutput = diagnosticText(diagnostics);
    if ((jsonStream || readinessPrinted) && diagnosticOutput.length > 0) {
      writeStderr(diagnosticOutput);
    }
    return {
      ...result,
      exitCode: execution.outcome.exitCode,
      output: execution.output,
      stdout: jsonStream || readinessPrinted ? "" : renderLauncherOutput(execution.output, json),
      stderr: jsonStream || readinessPrinted ? diagnosticOutput : "",
    };
  } catch {
    if (jsonStream) {
      if (lifecycleStream === undefined) throw new Error("Fast lifecycle stream was not prepared");
      if (lifecycleStream.hasTerminal())
        throw new Error("Fast execution failed after its terminal event");
    }
    if (readinessPrinted) {
      const diagnostic = makeDiagnostic(
        "required-dependency-failed",
        "Fast execution failed after readiness",
        "Inspect the Fast launcher and process diagnostics.",
        { mode: "fast", action: "up" },
      );
      const blocked = {
        ...result.output,
        ok: false,
        readiness: "ready" as const,
        errors: [diagnostic],
      } satisfies LauncherOutput;
      const stderr = diagnosticText(blocked.errors);
      if (jsonStream) lifecycleStream?.writeTerminal(blocked, 1);
      writeStderr(stderr);
      return { ...result, exitCode: 1, stdout: "", stderr, output: blocked };
    }
    const blocked = {
      ...result.output,
      ok: false,
      readiness: "blocked" as const,
      errors: [
        makeDiagnostic(
          "dependency-unavailable",
          "Fast execution could not be prepared",
          "Retry pnpm dev fast up after checking the validated Fast plan.",
          { mode: "fast", action: "up" },
        ),
      ],
    } satisfies LauncherOutput;
    if (jsonStream) {
      lifecycleStream?.writeTerminal(blocked);
      const stderr = diagnosticText(blocked.errors);
      writeStderr(stderr);
      return { ...result, exitCode: 2, stdout: "", stderr, output: blocked };
    }
    return {
      ...result,
      exitCode: 2,
      stdout: renderLauncherOutput(blocked, json),
      stderr: "",
      output: blocked,
    };
  }
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
      let lifecycleExecutionStarted = false;
      if (result.output.mode === "compose" && result.output.action !== null) {
        lifecycleExecutionStarted =
          config.jsonStream && result.output.ok && result.output.plannedProcesses.length > 0;
        result = await executeComposePlan(result, config.json || config.jsonStream, {
          jsonStream: config.jsonStream,
        });
      }
      if (
        result.output.mode === "kubernetes" &&
        (result.output.action === "validate" || result.output.action === "preview")
      ) {
        lifecycleExecutionStarted =
          config.jsonStream && result.output.ok && result.output.plannedProcesses.length > 0;
        result = await executeKubernetesPlan(result, config.json || config.jsonStream, {
          jsonStream: config.jsonStream,
        });
      }
      if (result.output.ok && result.output.mode === "fast" && result.output.action === "up") {
        lifecycleExecutionStarted = config.jsonStream && result.output.plannedProcesses.length > 0;
        result = await executeFastPlan(result, config.json || config.jsonStream, {
          jsonStream: config.jsonStream,
        });
      }
      process.exitCode = result.exitCode;
      if (config.jsonStream) {
        if (result.stdout.trim().length > 0) {
          process.stdout.write(result.stdout);
        }
        if (result.output.ok && !lifecycleExecutionStarted) {
          process.stdout.write(renderLifecycleTerminal(result.output, result.exitCode, 2));
        } else if (
          !result.output.ok &&
          !lifecycleExecutionStarted &&
          result.stdout.trim().length === 0
        ) {
          process.stdout.write(renderLifecycleTerminal(result.output, result.exitCode, 1));
        }
        return null;
      }
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
