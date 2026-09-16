import {
  parseCommand,
  parsePositionals,
  type CommandOptions,
  type CommandParseError,
  type ParsedCommand,
} from "./commands";
import {
  composeProjectName,
  sensitiveEnvironmentKeys,
  validateModeConfig,
  type ComposeModeConfig,
  type FastModeConfig,
  type KubernetesModeConfig,
} from "./config";
import { makeDiagnostic, makeWarning } from "./diagnostics";
import { runDoctorEffect } from "./doctor";
import { redactExecutionText } from "./execution-shared";
import {
  makeFastExecutionContext,
  makeKubernetesExecutionContext,
  runDevelopmentExecution,
  type DevelopmentExecutionContext,
  type DevelopmentExecutionOptions,
  type DevelopmentLifecycleObservation,
  type KubernetesExecutionContext,
} from "./execution";
import { buildModePlan } from "./plan";
import { checkLoopbackPort } from "./ports";
import { isChangedSurface } from "./parity";
import {
  modeActions,
  fastServices,
  type DevelopmentMode,
  type Diagnostic,
  type LauncherOptions,
  type LauncherOutput,
  type LauncherResult,
  type PortChecker,
} from "./types";
import { Cause, Effect, Exit, Match } from "effect";
import {
  makeLifecycleStreamWriter,
  renderLifecyclePlan,
  renderLifecycleTerminal,
} from "./lifecycle";
import {
  makeComposeExecutionContext as makeComposeContext,
  type ComposeExecutionContext,
} from "./compose-execution";

export * from "./types";
export {
  executeFast,
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
  makeFastExecutionContext,
  runFastExecution,
  type FastExecutionContext,
  type FastExecutionOutcome,
  type FastExecutionOutcomeStatus,
  type FastExecutionOptions,
  type FastExecutionResult,
  type FastPrerequisite,
  type FastPrerequisiteKind,
  type FastReadinessTarget,
  type LifecycleObservation,
  executeDevelopment,
  executeKubernetes,
  makeKubernetesExecutionContext,
  runDevelopmentExecution,
  runKubernetesExecution,
  type DevelopmentExecutionContext,
  type DevelopmentExecutionOptions,
  type DevelopmentExecutionResult,
  type DevelopmentLifecycleObservation,
  type KubernetesExecutionContext,
  type KubernetesExecutionOptions,
  type KubernetesExecutionOutcome,
  type KubernetesExecutionPhase,
  type KubernetesExecutionResult,
  type KubernetesExecutionStep,
  type KubernetesExecutionTarget,
  type KubernetesLifecycleObservation,
} from "./execution";
export { parseCommand, parsePositionals } from "./commands";
export {
  COMPOSE_ENDPOINTS,
  COMPOSE_ENVIRONMENT_KEYS,
  DETERMINISTIC_PORTS,
  DEVELOPMENT_IMAGE_REGISTRY,
  FAST_ENDPOINTS,
  FAST_ENVIRONMENT_KEYS,
  FAST_HOST_ENVIRONMENT_KEYS,
  KUBERNETES_ENDPOINTS,
  KUBERNETES_ENVIRONMENT_KEYS,
  composeProjectName,
  sensitiveEnvironmentKeys,
  validateAmbientEnvironment,
  validateModeConfig,
} from "./config";
export {
  ChangedSurfaceSchema,
  changedSurfaces,
  isChangedSurface,
  selectParityGates,
} from "./parity";
export {
  lifecycleEventFor,
  lifecycleEventFormat,
  lifecycleEventVersion,
  makeLifecycleStreamWriter,
  renderLifecyclePlan,
  renderLifecycleEvent,
  renderLifecycleTerminal,
  type LifecycleEvent,
  type LifecycleEventObservation,
  type LifecycleStreamWriter,
} from "./lifecycle";

const modeServices = {
  fast: ["sheet-web"],
  compose: ["sheet-auth", "sheet-db-server", "sheet-workflows", "sheet-web", "sheet-bot"],
  kubernetes: ["sheet-auth", "sheet-db-server", "sheet-workflows", "sheet-web", "sheet-bot"],
} as const satisfies Readonly<Record<DevelopmentMode, readonly string[]>>;

const plannedDevelopmentContexts = new WeakMap<LauncherOutput, DevelopmentExecutionContext>();
// Prefer the result identity, then recover contexts for copies that retain the planned output.
const launcherDevelopmentContexts = new WeakMap<LauncherResult, DevelopmentExecutionContext>();

const modeDescriptions: Readonly<Record<DevelopmentMode, string>> = {
  fast: "Fast mode edits sheet-web on the host and uses explicit development endpoints.",
  compose: "Compose mode uses the local packaged integration environment.",
  kubernetes: "Kubernetes mode targets the fixed development preview release.",
};

export const getDevelopmentExecutionContext = (
  resultOrOutput: LauncherResult | LauncherOutput,
): DevelopmentExecutionContext | undefined => {
  if ("output" in resultOrOutput) {
    return (
      launcherDevelopmentContexts.get(resultOrOutput) ??
      plannedDevelopmentContexts.get(resultOrOutput.output)
    );
  }
  return plannedDevelopmentContexts.get(resultOrOutput);
};

export const getComposeExecutionContext = (
  output: LauncherOutput,
): ComposeExecutionContext | undefined => {
  const context = getDevelopmentExecutionContext(output);
  return context?.mode === "compose" ? context : undefined;
};

export const helpText = `TiaraStack development launcher

Usage:
  pnpm dev
  pnpm dev fast
  pnpm dev compose <action>
  pnpm dev kubernetes <action>
  pnpm dev doctor
  pnpm dev setup <mode>

Modes:
  fast       Run the smallest host-native development slice.
  compose    Use the local packaged integration environment.
  kubernetes Use the development preview environment.
  doctor     Check tools, configuration, credentials, ports, and access.

Use pnpm dev <mode> help for mode-specific actions.
Use --json for one stable result document or --json-stream for lifecycle JSONL
events. Do not combine the two output modes.
`;

const modeHelpText = (mode: DevelopmentMode) => {
  const actions = modeActions[mode]
    .map((action) => {
      if (mode === "compose" && action === "reset") {
        return `  pnpm dev ${mode} ${action} --confirm`;
      }
      if (mode === "kubernetes" && action === "preview") {
        return `  pnpm dev ${mode} ${action} --tag <image-tag> --confirm-development`;
      }
      return `  pnpm dev ${mode} ${action}`;
    })
    .join("\n");
  const surfaces =
    mode === "kubernetes"
      ? "\nChanged-surface gates: repeat --changed-surface <surface> on validate or preview. See docs/development-launcher.md for supported values.\n"
      : "";
  return `TiaraStack ${mode} mode\n\n${modeDescriptions[mode]}\n\nActions:\n${actions}\n${surfaces}\nA mode without an action only prints this help. Use --json-stream on an action to receive ordered lifecycle events and one terminal outcome.\n`;
};

const emptyOutput = (command: string, mode: LauncherOutput["mode"] = null): LauncherOutput => ({
  schemaVersion: 3,
  ok: true,
  command,
  mode,
  action: null,
  selectedServices: [],
  checkoutState: null,
  plannedProcesses: [],
  urls: [],
  readiness: "help",
  warnings: [],
  errors: [],
  changedSurfaces: [],
  parityGates: [],
});

const outputForParseError = (error: CommandParseError): LauncherOutput => ({
  ...emptyOutput("invalid command"),
  ok: false,
  readiness: "blocked",
  errors: [
    makeDiagnostic(
      error.code,
      error.detail,
      "Run pnpm dev --help to see the supported commands and options.",
    ),
  ],
});

// fallow-ignore-next-line complexity
const renderHuman = (output: LauncherOutput, help?: string) => {
  if (help !== undefined) return help;

  const lines = [
    "TiaraStack development launcher",
    `command: ${output.command}`,
    `mode: ${output.mode ?? "all"}`,
    `action: ${output.action ?? "none"}`,
    `readiness: ${output.readiness}`,
  ];
  if (output.selectedServices.length > 0) {
    lines.push(`selected services: ${output.selectedServices.join(", ")}`);
  }
  if (output.changedSurfaces.length > 0) {
    lines.push(`changed surfaces: ${output.changedSurfaces.join(", ")}`);
  }
  if (output.parityGates.length > 0) {
    lines.push("parity gates:");
    for (const parityGate of output.parityGates) {
      lines.push(`  ${parityGate.id}: ${parityGate.status} (${parityGate.reason})`);
    }
  }
  if (output.checkoutState !== null) lines.push(`checkout state: ${output.checkoutState}`);
  lines.push("planned processes:");
  if (output.plannedProcesses.length === 0) {
    lines.push("  none");
  } else {
    for (const process of output.plannedProcesses) {
      lines.push(`  ${process.id}: ${[process.command, ...process.args].join(" ")}`);
    }
  }
  if (output.urls.length > 0) {
    lines.push("urls:");
    for (const plannedUrl of output.urls) lines.push(`  ${plannedUrl.name}: ${plannedUrl.url}`);
  }
  if (output.warnings.length > 0) {
    lines.push("warnings:");
    for (const item of output.warnings) lines.push(`  [${item.code}] ${item.message}`);
  }
  if (output.errors.length > 0) {
    lines.push("errors:");
    for (const item of output.errors) {
      lines.push(`  [${item.code}] ${item.message}`);
      lines.push(`    remediation: ${item.remediation}`);
    }
  }
  return `${lines.join("\n")}\n`;
};

const redactedOutput = (output: LauncherOutput): LauncherOutput => ({
  ...output,
  plannedProcesses: output.plannedProcesses.map((process) => ({
    ...process,
    environment: Object.fromEntries(
      Object.entries(process.environment).map(([key, value]) => [
        key,
        sensitiveEnvironmentKeys.has(key) ||
        (/(?:PASSWORD|SECRET|TOKEN|KEY|URL)$/.test(key) &&
          ["POSTGRES_URL", "REDIS_URL", "SHEET_AUTH_OAUTH_JWKS_URL"].includes(key))
          ? "<redacted>"
          : value,
      ]),
    ),
  })),
});

export const renderLauncherOutput = (output: LauncherOutput, json: boolean, help?: string) => {
  const safeOutput = redactedOutput(output);
  return json ? `${JSON.stringify(safeOutput)}\n` : renderHuman(safeOutput, help);
};

const serviceError = (
  command: Extract<ParsedCommand, { kind: "mode" }>,
): Diagnostic | undefined => {
  const service = command.options.service;
  if (service === null) return undefined;
  if (command.mode === "kubernetes") {
    return makeDiagnostic(
      "invalid-service",
      "Kubernetes preview applies the complete development release and does not support service selection",
      "Omit --service for Kubernetes commands. Use --service with Fast or Compose plans.",
      { mode: command.mode, action: command.action },
    );
  }
  if (command.mode === "compose" && (command.action === "seed" || command.action === "reset")) {
    return makeDiagnostic(
      "invalid-service",
      `Compose ${command.action} applies the complete Checkout State and does not support service selection`,
      `Omit --service from Compose ${command.action}.`,
      { mode: command.mode, action: command.action },
    );
  }
  const availableServices = command.mode === "fast" ? fastServices : modeServices[command.mode];
  if ((availableServices as readonly string[]).includes(service)) return undefined;
  return makeDiagnostic(
    "invalid-service",
    `${service} is not a selectable service for ${command.mode} mode`,
    `Choose one of: ${availableServices.join(", ")}.`,
    { mode: command.mode, action: command.action },
  );
};

// fallow-ignore-next-line complexity
const optionError = (command: Extract<ParsedCommand, { kind: "mode" }>): Diagnostic | undefined => {
  const { action, mode, options } = command;
  const details = { mode, action };
  if (mode === "compose" && action === "reset" && !options.confirm) {
    return makeDiagnostic(
      "confirmation-required",
      "Compose reset is destructive and needs --confirm",
      "Review the selected Checkout State, then rerun pnpm dev compose reset --confirm.",
      details,
    );
  }
  if (options.confirm && !(mode === "compose" && action === "reset")) {
    return makeDiagnostic(
      "invalid-option",
      "--confirm is only valid for Compose reset",
      "Use --confirm only with pnpm dev compose reset.",
      details,
    );
  }
  if (mode === "kubernetes" && action === "preview") {
    if (!options.confirmDevelopment) {
      return makeDiagnostic(
        "confirmation-required",
        "Kubernetes preview needs explicit development-context confirmation",
        "Select the development kubectl context and rerun with --confirm-development.",
        details,
      );
    }
    if (options.tag === null || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.tag)) {
      return makeDiagnostic(
        "invalid-image-tag",
        "Kubernetes preview requires a safe image tag",
        "Pass --tag with 1 to 128 letters, numbers, dots, underscores, or hyphens.",
        details,
      );
    }
  } else if (options.tag !== null || options.confirmDevelopment) {
    return makeDiagnostic(
      "invalid-option",
      "--tag and --confirm-development are only valid for Kubernetes preview",
      "Use both options with pnpm dev kubernetes preview.",
      details,
    );
  }
  return undefined;
};

// fallow-ignore-next-line complexity
const planPortErrors = (
  command: Extract<ParsedCommand, { kind: "mode" }>,
  ports: Readonly<Record<string, number>>,
  checker: PortChecker,
): Effect.Effect<{ errors: Diagnostic[]; warnings: Diagnostic[] }> => {
  if (command.mode === "compose" || command.action !== "up") {
    return Effect.succeed({ errors: [], warnings: [] });
  }
  // fallow-ignore-next-line complexity
  return Effect.gen(function* () {
    const checks = yield* Effect.all(
      Object.entries(ports).map(([dependency, port]) =>
        Effect.tryPromise(() => checker(port)).pipe(
          Effect.map((result) => ({ dependency, port, result })),
          Effect.catch(() => Effect.succeed({ dependency, port, result: null })),
        ),
      ),
      { concurrency: "unbounded" },
    );
    const errors: Diagnostic[] = [];
    const warnings: Diagnostic[] = [];
    for (const { dependency, port, result } of checks) {
      if (result === null) {
        errors.push(
          makeDiagnostic(
            "dependency-unavailable",
            `Could not check deterministic port ${port} for ${dependency}`,
            "Retry the command and inspect local processes if the check continues to fail.",
            { mode: command.mode, action: command.action, dependency, port },
          ),
        );
        continue;
      }
      if (result.available) continue;
      const status = result.status ?? "occupied";
      const diagnostic = makeDiagnostic(
        status === "occupied" ? "port-collision" : "dependency-unavailable",
        status === "occupied"
          ? `Deterministic port ${port} for ${dependency} is already in use`
          : `Could not determine whether deterministic port ${port} for ${dependency} is available`,
        status === "occupied"
          ? "Stop the process using this port or choose an explicit non-colliding development assignment."
          : "Retry the command and inspect local processes if the check continues to fail.",
        { mode: command.mode, action: command.action, dependency, port },
      );
      (status === "unsupported" ? warnings : errors).push(
        status === "unsupported"
          ? makeWarning(diagnostic.code, diagnostic.message, diagnostic.remediation, diagnostic)
          : diagnostic,
      );
    }
    return { errors, warnings };
  });
};

const modeOutput = (
  command: Extract<ParsedCommand, { kind: "mode" }>,
  options: LauncherOptions,
): Effect.Effect<LauncherOutput> =>
  // fallow-ignore-next-line complexity
  Effect.gen(function* () {
    const invalidSurface = command.options.changedSurfaces.find(
      (surface) => !isChangedSurface(surface),
    );
    if (invalidSurface !== undefined) {
      return {
        ...emptyOutput(command.command, command.mode),
        ok: false,
        action: command.action,
        readiness: "blocked",
        errors: [
          makeDiagnostic(
            "invalid-changed-surface",
            `${invalidSurface} is not a supported changed surface`,
            "Use a supported value with --changed-surface; see pnpm dev kubernetes help.",
            { mode: command.mode, action: command.action },
          ),
        ],
      };
    }
    if (command.options.changedSurfaces.length > 0 && command.mode !== "kubernetes") {
      return {
        ...emptyOutput(command.command, command.mode),
        ok: false,
        action: command.action,
        readiness: "blocked",
        errors: [
          makeDiagnostic(
            "invalid-option",
            "--changed-surface is only valid for Kubernetes commands",
            "Use --changed-surface with pnpm dev kubernetes validate or preview.",
            { mode: command.mode, action: command.action },
          ),
        ],
      };
    }
    const changedSurfaces = command.options.changedSurfaces.filter(isChangedSurface);
    const services =
      command.options.service === null
        ? [...modeServices[command.mode]]
        : [command.options.service];
    const error = serviceError(command);
    if (error !== undefined) {
      return {
        ...emptyOutput(command.command, command.mode),
        ok: false,
        action: command.action,
        checkoutState:
          command.mode === "compose"
            ? `Checkout State ${composeProjectName(options.cwd ?? process.cwd())}`
            : null,
        readiness: "blocked",
        errors: [error],
        changedSurfaces,
      };
    }
    const optionFailure = optionError(command);
    if (optionFailure !== undefined) {
      // fallow-ignore-next-line code-duplication
      return {
        ...emptyOutput(command.command, command.mode),
        ok: false,
        action: command.action,
        checkoutState:
          command.mode === "compose"
            ? `Checkout State ${composeProjectName(options.cwd ?? process.cwd())}`
            : null,
        readiness: "blocked",
        errors: [optionFailure],
        changedSurfaces,
      };
    }
    const validation = validateModeConfig({
      mode: command.mode,
      action: command.action,
      env: options.env ?? process.env,
      cwd: options.cwd ?? process.cwd(),
      envFile: command.options.envFile ?? options.envFile ?? null,
      selectedServices: services,
    });
    if (validation.config === null) {
      return {
        ...emptyOutput(command.command, command.mode),
        ok: false,
        action: command.action,
        readiness: "blocked",
        warnings: validation.warnings,
        errors: validation.errors,
        changedSurfaces,
      };
    }
    const plan =
      validation.config.mode === "fast"
        ? buildModePlan(validation.config as FastModeConfig, "up", services)
        : validation.config.mode === "compose"
          ? buildModePlan(
              validation.config as ComposeModeConfig,
              command.action as "up" | "build" | "down" | "seed" | "reset",
              services,
              null,
              command.options.service !== null,
            )
          : buildModePlan(
              validation.config as KubernetesModeConfig,
              command.action as "validate" | "preview",
              services,
              command.options.tag,
              false,
              changedSurfaces,
            );
    const portFailures =
      command.mode === "compose"
        ? { errors: [], warnings: [] }
        : yield* planPortErrors(
            command,
            "ports" in validation.config
              ? Object.fromEntries([
                  ...Object.entries(validation.config.ports).filter(([service]) =>
                    services.includes(service),
                  ),
                  ...(command.mode === "fast" &&
                  services.some(
                    (service) =>
                      service === "sheet-auth" ||
                      service === "sheet-db-server" ||
                      service === "sheet-workflows",
                  )
                    ? [
                        ...(services.some(
                          (service) =>
                            service === "sheet-auth" ||
                            service === "sheet-db-server" ||
                            service === "sheet-workflows",
                        )
                          ? [
                              [
                                "prometheus",
                                Number(
                                  (validation.config as FastModeConfig).serviceEnvironments[
                                    "sheet-auth"
                                  ].PROMETHEUS_PORT,
                                ),
                              ] as const,
                            ]
                          : []),
                        ...(services.includes("sheet-workflows") &&
                        (validation.config as FastModeConfig).serviceEnvironments["sheet-workflows"]
                          .SHEET_WORKFLOWS_ROLE === "combined"
                          ? [
                              [
                                "sheet-workflows runner",
                                Number(
                                  (validation.config as FastModeConfig).serviceEnvironments[
                                    "sheet-workflows"
                                  ].WORKFLOWS_RUNNER_LISTEN_PORT,
                                ),
                              ] as const,
                            ]
                          : []),
                      ]
                    : []),
                ])
              : {},
            options.portChecker ?? checkLoopbackPort,
          );
    if (portFailures.errors.length > 0) {
      return {
        ...emptyOutput(command.command, command.mode),
        ok: false,
        action: command.action,
        selectedServices: plan.selectedServices,
        plannedProcesses: plan.plannedProcesses,
        urls: plan.urls,
        readiness: "blocked",
        warnings: [...validation.warnings, ...portFailures.warnings],
        errors: portFailures.errors,
        changedSurfaces,
        parityGates: plan.parityGates,
      };
    }
    const output: LauncherOutput = {
      ...emptyOutput(command.command, command.mode),
      ok: true,
      action: command.action,
      selectedServices: plan.selectedServices,
      checkoutState: validation.config.mode === "compose" ? validation.config.checkoutState : null,
      plannedProcesses: plan.plannedProcesses,
      urls: plan.urls,
      readiness: "planned",
      warnings: [...validation.warnings, ...portFailures.warnings],
      changedSurfaces,
      parityGates: plan.parityGates,
    };
    let executionContext: DevelopmentExecutionContext;
    try {
      executionContext = Match.value(validation.config).pipe(
        Match.when({ mode: "fast" }, () =>
          makeFastExecutionContext(output, options.cwd ?? process.cwd()),
        ),
        Match.when({ mode: "compose" }, (config) =>
          makeComposeContext(output, options.cwd ?? process.cwd(), {
            environment: config.validatedEnvironment,
          }),
        ),
        Match.when({ mode: "kubernetes" }, (config) =>
          makeKubernetesExecutionContext(
            config,
            plan,
            output,
            options.cwd ?? process.cwd(),
            command.options.tag,
          ),
        ),
        Match.exhaustive,
      );
    } catch (cause) {
      const reason =
        cause instanceof Error
          ? redactExecutionText(cause.message)
          : typeof cause === "string"
            ? redactExecutionText(cause)
            : "";
      return {
        ...output,
        ok: false,
        readiness: "blocked",
        errors: [
          makeDiagnostic(
            "context-preparation-failed",
            `${command.mode} ${command.action} execution context could not be prepared${reason === "" ? "" : `: ${reason}`}`,
            "Recreate the plan through the launcher command and retry after checking its validated configuration.",
            { mode: command.mode, action: command.action },
          ),
        ],
      };
    }
    plannedDevelopmentContexts.set(output, executionContext);
    return output;
  });

const setupOutput = (command: Extract<ParsedCommand, { kind: "setup" }>): LauncherOutput => {
  if (command.mode === "compose") {
    return {
      ...emptyOutput("setup compose", "compose"),
      ok: true,
      action: "setup",
      readiness: "planned",
      plannedProcesses: [
        {
          id: "compose-credentials",
          packageName: null,
          command: "pnpm",
          args: [
            "compose:generate-secrets",
            ...(command.options.envFile === null
              ? []
              : ["--", "--env-file", command.options.envFile]),
          ],
          environment: {},
          longLived: false,
          readOnly: false,
        },
      ],
    };
  }
  return {
    ...emptyOutput(`setup ${command.mode}`, command.mode),
    ok: false,
    action: "setup",
    readiness: "blocked",
    errors: [
      makeDiagnostic(
        "not-implemented",
        `Setup for ${command.mode} mode is not implemented in the launcher core`,
        `Run the documented ${command.mode} prerequisites manually, then use pnpm dev doctor.`,
        { mode: command.mode, action: "setup" },
      ),
    ],
  };
};

const doctorOutput = (
  command: Extract<ParsedCommand, { kind: "doctor" }>,
  options: LauncherOptions,
): Effect.Effect<LauncherOutput> =>
  Effect.gen(function* () {
    const selectedServices =
      command.options.service === null ? ["sheet-web"] : [command.options.service];
    const doctor = yield* runDoctorEffect({
      ...options,
      envFile: command.options.envFile ?? options.envFile ?? null,
      selectedServices,
    });
    return {
      ...emptyOutput(command.command, "all"),
      ok: doctor.errors.length === 0,
      action: "doctor",
      selectedServices,
      plannedProcesses: doctor.plannedProcesses,
      urls: doctor.urls,
      readiness: doctor.errors.length === 0 ? "ready" : "blocked",
      warnings: doctor.warnings,
      errors: doctor.errors,
    };
  });

const isCommandParseError = (error: unknown): error is CommandParseError =>
  error instanceof Error && error.name === "CommandParseError";

const runLauncherEffect = async <A>(program: Effect.Effect<A>): Promise<A> => {
  const exit = await Effect.runPromiseExit(program);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
};

const launcherResult = (
  output: LauncherOutput,
  json: boolean,
  help?: string,
  jsonStream = false,
): LauncherResult => {
  const result: LauncherResult = {
    exitCode: output.ok ? 0 : 2,
    stdout: jsonStream
      ? output.ok
        ? renderLifecyclePlan(output, help)
        : renderLifecycleTerminal(output)
      : renderLauncherOutput(output, json, help),
    stderr: "",
    output,
  };
  const context = plannedDevelopmentContexts.get(output);
  if (context !== undefined) launcherDevelopmentContexts.set(result, context);
  return result;
};

export const getKubernetesExecutionContext = (
  result: LauncherResult,
): KubernetesExecutionContext | undefined => {
  const context = getDevelopmentExecutionContext(result);
  return context?.mode === "kubernetes" ? context : undefined;
};

export interface DevelopmentPlanExecutionOptions extends Omit<
  DevelopmentExecutionOptions,
  "onObservation"
> {
  readonly jsonStream?: boolean;
  readonly onObservation?: (observation: DevelopmentLifecycleObservation) => void;
  readonly writeStdout?: (value: string) => void;
  readonly writeStderr?: (value: string) => void;
}

const executionDiagnosticText = (diagnostics: readonly Diagnostic[]) =>
  diagnostics
    .map(
      ({ code, message, remediation }) => `[${code}] ${message}\n  remediation: ${remediation}\n`,
    )
    .join("");

const executionContextDiagnostic = (output: LauncherOutput) =>
  makeDiagnostic(
    "context-preparation-failed",
    `${output.mode ?? "development"} ${output.action ?? "action"} execution context was not retained from validated configuration`,
    "Recreate the plan through the launcher command and retry without modifying its configuration between planning and execution.",
    { mode: output.mode, action: output.action },
  );

const isSelectedReadiness = (observation: DevelopmentLifecycleObservation) =>
  observation.type === "readiness" &&
  observation.status === "ready" &&
  (observation.mode !== "compose" || observation.allSelected === true);

// This is the only terminal adapter for executable Development Mode plans. It
// owns presentation only; validated execution context and lifecycle ownership
// stay in the planning and execution modules.
// fallow-ignore-next-line complexity
export const executeDevelopmentPlan = async (
  result: LauncherResult,
  json: boolean,
  options: DevelopmentPlanExecutionOptions = {},
): Promise<LauncherResult> => {
  if (!result.output.ok || result.output.plannedProcesses.length === 0) return result;

  const jsonStream = options.jsonStream === true;
  const writeStdout = options.writeStdout ?? ((value: string) => process.stdout.write(value));
  const writeStderr = options.writeStderr ?? ((value: string) => process.stderr.write(value));
  const lifecycleStream = jsonStream
    ? makeLifecycleStreamWriter(result.output, writeStdout)
    : undefined;
  const context = getDevelopmentExecutionContext(result);
  if (context === undefined) {
    const blocked = {
      ...result.output,
      ok: false,
      readiness: "blocked" as const,
      errors: [executionContextDiagnostic(result.output)],
    } satisfies LauncherOutput;
    return {
      ...result,
      exitCode: 2,
      stdout: jsonStream ? renderLifecycleTerminal(blocked) : renderLauncherOutput(blocked, json),
      stderr: "",
      output: blocked,
    };
  }

  let readinessPrinted = false;
  const observationHandler = (observation: DevelopmentLifecycleObservation) => {
    options.onObservation?.(observation);
    if (jsonStream) {
      const readinessObservation = isSelectedReadiness(observation);
      if (readinessObservation) readinessPrinted = true;
      try {
        lifecycleStream?.writeObservation(observation);
      } catch (cause) {
        if (readinessObservation) readinessPrinted = false;
        throw cause;
      }
      return;
    }
    if (readinessPrinted || !isSelectedReadiness(observation)) return;
    writeStdout(renderLauncherOutput({ ...result.output, readiness: "ready" }, json));
    readinessPrinted = true;
  };
  const {
    jsonStream: _jsonStream,
    onObservation: _onObservation,
    writeStdout: _writeStdout,
    writeStderr: _writeStderr,
    output: requestedOutput,
    ...executionOptions
  } = options;
  const runOptions: DevelopmentExecutionOptions = {
    ...executionOptions,
    ...(requestedOutput === undefined ? {} : { output: requestedOutput }),
    onObservation: observationHandler,
  };

  try {
    const executionOutput =
      requestedOutput === "capture" ? "capture" : json || jsonStream ? "stderr" : requestedOutput;
    const execution = await runDevelopmentExecution(
      context,
      executionOutput === undefined ? runOptions : { ...runOptions, output: executionOutput },
    );
    const diagnostics = [execution.outcome.diagnostic, execution.outcome.cleanupDiagnostic].filter(
      (diagnostic): diagnostic is NonNullable<typeof diagnostic> => diagnostic !== undefined,
    );
    const diagnosticOutput = executionDiagnosticText(diagnostics);
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
  } catch (cause) {
    if (jsonStream && lifecycleStream?.hasTerminal()) {
      throw new Error("Development execution failed after its terminal event");
    }
    const reason =
      cause instanceof Error
        ? redactExecutionText(cause.message)
        : typeof cause === "string"
          ? redactExecutionText(cause)
          : "";
    const message = `${
      readinessPrinted
        ? "Development execution failed after readiness"
        : "Development execution could not be prepared"
    }${reason === "" ? "" : `: ${reason}`}`;
    const diagnostic = makeDiagnostic(
      readinessPrinted ? "required-dependency-failed" : "dependency-unavailable",
      message,
      "Retry the command after checking the validated Development Mode plan and process diagnostics.",
      { mode: result.output.mode, action: result.output.action },
    );
    const blocked = {
      ...result.output,
      ok: false,
      readiness: readinessPrinted ? ("ready" as const) : ("blocked" as const),
      errors: [diagnostic],
    } satisfies LauncherOutput;
    const exitCode = readinessPrinted ? 1 : 2;
    const stderr = executionDiagnosticText(blocked.errors);
    if (jsonStream) {
      lifecycleStream?.writeTerminal(blocked, exitCode, readinessPrinted ? "failed" : "blocked");
      writeStderr(stderr);
      return { ...result, exitCode, stdout: "", stderr, output: blocked };
    }
    if (readinessPrinted) {
      writeStderr(stderr);
      return { ...result, exitCode, stdout: "", stderr, output: blocked };
    }
    return {
      ...result,
      exitCode,
      stdout: renderLauncherOutput(blocked, json),
      stderr: "",
      output: blocked,
    };
  }
};

const runParsedCommand = (
  command: ParsedCommand,
  options: LauncherOptions,
): Effect.Effect<LauncherResult> =>
  Effect.gen(function* () {
    let output: LauncherOutput;
    let help: string | undefined;
    if (command.kind === "help") {
      output = emptyOutput(command.command, command.mode);
      help = command.mode === null ? helpText : modeHelpText(command.mode);
    } else if (command.kind === "mode") {
      output = yield* modeOutput(command, options);
    } else if (command.kind === "setup") {
      output = setupOutput(command);
    } else {
      output = yield* doctorOutput(command, options);
    }
    return launcherResult(output, command.options.json, help, command.options.jsonStream === true);
  });

export const runLauncherFromParsed = async (
  positionals: readonly string[],
  options: CommandOptions,
  launcherOptions: LauncherOptions = {},
): Promise<LauncherResult> => {
  try {
    return await runLauncherEffect(
      runParsedCommand(parsePositionals(positionals, options), launcherOptions),
    );
  } catch (error) {
    if (!isCommandParseError(error)) throw error;
    return launcherResult(
      outputForParseError(error),
      options.json,
      undefined,
      options.jsonStream === true,
    );
  }
};

export const runLauncher = async (
  args: readonly string[],
  options: LauncherOptions = {},
): Promise<LauncherResult> => {
  const json = args.includes("--json");
  try {
    return await runLauncherEffect(runParsedCommand(parseCommand(args), options));
  } catch (error) {
    if (!isCommandParseError(error)) throw error;
    return launcherResult(
      outputForParseError(error),
      json,
      undefined,
      args.includes("--json-stream"),
    );
  }
};
