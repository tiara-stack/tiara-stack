import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import {
  COMPOSE_ENVIRONMENT_KEYS,
  DETERMINISTIC_PORTS,
  FAST_ENDPOINTS,
  FAST_ENVIRONMENT_KEYS,
  KUBERNETES_ENVIRONMENT_KEYS,
  validateAmbientEnvironment,
  validateModeConfig,
  type DoctorConfiguration,
} from "./config";
import { makeDiagnostic, makeWarning } from "./diagnostics";
import { checkHttpAccess } from "./access";
import { spawnProcess } from "./executor";
import { checkLoopbackPort } from "./ports";
import type {
  AccessChecker,
  Diagnostic,
  LauncherOptions,
  PlannedProcess,
  PlannedUrl,
  PortChecker,
  ProcessExecutor,
} from "./types";

const checkTimeoutMs = 2_000;

const withDiagnosticKind = (diagnostic: Diagnostic, kind: Diagnostic["kind"]): Diagnostic => ({
  ...diagnostic,
  kind,
});

interface ToolCheck {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly mode: "all" | "fast" | "compose" | "kubernetes";
  readonly dependency: string;
  readonly remediation: string;
}

const toolChecks: readonly ToolCheck[] = [
  {
    id: "node",
    command: "node",
    args: ["--version"],
    mode: "all",
    dependency: "Node.js LTS",
    remediation: "Install Node.js LTS and make node available on PATH.",
  },
  {
    id: "pnpm",
    command: "pnpm",
    args: ["--version"],
    mode: "all",
    dependency: "pnpm",
    remediation: "Enable the repository's pnpm version through Corepack.",
  },
  {
    id: "vp",
    command: "vp",
    args: ["--version"],
    mode: "fast",
    dependency: "vite-plus",
    remediation: "Run pnpm install and make the workspace vite-plus binary available.",
  },
  {
    id: "docker",
    command: "docker",
    args: ["compose", "version"],
    mode: "compose",
    dependency: "Docker Compose",
    remediation: "Install Docker Desktop or Docker Engine with the Compose plugin.",
  },
  {
    id: "helm",
    command: "helm",
    args: ["version", "--short"],
    mode: "kubernetes",
    dependency: "Helm",
    remediation: "Install Helm 3.8 or newer and make helm available on PATH.",
  },
  {
    id: "kubectl",
    command: "kubectl",
    args: ["version", "--client=true"],
    mode: "kubernetes",
    dependency: "kubectl",
    remediation: "Install kubectl and select the development cluster context.",
  },
];

const plannedToolProcess = (check: ToolCheck): PlannedProcess => ({
  id: `doctor:${check.id}`,
  packageName: null,
  command: check.command,
  args: check.args,
  environment: {},
  longLived: false,
  readOnly: true,
});

const runToolCheck = async (
  check: ToolCheck,
  executor: ProcessExecutor,
  cwd: string,
): Promise<Diagnostic | undefined> => {
  let result;
  try {
    result = await executor({
      command: check.command,
      args: check.args,
      cwd,
      env: {},
      timeoutMs: checkTimeoutMs,
      kind: "dependency-check",
      readOnly: true,
    });
  } catch {
    return makeDiagnostic(
      "dependency-unavailable",
      `${check.dependency} could not be checked for ${check.mode} mode`,
      check.remediation,
      { mode: check.mode, dependency: check.dependency },
    );
  }
  if (result.timedOut) {
    return makeDiagnostic(
      "dependency-timeout",
      `${check.dependency} did not respond within ${checkTimeoutMs}ms`,
      check.remediation,
      { mode: check.mode, dependency: check.dependency },
    );
  }
  if (result.exitCode !== 0) {
    return makeDiagnostic(
      "required-dependency-failed",
      `${check.dependency} is unavailable for ${check.mode} mode`,
      check.remediation,
      { mode: check.mode, dependency: check.dependency },
    );
  }
  return undefined;
};

const pickEnvironment = (env: NodeJS.ProcessEnv, keys: readonly string[]) => {
  const selected: Record<string, string> = {};
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined) selected[key] = value;
  }
  return selected;
};

const portChecks = [
  ["sheet-web", DETERMINISTIC_PORTS["sheet-web"]],
  ["sheet-auth", DETERMINISTIC_PORTS["sheet-auth"]],
  ["sheet-workflows", DETERMINISTIC_PORTS["sheet-workflows"]],
  ["zero-cache", DETERMINISTIC_PORTS["zero-cache"]],
  ["postgres", DETERMINISTIC_PORTS.postgres],
  ["redis", DETERMINISTIC_PORTS.redis],
  ["prometheus", DETERMINISTIC_PORTS.prometheus],
] as const;

// fallow-ignore-next-line complexity
const configurationDiagnostics = (
  cwd: string,
  env: NodeJS.ProcessEnv,
  envFile: string | null,
): DoctorConfiguration => {
  const diagnostics: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  diagnostics.push(...validateAmbientEnvironment("fast", "up", env));
  const fast = validateModeConfig({
    mode: "fast",
    action: "up",
    env: pickEnvironment(env, FAST_ENVIRONMENT_KEYS),
    cwd,
    envFile: null,
  });
  diagnostics.push(...fast.errors);

  const compose = validateModeConfig({
    mode: "compose",
    action: "up",
    env: pickEnvironment(env, COMPOSE_ENVIRONMENT_KEYS),
    cwd,
    envFile,
  });
  const composeConfigured =
    envFile !== null ||
    existsSync(path.join(cwd, "deploy/compose/.env")) ||
    COMPOSE_ENVIRONMENT_KEYS.some((key) => env[key] !== undefined);
  (composeConfigured ? diagnostics : warnings).push(
    ...compose.errors.map((error) =>
      withDiagnosticKind(error, composeConfigured ? "error" : "warning"),
    ),
  );

  const kubernetes = validateModeConfig({
    mode: "kubernetes",
    action: "preview",
    env: pickEnvironment(env, KUBERNETES_ENVIRONMENT_KEYS),
    cwd,
    envFile: null,
  });
  const kubernetesConfigured = KUBERNETES_ENVIRONMENT_KEYS.some(
    (key) => key !== "KUBECONFIG" && env[key] !== undefined,
  );
  (kubernetesConfigured ? diagnostics : warnings).push(
    ...kubernetes.errors.map((error) =>
      withDiagnosticKind(error, kubernetesConfigured ? "error" : "warning"),
    ),
  );

  const composeDirectory = path.join(cwd, "deploy/compose/secrets");
  for (const file of ["postgres-password", "redis-password", "jwks.json"]) {
    const secretPath = path.join(composeDirectory, file);
    if (!existsSync(secretPath)) {
      (composeConfigured ? diagnostics : warnings).push(
        withDiagnosticKind(
          makeDiagnostic(
            "unsafe-credential",
            `Compose development credential file ${file} is missing`,
            "Run pnpm compose:generate-secrets before using Compose mode.",
            { mode: "compose", dependency: file },
          ),
          composeConfigured ? "error" : "warning",
        ),
      );
    }
  }
  const composeEnvPath =
    envFile === null ? path.join(cwd, "deploy/compose/.env") : path.resolve(cwd, envFile);
  if (existsSync(composeEnvPath)) {
    try {
      if (process.platform !== "win32" && (statSync(composeEnvPath).mode & 0o077) !== 0) {
        (composeConfigured ? diagnostics : warnings).push(
          withDiagnosticKind(
            makeDiagnostic(
              "unsafe-credential",
              `Compose environment file ${composeEnvPath} is readable by other users`,
              "Set the environment file permissions to 0600 and keep it ignored by git.",
              { mode: "compose", dependency: "Development Credential Set" },
            ),
            composeConfigured ? "error" : "warning",
          ),
        );
      }
    } catch {
      (composeConfigured ? diagnostics : warnings).push(
        withDiagnosticKind(
          makeDiagnostic(
            "unsafe-credential",
            `Compose environment file ${composeEnvPath} could not be inspected`,
            "Check the file permissions and keep the file local and ignored.",
            { mode: "compose", dependency: "Development Credential Set" },
          ),
          composeConfigured ? "error" : "warning",
        ),
      );
    }
  }
  const ports = new Map<string, number>(portChecks);
  const fastPort = fast.config?.mode === "fast" ? fast.config.ports["sheet-web"] : undefined;
  if (fastPort !== undefined) ports.set("sheet-web", fastPort);
  if (compose.config?.mode === "compose") {
    for (const [dependency, port] of Object.entries(compose.config.ports)) {
      ports.set(dependency, port);
    }
  }
  return {
    errors: diagnostics,
    warnings,
    ports: [...ports.entries()],
    configuredModes: [
      "fast",
      ...(composeConfigured ? ["compose" as const] : []),
      ...(kubernetesConfigured ? ["kubernetes" as const] : []),
    ],
  };
};

const runPortChecks = async (
  checker: PortChecker,
  assignments: readonly (readonly [string, number])[] = portChecks,
): Promise<Diagnostic[]> => {
  const results = await Promise.all(
    assignments.map(async ([dependency, port]) => {
      let result;
      try {
        result = await checker(port);
      } catch {
        return makeDiagnostic(
          "dependency-unavailable",
          `Could not check deterministic port ${port} for ${dependency}`,
          "Retry the doctor command and inspect local processes if the check continues to fail.",
          { mode: "all", dependency, port },
        );
      }
      if (!result.available) {
        const status = result.status ?? "occupied";
        const code = status === "occupied" ? "port-collision" : "dependency-unavailable";
        return makeDiagnostic(
          code,
          code === "port-collision"
            ? `Deterministic port ${port} for ${dependency} is already in use`
            : `Could not determine whether deterministic port ${port} for ${dependency} is available`,
          code === "port-collision"
            ? "Stop the process using this port or choose an explicit non-colliding development assignment."
            : "Retry the doctor command and inspect local processes if the check continues to fail.",
          { mode: "all", dependency, port },
        );
      }
      return undefined;
    }),
  );
  return results.flatMap((result) => (result === undefined ? [] : [result]));
};

const runRequiredAccessChecks = async (checker: AccessChecker): Promise<Diagnostic[]> => {
  const required = [
    ["auth", FAST_ENDPOINTS.auth],
    ["zero", FAST_ENDPOINTS.zero],
    ["workflows", FAST_ENDPOINTS.workflows],
  ] as const;
  const results = await Promise.all(
    required.map(async ([dependency, origin]) => {
      let result;
      try {
        result = await checker({
          mode: "fast",
          dependency,
          origin,
          timeoutMs: checkTimeoutMs,
          optional: false,
        });
      } catch {
        return makeDiagnostic(
          "access-failed",
          `${dependency} at ${origin} could not be reached`,
          "Check the development DNS, network connection, and service readiness.",
          { mode: "fast", dependency, origin },
        );
      }
      if (result.reachable) return undefined;
      return makeDiagnostic(
        result.timedOut ? "dependency-timeout" : "access-failed",
        `${dependency} at ${origin} is not reachable`,
        "Check the development preview and retry after its readiness endpoint responds.",
        { mode: "fast", dependency, origin },
      );
    }),
  );
  return results.flatMap((result) => (result === undefined ? [] : [result]));
};

const runOptionalAccessCheck = async (checker: AccessChecker): Promise<Diagnostic | undefined> => {
  const optionalOrigin = "http://localhost:4318";
  try {
    const result = await checker({
      mode: "compose",
      dependency: "local-otel-sink",
      origin: optionalOrigin,
      timeoutMs: checkTimeoutMs,
      optional: true,
    });
    if (result.reachable) return undefined;
    return makeWarning(
      result.timedOut ? "dependency-timeout" : "access-failed",
      `Optional observability sink at ${optionalOrigin} is unavailable`,
      "Continue without local telemetry or start local-otel-sink before Compose up.",
      { mode: "compose", dependency: "local-otel-sink", origin: optionalOrigin },
    );
  } catch {
    return makeWarning(
      "access-failed",
      `Optional observability sink at ${optionalOrigin} could not be checked`,
      "Continue without local telemetry or start local-otel-sink before Compose up.",
      { mode: "compose", dependency: "local-otel-sink", origin: optionalOrigin },
    );
  }
};

const runAccessChecks = async (
  checker: AccessChecker,
): Promise<{ errors: Diagnostic[]; warnings: Diagnostic[] }> => {
  const [errors, optionalWarning] = await Promise.all([
    runRequiredAccessChecks(checker),
    runOptionalAccessCheck(checker),
  ]);
  return {
    errors,
    warnings: optionalWarning === undefined ? [] : [optionalWarning],
  };
};

export interface DoctorResult {
  readonly errors: readonly Diagnostic[];
  readonly warnings: readonly Diagnostic[];
  readonly plannedProcesses: readonly PlannedProcess[];
  readonly urls: readonly PlannedUrl[];
}

// fallow-ignore-next-line complexity
export const runDoctorEffect = (options: LauncherOptions): Effect.Effect<DoctorResult> => {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const executor = options.executor ?? spawnProcess;
  const portChecker = options.portChecker ?? checkLoopbackPort;
  const accessChecker = options.accessChecker ?? checkHttpAccess;
  return Effect.gen(function* () {
    const configuration = configurationDiagnostics(cwd, env, options.envFile ?? null);
    const errors = [...configuration.errors];
    const warnings: Diagnostic[] = [...configuration.warnings];
    const plannedProcesses = toolChecks.map(plannedToolProcess);
    const [toolFailures, portFailures, access] = yield* Effect.all(
      [
        Effect.all(
          toolChecks.map((check) => Effect.promise(() => runToolCheck(check, executor, cwd))),
          { concurrency: "unbounded" },
        ),
        Effect.promise(() =>
          runPortChecks(
            portChecker,
            configuration.configuredModes.includes("compose")
              ? configuration.ports
              : configuration.ports.filter(
                  ([dependency]) => dependency === "sheet-web" || dependency === "prometheus",
                ),
          ),
        ),
        configuration.configuredModes.includes("fast")
          ? Effect.promise(() => runAccessChecks(accessChecker))
          : Effect.succeed({ errors: [], warnings: [] }),
      ],
      { concurrency: "unbounded" },
    );
    for (const failure of toolFailures) {
      if (failure === undefined) continue;
      if (
        (failure.mode === "compose" && !configuration.configuredModes.includes("compose")) ||
        (failure.mode === "kubernetes" && !configuration.configuredModes.includes("kubernetes"))
      ) {
        warnings.push({ ...failure, kind: "warning" });
      } else {
        errors.push(failure);
      }
    }
    errors.push(...portFailures);
    errors.push(...access.errors);
    warnings.push(...access.warnings);
    return {
      errors,
      warnings,
      plannedProcesses,
      urls: [
        { name: "app", url: FAST_ENDPOINTS.app },
        { name: "auth", url: FAST_ENDPOINTS.auth },
        { name: "zero", url: FAST_ENDPOINTS.zero },
        { name: "workflows", url: FAST_ENDPOINTS.workflows },
      ],
    };
  });
};
