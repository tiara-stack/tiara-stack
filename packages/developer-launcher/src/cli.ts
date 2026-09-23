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
  executeDevelopmentPlan,
  renderLifecycleTerminal,
  runLauncherFromParsed,
  type DevelopmentPlanExecutionOptions,
} from "./index";
import type {
  ComposeLifecycleObservation,
  DevelopmentLifecycleObservation,
  KubernetesLifecycleObservation,
  LifecycleObservation,
} from "./execution";
import {
  developmentModes,
  modeActions,
  type DevelopmentMode,
  type LauncherResult,
  type ProcessExecutor,
} from "./types";
import { normalizeChangedSurfaces, type CommandOptions } from "./commands";

const commonFlags = {
  envFile: Flag.string("env-file").pipe(Flag.optional),
  configFile: Flag.string("config").pipe(Flag.optional),
  sessionId: Flag.string("session").pipe(Flag.optional),
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
  readonly configFile: Option.Option<string>;
  readonly sessionId: Option.Option<string>;
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
  configFile: Option.getOrNull(config.configFile),
  sessionId: Option.getOrNull(config.sessionId),
  service: Option.getOrNull(config.service),
  confirm: config.confirm,
  confirmDevelopment: config.confirmDevelopment,
  tag: Option.getOrNull(config.tag),
  changedSurfaces: config.changedSurface.flatMap(normalizeChangedSurfaces),
});

type ModePlanExecutionOptions<Observation extends DevelopmentLifecycleObservation> = Omit<
  DevelopmentPlanExecutionOptions,
  "onObservation"
> & {
  readonly onObservation?: (observation: Observation) => void;
};

export type ComposePlanExecutionOptions = ModePlanExecutionOptions<ComposeLifecycleObservation>;
export type KubernetesPlanExecutionOptions =
  ModePlanExecutionOptions<KubernetesLifecycleObservation>;
export type FastPlanExecutionOptions = ModePlanExecutionOptions<LifecycleObservation>;

const matchesModePlan = (result: LauncherResult, mode: DevelopmentMode) => {
  const actions: readonly string[] = modeActions[mode];
  return (
    result.output.mode === mode &&
    result.output.action !== null &&
    actions.includes(result.output.action)
  );
};

const isFastObservation = (
  observation: DevelopmentLifecycleObservation,
): observation is LifecycleObservation => observation.mode === "fast";

const isComposeObservation = (
  observation: DevelopmentLifecycleObservation,
): observation is ComposeLifecycleObservation => observation.mode === "compose";

const isKubernetesObservation = (
  observation: DevelopmentLifecycleObservation,
): observation is KubernetesLifecycleObservation => observation.mode === "kubernetes";

const executeExpectedModePlan = <Observation extends DevelopmentLifecycleObservation>(
  result: LauncherResult,
  json: boolean,
  mode: DevelopmentMode,
  options: ModePlanExecutionOptions<Observation>,
  isObservation: (observation: DevelopmentLifecycleObservation) => observation is Observation,
) => {
  if (!matchesModePlan(result, mode)) return result;
  const { onObservation, ...executionOptions } = options;
  return executeDevelopmentPlan(
    result,
    json,
    onObservation === undefined
      ? executionOptions
      : {
          ...executionOptions,
          onObservation: (observation) => {
            if (isObservation(observation)) onObservation(observation);
          },
        },
  );
};

export const executeComposePlan = (
  result: Awaited<ReturnType<typeof runLauncherFromParsed>>,
  json: boolean,
  options: ComposePlanExecutionOptions = {},
) => executeExpectedModePlan(result, json, "compose", options, isComposeObservation);

export const executeKubernetesPlan = (
  result: Awaited<ReturnType<typeof runLauncherFromParsed>>,
  json: boolean,
  executorOrOptions?: ProcessExecutor | KubernetesPlanExecutionOptions,
) =>
  executeExpectedModePlan(
    result,
    json,
    "kubernetes",
    typeof executorOrOptions === "function"
      ? { executor: executorOrOptions }
      : (executorOrOptions ?? {}),
    isKubernetesObservation,
  );

export const executeFastPlan = (
  result: Awaited<ReturnType<typeof runLauncherFromParsed>>,
  json: boolean,
  options: FastPlanExecutionOptions = {},
) => executeExpectedModePlan(result, json, "fast", options, isFastObservation);

export { executeDevelopmentPlan };
export type { DevelopmentPlanExecutionOptions };

const isExecutablePlan = (result: Awaited<ReturnType<typeof runLauncherFromParsed>>) =>
  result.output.ok &&
  result.output.plannedProcesses.length > 0 &&
  developmentModes.some((mode) => matchesModePlan(result, mode));

const runParsedCommand = (config: Parameters<typeof launcherOptions>[0]) =>
  // fallow-ignore-next-line complexity
  Effect.tryPromise({
    // fallow-ignore-next-line complexity
    try: async () => {
      let result = await runLauncherFromParsed(config.operands, launcherOptions(config));
      const shouldExecutePlan = isExecutablePlan(result);
      const lifecycleExecutionStarted = config.jsonStream && shouldExecutePlan;
      if (shouldExecutePlan) {
        result = await executeDevelopmentPlan(result, config.json || config.jsonStream, {
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
    "Select a safe TiaraStack development mode, inspect connected preview admission, or run read-only prerequisite checks",
  ),
  Command.withExamples([
    { command: "pnpm dev", description: "Print the launcher help" },
    { command: "pnpm dev fast up", description: "Plan the Fast sheet-web slice" },
    {
      command: "pnpm dev preview plan --config ./preview.json",
      description: "Print a read-only connected preview plan",
    },
    {
      command: "pnpm dev preview doctor --config ./preview.json",
      description: "Check connected preview prerequisites",
    },
    {
      command: "pnpm dev preview start --config ./preview.json",
      description: "Currently unavailable; no process or session is started",
    },
    {
      command: "pnpm dev preview status --session <id>",
      description: "Currently unavailable; no session operation is attempted",
    },
    {
      command: "pnpm dev preview resume --session <id>",
      description: "Currently unavailable; no session operation is attempted",
    },
    {
      command: "pnpm dev preview stop --session <id>",
      description: "Currently unavailable; no session operation is attempted",
    },
    {
      command: "pnpm dev preview cleanup --session <id>",
      description: "Currently unavailable; no session operation is attempted",
    },
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
