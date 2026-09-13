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
import { buildModePlan } from "./plan";
import { checkLoopbackPort } from "./ports";
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
import { Cause, Effect, Exit } from "effect";

export * from "./types";
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

const modeServices = {
  fast: ["sheet-web"],
  compose: ["sheet-auth", "sheet-db-server", "sheet-workflows", "sheet-web", "sheet-bot"],
  kubernetes: ["sheet-auth", "sheet-db-server", "sheet-workflows", "sheet-web", "sheet-bot"],
} as const satisfies Readonly<Record<DevelopmentMode, readonly string[]>>;

const modeDescriptions: Readonly<Record<DevelopmentMode, string>> = {
  fast: "Fast mode edits sheet-web on the host and uses explicit development endpoints.",
  compose: "Compose mode uses the local packaged integration environment.",
  kubernetes: "Kubernetes mode targets the fixed development preview release.",
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
  return `TiaraStack ${mode} mode\n\n${modeDescriptions[mode]}\n\nActions:\n${actions}\n\nA mode without an action only prints this help.\n`;
};

const emptyOutput = (command: string, mode: LauncherOutput["mode"] = null): LauncherOutput => ({
  schemaVersion: 2,
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
      };
    }
    return {
      ...emptyOutput(command.command, command.mode),
      ok: true,
      action: command.action,
      selectedServices: plan.selectedServices,
      checkoutState: validation.config.mode === "compose" ? validation.config.checkoutState : null,
      plannedProcesses: plan.plannedProcesses,
      urls: plan.urls,
      readiness: "planned",
      warnings: [...validation.warnings, ...portFailures.warnings],
    };
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

const launcherResult = (output: LauncherOutput, json: boolean, help?: string): LauncherResult => ({
  exitCode: output.ok ? 0 : 2,
  stdout: renderLauncherOutput(output, json, help),
  stderr: "",
  output,
});

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
    return launcherResult(output, command.options.json, help);
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
    return launcherResult(outputForParseError(error), options.json);
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
    return launcherResult(outputForParseError(error), json);
  }
};
