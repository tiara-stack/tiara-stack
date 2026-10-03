#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/unstable/http";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
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
import { normalizeChangedSurfaces, parseCommand, type CommandOptions } from "./commands";
import { PreviewSessionController, PreviewSessionControllerLive } from "./preview-sessions";
import {
  makeLocalFilesystemPreviewResourceAdapter,
  parsePreviewAllocationConfig,
  PreviewAllocationController,
  PreviewAllocationControllerLive,
  type PreviewAllocationConfigParseResult,
} from "./preview-allocations";
import {
  makePreviewRelayResourceAdapter,
  PreviewRelayProvider,
  PreviewRelayProviderLayer,
  PreviewRelayProviderUnavailable,
  makeConfiguredPreviewRelayPlatformClient,
  makePreviewRelayProvider,
  parsePreviewRelayProviderConfig,
} from "./preview-relay-provider";

const commonFlags = {
  envFile: Flag.string("env-file").pipe(Flag.optional),
  configFile: Flag.string("config").pipe(Flag.optional),
  sessionId: Flag.string("session").pipe(Flag.optional),
  resource: Flag.string("resource").pipe(Flag.optional),
  generation: Flag.integer("generation").pipe(Flag.optional),
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
  readonly resource: Option.Option<string>;
  readonly generation: Option.Option<number>;
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
  resource: Option.getOrNull(config.resource),
  generation: Option.getOrNull(config.generation),
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
  Effect.serviceOption(PreviewSessionController).pipe(
    Effect.flatMap((sessionController) =>
      Effect.serviceOption(PreviewAllocationController).pipe(
        Effect.flatMap((allocationController) =>
          Effect.serviceOption(PreviewRelayProvider).pipe(
            Effect.flatMap((relayProvider) =>
              // fallow-ignore-next-line complexity
              Effect.tryPromise({
                // fallow-ignore-next-line complexity
                try: async () => {
                  const options = launcherOptions(config);
                  const launcherConfig = {
                    ...options,
                    ...(Option.isSome(sessionController)
                      ? { previewSessionController: sessionController.value }
                      : {}),
                    ...(Option.isSome(allocationController)
                      ? { previewAllocationController: allocationController.value }
                      : {}),
                    ...(Option.isSome(relayProvider)
                      ? { previewRelayProvider: relayProvider.value }
                      : {}),
                  };
                  let result = await runLauncherFromParsed(
                    config.operands,
                    options,
                    launcherConfig,
                  );
                  const shouldExecutePlan = isExecutablePlan(result);
                  const lifecycleExecutionStarted = config.jsonStream && shouldExecutePlan;
                  if (shouldExecutePlan) {
                    result = await executeDevelopmentPlan(
                      result,
                      config.json || config.jsonStream,
                      {
                        jsonStream: config.jsonStream,
                      },
                    );
                  }
                  process.exitCode = result.exitCode;
                  if (config.jsonStream) {
                    if (result.stdout.trim().length > 0) {
                      process.stdout.write(result.stdout);
                    }
                    if (result.output.ok && !lifecycleExecutionStarted) {
                      process.stdout.write(
                        renderLifecycleTerminal(result.output, result.exitCode, 2),
                      );
                    } else if (
                      !result.output.ok &&
                      !lifecycleExecutionStarted &&
                      result.stdout.trim().length === 0
                    ) {
                      process.stdout.write(
                        renderLifecycleTerminal(result.output, result.exitCode, 1),
                      );
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
                    : new Error(
                        "The development launcher failed before it could produce a result.",
                      );
                },
              }).pipe(
                Effect.flatMap((output) => (output === null ? Effect.void : Console.log(output))),
                Effect.catch((error: unknown) =>
                  Console.error(
                    error instanceof Error ? error.message : "The development launcher failed.",
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
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
      command: "pnpm dev preview baseline --config ./preview.json",
      description: "Import an operator-collected capacity baseline into the controller",
    },
    {
      command: "pnpm dev preview start --config ./preview.json",
      description: "Create a pending session; live runtime profiles remain unavailable",
    },
    {
      command: "pnpm dev preview status --session <id>",
      description: "Read the durable session record without renewing its lease",
    },
    {
      command: "pnpm dev preview resume --session <id>",
      description: "Resume a live session and fence its previous supervisor",
    },
    {
      command: "pnpm dev preview heartbeat --session <id> --generation <n>",
      description: "Renew the current supervisor lease",
    },
    {
      command: "pnpm dev preview stop --session <id>",
      description: "Idempotently close ordinary session admission",
    },
    {
      command: "pnpm dev preview cleanup --session <id>",
      description: "Clean ended owned resources or inspect waiting/quarantined cleanup state",
    },
    {
      command: "pnpm dev preview resolve --session <id> --resource <key>",
      description: "Verify ownership of one quarantined allocation through its provider adapter",
    },
    { command: "pnpm dev doctor --json", description: "Run prerequisite checks as JSON" },
  ]),
);

const sessionDatabase = process.env.TIARA_PREVIEW_SESSION_DATABASE;
const resolvedSessionDatabase =
  sessionDatabase === undefined || sessionDatabase.trim() === ""
    ? undefined
    : path.resolve(sessionDatabase);
const sessionActions = new Set([
  "start",
  "status",
  "heartbeat",
  "resume",
  "stop",
  "cleanup",
  "resolve",
]);
const args = process.argv.slice(2);
const previewAction = (() => {
  try {
    const parsed = parseCommand(args);
    return parsed.kind === "preview" ? parsed.action : undefined;
  } catch {
    return undefined;
  }
})();
const isPreviewSessionAction =
  previewAction !== undefined &&
  (sessionActions.has(previewAction) || previewAction === "baseline");
const readOnlyCapacityDoctor = (() => {
  if (previewAction !== "doctor" || resolvedSessionDatabase === undefined) return false;
  try {
    return statSync(resolvedSessionDatabase).isFile();
  } catch {
    return false;
  }
})();
const allocationControllerNeeded =
  previewAction === "baseline" ||
  previewAction === "start" ||
  previewAction === "status" ||
  previewAction === "cleanup" ||
  previewAction === "resolve" ||
  readOnlyCapacityDoctor;
const sessionControllerNeeded = previewAction !== undefined && sessionActions.has(previewAction);
const previewAllocationConfig = parsePreviewAllocationConfig(
  process.env.TIARA_PREVIEW_MAX_MEASUREMENT_AGE_MS,
);
const previewRelayConfigPath = process.env.TIARA_PREVIEW_RELAY_CONFIG;
let previewRelayConfigDiagnostic: string | undefined;
const previewRelayConfig = (() => {
  if (previewRelayConfigPath === undefined) return undefined;
  try {
    const parsed = parsePreviewRelayProviderConfig(readFileSync(previewRelayConfigPath, "utf8"));
    if (parsed === undefined)
      previewRelayConfigDiagnostic =
        "TIARA_PREVIEW_RELAY_CONFIG points to invalid configuration; session relay profiles remain unavailable.";
    return parsed;
  } catch {
    previewRelayConfigDiagnostic =
      "TIARA_PREVIEW_RELAY_CONFIG could not be read; session relay profiles remain unavailable.";
    return undefined;
  }
})();
const previewRelayToken =
  previewRelayConfig === undefined
    ? undefined
    : process.env[previewRelayConfig.tokenEnvironmentName];
if (
  previewRelayConfig !== undefined &&
  (previewRelayToken === undefined || previewRelayToken.trim().length === 0)
)
  previewRelayConfigDiagnostic =
    "The configured session relay token is missing or empty; session relay profiles remain unavailable.";
if (previewAction !== undefined && previewRelayConfigDiagnostic !== undefined)
  process.stderr.write(`${previewRelayConfigDiagnostic}\n`);
const previewRelayProvider =
  previewRelayConfig === undefined ||
  previewRelayToken === undefined ||
  previewRelayToken.trim().length === 0
    ? PreviewRelayProviderUnavailable()
    : makePreviewRelayProvider(
        previewRelayConfig,
        makeConfiguredPreviewRelayPlatformClient(undefined, previewRelayConfig),
      );
export const previewAllocationConfigDiagnostic = (
  config: PreviewAllocationConfigParseResult,
  allocationBackedAction: boolean,
  controllerStoreConfigured: boolean,
) =>
  allocationBackedAction && controllerStoreConfigured && "error" in config
    ? config.error
    : undefined;
const previewAllocationLayer = (databasePath: string) =>
  "config" in previewAllocationConfig
    ? PreviewAllocationControllerLive(
        makePreviewRelayResourceAdapter(
          makeLocalFilesystemPreviewResourceAdapter(`${databasePath}.allocations`),
          previewRelayProvider,
        ),
        Date.now,
        previewAllocationConfig.config,
        !readOnlyCapacityDoctor,
      )
    : Layer.empty;
const previewDatabaseLayer =
  resolvedSessionDatabase === undefined || (!allocationControllerNeeded && !sessionControllerNeeded)
    ? Layer.empty
    : Layer.provide(
        sessionControllerNeeded && allocationControllerNeeded
          ? Layer.merge(
              PreviewSessionControllerLive(Date.now),
              previewAllocationLayer(resolvedSessionDatabase),
            )
          : sessionControllerNeeded
            ? PreviewSessionControllerLive(Date.now)
            : allocationControllerNeeded
              ? previewAllocationLayer(resolvedSessionDatabase)
              : Layer.empty,
        Layer.mergeAll(
          SqliteClient.layer({
            filename: resolvedSessionDatabase,
            ...(readOnlyCapacityDoctor ? { readonly: true, disableWAL: true } : {}),
          }),
          NodeServices.layer,
        ),
      );
const cliLayer = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  previewDatabaseLayer,
  PreviewRelayProviderLayer(previewRelayProvider),
);

export const main = Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(cliLayer));

export const runMain = () => NodeRuntime.runMain(main);

const isMain = () => {
  const entryPath = process.argv[1];
  if (entryPath === undefined) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entryPath) === realpathSync(modulePath);
  } catch {
    return path.resolve(entryPath) === path.resolve(modulePath);
  }
};

const reportAllocationConfigDiagnostic = () => {
  const message = previewAllocationConfigDiagnostic(
    previewAllocationConfig,
    allocationControllerNeeded,
    resolvedSessionDatabase !== undefined,
  );
  if (message !== undefined) process.stderr.write(`${message}\n`);
};

// fallow-ignore-next-line code-duplication
if (isMain()) {
  if (isPreviewSessionAction && resolvedSessionDatabase !== undefined) {
    process.umask(0o077);
    let storageReady = true;
    try {
      const databaseDirectory = path.dirname(resolvedSessionDatabase);
      mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
      const directoryInfo = statSync(databaseDirectory);
      const directoryMode = directoryInfo.mode;
      const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (
        currentUid === undefined ||
        directoryInfo.uid !== currentUid ||
        (directoryMode & 0o022) !== 0
      ) {
        throw new Error("unsafe-database-directory");
      }
      let databaseFile: ReturnType<typeof lstatSync> | undefined;
      try {
        databaseFile = lstatSync(resolvedSessionDatabase);
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
      }
      if (databaseFile !== undefined) {
        if (!databaseFile.isFile()) throw new Error("unsafe-database-file");
        const descriptor = openSync(
          resolvedSessionDatabase,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const openedFile = fstatSync(descriptor);
          if (
            !openedFile.isFile() ||
            (typeof process.getuid === "function" && openedFile.uid !== process.getuid())
          ) {
            throw new Error("unsafe-database-file");
          }
          fchmodSync(descriptor, 0o600);
        } finally {
          closeSync(descriptor);
        }
      }
    } catch {
      process.stderr.write(
        "Unable to prepare protected preview session storage; use a current-user-owned parent directory without group or world write access and a regular database file owned by the current user.\n",
      );
      process.exitCode = 2;
      storageReady = false;
    }
    if (storageReady) {
      reportAllocationConfigDiagnostic();
      runMain();
    }
  } else {
    if (allocationControllerNeeded && readOnlyCapacityDoctor) reportAllocationConfigDiagnostic();
    runMain();
  }
}
