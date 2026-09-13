import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { Schema } from "effect";
import { makeDiagnostic } from "./diagnostics";
import {
  fastServices,
  type DevelopmentMode,
  type Diagnostic,
  type FastService,
  type ModeAction,
  type PlannedUrl,
} from "./types";

export const FAST_ENDPOINTS = {
  app: "http://localhost:3001",
  auth: "https://auth.dev.theerapakg.moe",
  zero: "https://zero.dev.theerapakg.moe",
  workflows: "https://workflows.dev.theerapakg.moe",
} as const;

export const COMPOSE_ENDPOINTS = {
  app: "http://localhost:3001",
  auth: "http://localhost:3002",
  zero: "http://localhost:4848",
  workflows: "http://localhost:3003",
} as const;

export const KUBERNETES_ENDPOINTS = {
  app: "https://schedule.dev.theerapakg.moe",
  auth: "https://auth.dev.theerapakg.moe",
  zero: "https://zero.dev.theerapakg.moe",
  workflows: "https://workflows.dev.theerapakg.moe",
} as const;

export const DEVELOPMENT_IMAGE_REGISTRY = "registry.digitalocean.com/theerapakg-registry";

export const DETERMINISTIC_PORTS = {
  "sheet-web": 3001,
  "sheet-auth": 3002,
  "sheet-workflows": 3003,
  "sheet-db-server": 3004,
  "sheet-bot": 3005,
  "local-jwks": 8081,
  "zero-cache": 4848,
  postgres: 5432,
  redis: 6379,
  prometheus: 9464,
} as const;

export const FAST_ENVIRONMENT_KEYS = [
  "APP_BASE_URL",
  "AUTH_BASE_URL",
  "DEV_SHEET_WEB_PORT",
  "SHEET_ZERO_BASE_URL",
  "SHEET_WORKFLOWS_BASE_URL",
] as const;

const fastHostEnvironmentKeys = [
  "BASE_URL",
  "COOKIE_DOMAIN",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "POSTGRES_URL",
  "REDIS_BASE",
  "REDIS_URL",
  "SHEET_AUTH_ISSUER",
  "SHEET_AUTH_OAUTH_AUDIENCE",
  "SHEET_AUTH_OAUTH_JWKS_URL",
  "TRUSTED_ORIGINS",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "DEV_SHEET_AUTH_PORT",
  "DEV_SHEET_DB_SERVER_PORT",
  "DEV_PROMETHEUS_PORT",
  "DEV_LOCAL_JWKS_PORT",
  "POD_NAMESPACE",
  "DEV_SHEET_WORKFLOWS_PORT",
  "DEV_WORKFLOWS_RUNNER_PORT",
  "SHEET_WORKFLOWS_ROLE",
  "SHEET_AUTH_OAUTH_CLIENT_ID",
  "SHEET_AUTH_OAUTH_CLIENT_SECRET",
  "SHEET_AUTH_WORKFLOW_HTTP_AUDIENCE",
  "SHEET_AUTH_WORKFLOW_HTTP_BROWSER_AUDIENCE",
  "SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID",
  "SHEET_WEB_BASE_URL",
  "SHEET_AUTH_TRUSTED_DELEGATION_CLIENT_IDS",
  "SHEET_AUTO_CHECKIN_SERVICE_ID",
  "SHEET_AUTO_CHECKIN_OAUTH_CLIENT_ID",
  "WORKFLOWS_RUNNER_HOST",
  "WORKFLOWS_RUNNER_PORT",
  "WORKFLOWS_RUNNER_LISTEN_HOST",
  "WORKFLOWS_RUNNER_LISTEN_PORT",
] as const;

export const FAST_HOST_ENVIRONMENT_KEYS = fastHostEnvironmentKeys;

const fastHostEnvironmentKeyOwners: Readonly<Record<string, readonly FastService[]>> = {
  BASE_URL: ["sheet-auth"],
  COOKIE_DOMAIN: ["sheet-auth"],
  DISCORD_CLIENT_ID: ["sheet-auth"],
  DISCORD_CLIENT_SECRET: ["sheet-auth"],
  POSTGRES_URL: ["sheet-auth", "sheet-db-server", "sheet-workflows"],
  REDIS_BASE: ["sheet-auth"],
  REDIS_URL: ["sheet-auth"],
  SHEET_AUTH_ISSUER: ["sheet-db-server", "sheet-workflows"],
  SHEET_AUTH_OAUTH_AUDIENCE: ["sheet-db-server", "sheet-workflows"],
  SHEET_AUTH_OAUTH_JWKS_URL: ["sheet-auth"],
  TRUSTED_ORIGINS: ["sheet-auth"],
  OTEL_EXPORTER_OTLP_ENDPOINT: ["sheet-auth", "sheet-db-server", "sheet-workflows"],
  DEV_SHEET_AUTH_PORT: ["sheet-auth"],
  DEV_SHEET_DB_SERVER_PORT: ["sheet-db-server"],
  DEV_PROMETHEUS_PORT: ["sheet-auth", "sheet-db-server", "sheet-workflows"],
  DEV_LOCAL_JWKS_PORT: ["sheet-auth"],
  POD_NAMESPACE: ["sheet-workflows"],
  DEV_SHEET_WORKFLOWS_PORT: ["sheet-workflows"],
  DEV_WORKFLOWS_RUNNER_PORT: ["sheet-workflows"],
  SHEET_WORKFLOWS_ROLE: ["sheet-workflows"],
  SHEET_AUTH_OAUTH_CLIENT_ID: ["sheet-workflows"],
  SHEET_AUTH_OAUTH_CLIENT_SECRET: ["sheet-workflows"],
  SHEET_AUTH_WORKFLOW_HTTP_AUDIENCE: ["sheet-workflows"],
  SHEET_AUTH_WORKFLOW_HTTP_BROWSER_AUDIENCE: ["sheet-workflows"],
  SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID: ["sheet-workflows"],
  SHEET_WEB_BASE_URL: ["sheet-workflows"],
  SHEET_AUTH_TRUSTED_DELEGATION_CLIENT_IDS: ["sheet-workflows"],
  SHEET_AUTO_CHECKIN_SERVICE_ID: ["sheet-workflows"],
  SHEET_AUTO_CHECKIN_OAUTH_CLIENT_ID: ["sheet-workflows"],
  WORKFLOWS_RUNNER_HOST: ["sheet-workflows"],
  WORKFLOWS_RUNNER_PORT: ["sheet-workflows"],
  WORKFLOWS_RUNNER_LISTEN_HOST: ["sheet-workflows"],
  WORKFLOWS_RUNNER_LISTEN_PORT: ["sheet-workflows"],
};

const isFastHostKeyOwnedBySelection = (key: string, selectedServices: readonly string[]) =>
  fastHostEnvironmentKeyOwners[key]?.some((service) => selectedServices.includes(service)) ?? false;

const composeEnvironmentKeys = [
  "COOKIE_DOMAIN",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_TOKEN",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "POSTGRES_PASSWORD",
  "POSTGRES_PORT",
  "REDIS_PASSWORD",
  "SHEET_AUTH_PUBLIC_BASE_URL",
  "SHEET_BOT_CAPABILITY_ENCRYPTION_SECRET",
  "SHEET_BOT_OAUTH_CLIENT_ID",
  "SHEET_BOT_OAUTH_CLIENT_SECRET",
  "SHEET_WEB_BASE_URL",
  "SHEET_WEB_OAUTH_CLIENT_ID",
  "SHEET_WEB_OAUTH_REDIRECT_PATH",
  "SHEET_WEB_OAUTH_SCOPES",
  "SHEET_WEB_PUBLIC_BASE_URL",
  "SHEET_WORKFLOWS_OAUTH_CLIENT_ID",
  "SHEET_WORKFLOWS_OAUTH_CLIENT_SECRET",
  "SHEET_WORKFLOWS_PUBLIC_BASE_URL",
  "SHEET_WORKFLOWS_ROLE",
  "SHEET_ZERO_PUBLIC_BASE_URL",
  "TRUSTED_OAUTH_CLIENT_IDS",
  "TRUSTED_OAUTH_CLIENTS_JSON",
  "TRUSTED_ORIGINS",
  "ZERO_ADMIN_PASSWORD",
] as const;

const kubernetesEnvironmentKeys = [
  "DEV_IMAGE_REGISTRY",
  "KUBE_CONTEXT",
  "KUBECONFIG",
  "KUBE_NAMESPACE",
  "KUBE_RELEASE",
] as const;

export const COMPOSE_ENVIRONMENT_KEYS = composeEnvironmentKeys;
export const KUBERNETES_ENVIRONMENT_KEYS = kubernetesEnvironmentKeys;

const allModeEnvironmentKeys = new Set<string>([
  ...FAST_ENVIRONMENT_KEYS,
  ...fastHostEnvironmentKeys,
  ...composeEnvironmentKeys,
  ...kubernetesEnvironmentKeys,
]);

const ambientModeMixingKeys = new Set<string>([
  ...FAST_ENVIRONMENT_KEYS,
  ...composeEnvironmentKeys,
]);

const secretEnvironmentKeys = new Set([
  "DISCORD_CLIENT_SECRET",
  "DISCORD_TOKEN",
  "POSTGRES_PASSWORD",
  "REDIS_PASSWORD",
  "SHEET_AUTH_OAUTH_CLIENT_SECRET",
  "SHEET_BOT_CAPABILITY_ENCRYPTION_SECRET",
  "SHEET_BOT_OAUTH_CLIENT_SECRET",
  "SHEET_WORKFLOWS_OAUTH_CLIENT_SECRET",
  "TRUSTED_OAUTH_CLIENTS_JSON",
  "ZERO_ADMIN_PASSWORD",
]);

const disallowedEnvironmentKeys = new Set([
  "AWS_SECRET_ACCESS_KEY",
  "DATABASE_URL",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "INFISICAL_TOKEN",
  "POSTGRES_URL",
  "REDIS_URL",
  "SERVICE_ACCOUNT_TOKEN",
  "SERVICE_TOKEN",
  "SHEET_AUTH_OAUTH_CLIENT_SECRET",
]);

const disallowedEnvironmentPatterns = [
  /(?:^|_)(?:DATABASE|POSTGRES|REDIS)(?:_|$)/,
  /(?:^|_)TOKEN(?:_|$)/,
  /(?:^|_)CREDENTIALS?(?:_|$)/,
  /(?:^|_)SECRET(?:_|$)/,
];

const isDisallowedEnvironmentKey = (
  mode: DevelopmentMode,
  key: string,
  selectedServices: readonly string[] = [],
) => {
  const normalizedKey = key.toUpperCase();
  if (
    mode === "fast" &&
    selectedServices.some(
      (service) =>
        service === "sheet-auth" || service === "sheet-db-server" || service === "sheet-workflows",
    ) &&
    fastHostEnvironmentKeys.includes(normalizedKey as (typeof fastHostEnvironmentKeys)[number]) &&
    isFastHostKeyOwnedBySelection(normalizedKey, selectedServices)
  ) {
    return false;
  }
  return (
    disallowedEnvironmentKeys.has(normalizedKey) ||
    (mode === "fast" &&
      disallowedEnvironmentPatterns.some((pattern) => pattern.test(normalizedKey)))
  );
};

export const sensitiveEnvironmentKeys = new Set([
  ...secretEnvironmentKeys,
  ...disallowedEnvironmentKeys,
]);

const modeEnvironmentKeySets: Readonly<Record<DevelopmentMode, ReadonlySet<string>>> = {
  fast: new Set(FAST_ENVIRONMENT_KEYS),
  compose: new Set(composeEnvironmentKeys),
  kubernetes: new Set(kubernetesEnvironmentKeys),
};

type EnvironmentValues = Readonly<Record<string, string>>;

interface EnvironmentFileResult {
  readonly values: EnvironmentValues;
  readonly errors: readonly Diagnostic[];
}

// fallow-ignore-next-line complexity
const stripInlineComment = (value: string) => {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if ((character === '"' || character === "'") && (index === 0 || value[index - 1] !== "\\")) {
      quote = quote === character ? null : (quote ?? character);
    } else if (
      character === "#" &&
      quote === null &&
      index > 0 &&
      /\s/.test(value[index - 1] ?? "")
    ) {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
};

const decodeEnvironmentValue = (value: string) => {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value.at(-1) !== quote) return value;
  const inner = value.slice(1, -1);
  return quote === '"'
    ? inner.replaceAll('\\"', '"').replaceAll("\\\\", "\\")
    : inner.replaceAll("\\'", "'");
};

export interface ConfigInput {
  readonly mode: DevelopmentMode;
  readonly action: ModeAction | null;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly envFile: string | null;
  readonly selectedServices?: readonly string[];
}

export interface FastModeConfig {
  readonly mode: "fast";
  readonly envFile: string | null;
  readonly environment: {
    readonly APP_BASE_URL: string;
    readonly AUTH_BASE_URL: string;
    readonly SHEET_ZERO_BASE_URL: string;
    readonly SHEET_WORKFLOWS_BASE_URL: string;
  };
  readonly urls: readonly PlannedUrl[];
  readonly ports: Readonly<Record<string, number>>;
  readonly servicePorts: Readonly<Record<FastService, number>>;
  readonly serviceEnvironments: Readonly<Record<FastService, Readonly<Record<string, string>>>>;
}

export interface ComposeModeConfig {
  readonly mode: "compose";
  readonly envFile: string | null;
  readonly environment: {
    readonly SHEET_AUTH_PUBLIC_BASE_URL: string;
    readonly SHEET_WEB_PUBLIC_BASE_URL: string;
    readonly SHEET_ZERO_PUBLIC_BASE_URL: string;
    readonly SHEET_WORKFLOWS_PUBLIC_BASE_URL: string;
    readonly TRUSTED_ORIGINS: string;
  };
  readonly projectName: string;
  readonly checkoutState: string;
  readonly urls: readonly PlannedUrl[];
  readonly ports: Readonly<Record<string, number>>;
}

export interface KubernetesModeConfig {
  readonly mode: "kubernetes";
  readonly envFile: string | null;
  readonly environment: {
    readonly KUBE_CONTEXT: string;
    readonly KUBE_NAMESPACE: string;
    readonly KUBE_RELEASE: string;
    readonly DEV_IMAGE_REGISTRY: string;
  };
  readonly urls: readonly PlannedUrl[];
}

export type ModeConfig = FastModeConfig | ComposeModeConfig | KubernetesModeConfig;

export interface ModeConfigValidation {
  readonly config: ModeConfig | null;
  readonly errors: readonly Diagnostic[];
  readonly warnings: readonly Diagnostic[];
}

export interface DoctorConfiguration {
  readonly errors: readonly Diagnostic[];
  readonly warnings: readonly Diagnostic[];
  readonly ports: readonly (readonly [string, number])[];
  readonly configuredModes: readonly DevelopmentMode[];
}

const valueOrDefault = (values: EnvironmentValues, key: string, fallback: string) =>
  values[key] === undefined ? fallback : values[key];

const parsePort = (
  mode: DevelopmentMode,
  action: ModeAction | null,
  key: string,
  rawValue: string,
  fallback: number,
) => {
  const value = valuesToPort(rawValue);
  if (value !== null) return { value, error: undefined };
  const numericValue = Number(rawValue);
  return {
    value: fallback,
    error: makeDiagnostic(
      "invalid-port",
      `${key} must be an integer between 1 and 65535`,
      `Set ${key} to a deterministic, unused development port. Random replacement ports are not used.`,
      {
        mode,
        action,
        port: Number.isInteger(numericValue) ? numericValue : null,
      },
    ),
  };
};

function valuesToPort(rawValue: string): number | null {
  if (rawValue === "") return null;
  if (!/^[0-9]+$/.test(rawValue)) return null;
  try {
    return Schema.decodeUnknownSync(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    )(Number(rawValue));
  } catch {
    return null;
  }
}

const safeOriginForDiagnostic = (value: string) => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

// fallow-ignore-next-line complexity
export const readEnvironmentFile = (filePath: string): EnvironmentFileResult => {
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch {
    return {
      values: {},
      errors: [
        makeDiagnostic(
          "env-file-not-found",
          `Cannot read environment file ${filePath}`,
          "Create the file from the checked-in example or pass --env-file with a readable development file.",
        ),
      ],
    };
  }

  const values: Record<string, string> = {};
  const errors: Diagnostic[] = [];
  for (const [lineNumber, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice("export ".length) : line;
    const separator = assignment.indexOf("=");
    if (separator <= 0) {
      errors.push(
        makeDiagnostic(
          "invalid-environment",
          `Environment file ${filePath} has an invalid entry on line ${lineNumber + 1}`,
          "Use KEY=value entries and keep comments on their own lines.",
        ),
      );
      continue;
    }
    const key = assignment.slice(0, separator).trim();
    const rawValue = stripInlineComment(assignment.slice(separator + 1).trim());
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      errors.push(
        makeDiagnostic(
          "invalid-environment",
          `Environment file ${filePath} has an invalid variable name on line ${lineNumber + 1}`,
          "Use shell-compatible variable names such as APP_BASE_URL.",
        ),
      );
      continue;
    }
    if (values[key] !== undefined) {
      errors.push(
        makeDiagnostic(
          "invalid-environment",
          `Environment file ${filePath} defines ${key} more than once`,
          "Keep one value for each launcher variable.",
        ),
      );
      continue;
    }
    values[key] = decodeEnvironmentValue(rawValue);
  }
  return { values, errors };
};

const environmentFilePath = (input: ConfigInput) => {
  if (input.envFile !== null) return path.resolve(input.cwd, input.envFile);
  if (input.mode === "compose" && input.action === "reset") return null;
  if (input.mode === "compose") return path.resolve(input.cwd, "deploy/compose/.env");
  if (input.mode === "fast") return path.resolve(input.cwd, ".env.development.local");
  return null;
};

const loadEnvironment = (input: ConfigInput) => {
  const filePath = environmentFilePath(input);
  const fileIsRequired =
    input.envFile !== null ||
    (input.mode === "compose" && ["up", "build", "seed"].includes(input.action ?? ""));
  const inheritedValues: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env)) {
    if (value !== undefined) inheritedValues[key] = value;
  }
  if (filePath === null) {
    return { values: inheritedValues, errors: [], filePath: null, fileKeys: new Set<string>() };
  }
  if (!existsSync(filePath)) {
    if (!fileIsRequired) {
      return { values: inheritedValues, errors: [], filePath: null, fileKeys: new Set<string>() };
    }
    return {
      values: inheritedValues,
      errors: [
        makeDiagnostic(
          "env-file-not-found",
          `Development environment file ${filePath} is missing`,
          "Run pnpm compose:generate-secrets, then pass --env-file deploy/compose/.env if needed.",
          { mode: input.mode, action: input.action },
        ),
      ],
      filePath: null,
      fileKeys: new Set<string>(),
    };
  }
  const file = readEnvironmentFile(filePath);
  return {
    values: { ...inheritedValues, ...file.values },
    errors: file.errors,
    filePath,
    fileKeys: new Set(Object.keys(file.values)),
  };
};

// fallow-ignore-next-line complexity
const validateEnvironmentKeys = (
  mode: DevelopmentMode,
  action: ModeAction | null,
  values: EnvironmentValues,
  filePath: string | null,
  fileKeys: ReadonlySet<string>,
  selectedServices: readonly string[] = [],
) => {
  const errors: Diagnostic[] = [];
  const allowedKeys =
    mode === "fast" &&
    selectedServices.some(
      (service) =>
        service === "sheet-auth" || service === "sheet-db-server" || service === "sheet-workflows",
    )
      ? new Set([...modeEnvironmentKeySets.fast, ...fastHostEnvironmentKeys])
      : modeEnvironmentKeySets[mode];
  const sourceKeys = new Set(
    Object.keys(values).filter((key) => fileKeys.has(key) || ambientModeMixingKeys.has(key)),
  );

  for (const key of Object.keys(values)) {
    if (!isDisallowedEnvironmentKey(mode, key, selectedServices)) continue;
    errors.push(
      makeDiagnostic(
        "unsafe-credential",
        `${key} is not accepted by the development launcher`,
        "Remove the credential from this command environment and use the mode-owned development credential set.",
        { mode, action },
      ),
    );
  }

  for (const key of Object.keys(values)) {
    if (
      mode === "fast" &&
      fastHostEnvironmentKeys.includes(key as (typeof fastHostEnvironmentKeys)[number]) &&
      !isDisallowedEnvironmentKey(mode, key, selectedServices) &&
      !isFastHostKeyOwnedBySelection(key, selectedServices)
    ) {
      errors.push(
        makeDiagnostic(
          "invalid-environment",
          `${key} is not owned by a selected Fast service`,
          "Select the service that owns this variable or remove it from the Fast environment file.",
          { mode, action },
        ),
      );
    }
  }

  for (const key of sourceKeys) {
    if (isDisallowedEnvironmentKey(mode, key, selectedServices)) continue;
    if (!allModeEnvironmentKeys.has(key)) continue;
    if (allowedKeys.has(key)) continue;
    const code = secretEnvironmentKeys.has(key) ? "unsafe-credential" : "invalid-environment";
    errors.push(
      makeDiagnostic(
        code,
        `${key} is not allowed in ${mode} mode${
          filePath !== null && fileKeys.has(key)
            ? ` in ${filePath}`
            : " and would mix development modes"
        }`,
        `Use only the ${mode} environment variables documented by pnpm dev ${mode} --help.`,
        { mode, action },
      ),
    );
  }

  if (filePath !== null) {
    for (const key of fileKeys) {
      if (isDisallowedEnvironmentKey(mode, key, selectedServices)) continue;
      if (allowedKeys.has(key)) continue;
      if (allModeEnvironmentKeys.has(key)) continue;
      errors.push(
        makeDiagnostic(
          "invalid-environment",
          `${key} is not a launcher environment variable for ${mode} mode`,
          "Remove the variable from the launcher env file and keep backend credentials in the mode that owns them.",
          { mode, action },
        ),
      );
    }
  }
  return errors;
};

const validateOrigin = (
  mode: DevelopmentMode,
  action: ModeAction | null,
  key: string,
  value: string,
  allowedOrigins: readonly string[],
) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return makeDiagnostic(
      "unsafe-origin",
      `${key} must be an allowed development origin`,
      `Set ${key} to one of the documented development URLs.`,
      { mode, action, origin: safeOriginForDiagnostic(value) },
    );
  }
  const isOriginOnly =
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === "";
  if (!isOriginOnly || !allowedOrigins.includes(parsed.origin)) {
    return makeDiagnostic(
      "unsafe-origin",
      `${key} is not an allowed development origin`,
      `Use one of the approved ${mode} origins. Production and mixed-mode URLs are rejected.`,
      { mode, action, origin: parsed.origin },
    );
  }
  return undefined;
};

// fallow-ignore-next-line complexity
const validateFast = (
  input: ConfigInput,
  values: EnvironmentValues,
  filePath: string | null,
): ModeConfigValidation => {
  const errors: Diagnostic[] = [];
  const selectedServices = input.selectedServices ?? ["sheet-web"];
  const parsedPort = parsePort(
    input.mode,
    input.action,
    "DEV_SHEET_WEB_PORT",
    valueOrDefault(values, "DEV_SHEET_WEB_PORT", String(DETERMINISTIC_PORTS["sheet-web"])),
    DETERMINISTIC_PORTS["sheet-web"],
  );
  if (parsedPort.error !== undefined) errors.push(parsedPort.error);
  const servicePorts: Record<FastService, number> = {
    "sheet-web": parsedPort.value,
    "sheet-auth": DETERMINISTIC_PORTS["sheet-auth"],
    "sheet-db-server": DETERMINISTIC_PORTS["sheet-db-server"],
    "sheet-workflows": DETERMINISTIC_PORTS["sheet-workflows"],
  };
  const servicePortKeys = {
    "sheet-auth": "DEV_SHEET_AUTH_PORT",
    "sheet-db-server": "DEV_SHEET_DB_SERVER_PORT",
  } as const;
  for (const service of ["sheet-auth", "sheet-db-server"] as const) {
    const parsed = parsePort(
      input.mode,
      input.action,
      servicePortKeys[service],
      valueOrDefault(values, servicePortKeys[service], String(servicePorts[service])),
      servicePorts[service],
    );
    servicePorts[service] = parsed.value;
    if (parsed.error !== undefined) errors.push(parsed.error);
  }
  const parsedWorkflowsPort = parsePort(
    input.mode,
    input.action,
    "DEV_SHEET_WORKFLOWS_PORT",
    valueOrDefault(
      values,
      "DEV_SHEET_WORKFLOWS_PORT",
      String(DETERMINISTIC_PORTS["sheet-workflows"]),
    ),
    DETERMINISTIC_PORTS["sheet-workflows"],
  );
  servicePorts["sheet-workflows"] = parsedWorkflowsPort.value;
  if (selectedServices.includes("sheet-workflows") && parsedWorkflowsPort.error !== undefined) {
    errors.push(parsedWorkflowsPort.error);
  }
  const parsedPrometheusPort = parsePort(
    input.mode,
    input.action,
    "DEV_PROMETHEUS_PORT",
    valueOrDefault(values, "DEV_PROMETHEUS_PORT", String(DETERMINISTIC_PORTS.prometheus)),
    DETERMINISTIC_PORTS.prometheus,
  );
  if (parsedPrometheusPort.error !== undefined) errors.push(parsedPrometheusPort.error);
  const parsedLocalJwksPort = parsePort(
    input.mode,
    input.action,
    "DEV_LOCAL_JWKS_PORT",
    valueOrDefault(values, "DEV_LOCAL_JWKS_PORT", String(DETERMINISTIC_PORTS["local-jwks"])),
    DETERMINISTIC_PORTS["local-jwks"],
  );
  if (parsedLocalJwksPort.error !== undefined) errors.push(parsedLocalJwksPort.error);
  const portOwners = new Map<number, string>();
  for (const service of fastServices) {
    if (!selectedServices.includes(service)) continue;
    const previous = portOwners.get(servicePorts[service]);
    if (previous !== undefined) {
      errors.push(
        makeDiagnostic(
          "port-collision",
          `Fast assigns port ${servicePorts[service]} to both ${previous} and ${service}`,
          "Choose explicit deterministic service ports that do not collide.",
          {
            mode: input.mode,
            action: input.action,
            dependency: service,
            port: servicePorts[service],
          },
        ),
      );
    } else {
      portOwners.set(servicePorts[service], service);
    }
  }
  const workflowsRole = valueOrDefault(values, "SHEET_WORKFLOWS_ROLE", "api");
  if (
    selectedServices.includes("sheet-workflows") &&
    !["api", "combined"].includes(workflowsRole)
  ) {
    errors.push(
      makeDiagnostic(
        "invalid-environment",
        `SHEET_WORKFLOWS_ROLE=${workflowsRole} is not supported for host-native workflows`,
        "Use SHEET_WORKFLOWS_ROLE=api or SHEET_WORKFLOWS_ROLE=combined. Runner roles stay in Compose or Kubernetes.",
        { mode: input.mode, action: input.action, dependency: "sheet-workflows" },
      ),
    );
  }
  const workflowsRunnerPort = parsePort(
    input.mode,
    input.action,
    "DEV_WORKFLOWS_RUNNER_PORT",
    valueOrDefault(
      values,
      "DEV_WORKFLOWS_RUNNER_PORT",
      valueOrDefault(values, "WORKFLOWS_RUNNER_PORT", "34431"),
    ),
    34431,
  );
  if (selectedServices.includes("sheet-workflows") && workflowsRunnerPort.error !== undefined) {
    errors.push(workflowsRunnerPort.error);
  }
  const workflowsRunnerListenPort =
    workflowsRole === "combined"
      ? parsePort(
          input.mode,
          input.action,
          "WORKFLOWS_RUNNER_LISTEN_PORT",
          valueOrDefault(values, "WORKFLOWS_RUNNER_LISTEN_PORT", String(workflowsRunnerPort.value)),
          34431,
        )
      : { value: 34431, error: undefined };
  if (
    selectedServices.includes("sheet-workflows") &&
    workflowsRunnerListenPort.error !== undefined
  ) {
    errors.push(workflowsRunnerListenPort.error);
  }
  if (selectedServices.includes("sheet-workflows") && workflowsRole === "combined") {
    if (workflowsRunnerPort.value !== workflowsRunnerListenPort.value) {
      errors.push(
        makeDiagnostic(
          "invalid-environment",
          "Combined workflows must use the same runner connection and listener port",
          "Set DEV_WORKFLOWS_RUNNER_PORT and WORKFLOWS_RUNNER_LISTEN_PORT to the same port.",
          { mode: input.mode, action: input.action, dependency: "sheet-workflows runner" },
        ),
      );
    }
    const previous = portOwners.get(workflowsRunnerListenPort.value);
    if (previous !== undefined) {
      errors.push(
        makeDiagnostic(
          "port-collision",
          `Fast assigns port ${workflowsRunnerListenPort.value} to both ${previous} and sheet-workflows runner`,
          "Choose explicit deterministic service and runner ports that do not collide.",
          {
            mode: input.mode,
            action: input.action,
            dependency: "sheet-workflows runner",
            port: workflowsRunnerListenPort.value,
          },
        ),
      );
    } else {
      portOwners.set(workflowsRunnerListenPort.value, "sheet-workflows runner");
    }
  }
  if (
    selectedServices.includes("sheet-auth") ||
    selectedServices.includes("sheet-db-server") ||
    selectedServices.includes("sheet-workflows")
  ) {
    for (const [dependency, port] of [
      ["postgres", DETERMINISTIC_PORTS.postgres],
      ["redis", DETERMINISTIC_PORTS.redis],
      ["local-jwks", parsedLocalJwksPort.value],
      ["prometheus", parsedPrometheusPort.value],
    ] as const) {
      const previous = portOwners.get(port);
      if (previous !== undefined) {
        errors.push(
          makeDiagnostic(
            "port-collision",
            `Fast assigns port ${port} to both ${previous} and ${dependency}`,
            "Choose explicit deterministic service ports that do not collide with local dependencies.",
            { mode: input.mode, action: input.action, dependency, port },
          ),
        );
      } else {
        portOwners.set(port, dependency);
      }
    }
  }
  const environment = {
    APP_BASE_URL: valueOrDefault(values, "APP_BASE_URL", `http://localhost:${parsedPort.value}`),
    AUTH_BASE_URL: valueOrDefault(values, "AUTH_BASE_URL", FAST_ENDPOINTS.auth),
    SHEET_ZERO_BASE_URL: valueOrDefault(values, "SHEET_ZERO_BASE_URL", FAST_ENDPOINTS.zero),
    SHEET_WORKFLOWS_BASE_URL: valueOrDefault(
      values,
      "SHEET_WORKFLOWS_BASE_URL",
      FAST_ENDPOINTS.workflows,
    ),
  };
  const origins: readonly [readonly string[], keyof typeof environment][] = [
    [
      [`http://localhost:${parsedPort.value}`, `http://127.0.0.1:${parsedPort.value}`],
      "APP_BASE_URL",
    ],
    [[FAST_ENDPOINTS.auth], "AUTH_BASE_URL"],
    [[FAST_ENDPOINTS.zero], "SHEET_ZERO_BASE_URL"],
    [[FAST_ENDPOINTS.workflows], "SHEET_WORKFLOWS_BASE_URL"],
  ];
  for (const [allowed, key] of origins) {
    const failure = validateOrigin(input.mode, input.action, key, environment[key], allowed);
    if (failure !== undefined) errors.push(failure);
  }
  const localHost = (port: number) => `http://localhost:${port}`;
  const localJwksUrl = `${localHost(parsedLocalJwksPort.value)}/.well-known/jwks.json`;
  const serviceEnvironments: Record<FastService, Readonly<Record<string, string>>> = {
    "sheet-web": environment,
    "sheet-auth": {
      BASE_URL: valueOrDefault(values, "BASE_URL", localHost(servicePorts["sheet-auth"])),
      TRUSTED_ORIGINS: valueOrDefault(
        values,
        "TRUSTED_ORIGINS",
        `${safeOriginForDiagnostic(environment.APP_BASE_URL) ?? environment.APP_BASE_URL},${localHost(servicePorts["sheet-auth"])}`,
      ),
      POSTGRES_URL: valueOrDefault(
        values,
        "POSTGRES_URL",
        `postgres://tiara@localhost:${DETERMINISTIC_PORTS.postgres}/tiara`,
      ),
      REDIS_URL: valueOrDefault(
        values,
        "REDIS_URL",
        `redis://localhost:${DETERMINISTIC_PORTS.redis}`,
      ),
      REDIS_BASE: valueOrDefault(values, "REDIS_BASE", "auth:"),
      DISCORD_CLIENT_ID: valueOrDefault(values, "DISCORD_CLIENT_ID", ""),
      DISCORD_CLIENT_SECRET: valueOrDefault(values, "DISCORD_CLIENT_SECRET", ""),
      SHEET_AUTH_OAUTH_JWKS_URL: valueOrDefault(values, "SHEET_AUTH_OAUTH_JWKS_URL", localJwksUrl),
      OTEL_EXPORTER_OTLP_ENDPOINT: valueOrDefault(
        values,
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "http://localhost:4318",
      ),
      PROMETHEUS_PORT: String(parsedPrometheusPort.value),
    },
    "sheet-db-server": {
      POSTGRES_URL: valueOrDefault(
        values,
        "POSTGRES_URL",
        `postgres://tiara@localhost:${DETERMINISTIC_PORTS.postgres}/tiara`,
      ),
      SHEET_AUTH_ISSUER: valueOrDefault(
        values,
        "SHEET_AUTH_ISSUER",
        localHost(servicePorts["sheet-auth"]),
      ),
      SHEET_AUTH_OAUTH_AUDIENCE: valueOrDefault(values, "SHEET_AUTH_OAUTH_AUDIENCE", "sheet-zero"),
      OTEL_EXPORTER_OTLP_ENDPOINT: valueOrDefault(
        values,
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "http://localhost:4318",
      ),
      PROMETHEUS_PORT: String(parsedPrometheusPort.value),
    },
    "sheet-workflows": {
      PORT: String(servicePorts["sheet-workflows"]),
      POD_NAMESPACE: valueOrDefault(values, "POD_NAMESPACE", "tiara-local"),
      SHEET_WORKFLOWS_ROLE: workflowsRole,
      SHEET_AUTH_ISSUER: valueOrDefault(
        values,
        "SHEET_AUTH_ISSUER",
        localHost(servicePorts["sheet-auth"]),
      ),
      SHEET_AUTH_OAUTH_CLIENT_ID: valueOrDefault(
        values,
        "SHEET_AUTH_OAUTH_CLIENT_ID",
        "local-workflows",
      ),
      SHEET_AUTH_OAUTH_CLIENT_SECRET: valueOrDefault(values, "SHEET_AUTH_OAUTH_CLIENT_SECRET", ""),
      SHEET_AUTH_OAUTH_AUDIENCE: valueOrDefault(
        values,
        "SHEET_AUTH_OAUTH_AUDIENCE",
        "sheet-workflows",
      ),
      SHEET_AUTH_WORKFLOW_HTTP_AUDIENCE: valueOrDefault(
        values,
        "SHEET_AUTH_WORKFLOW_HTTP_AUDIENCE",
        "sheet-workflows-http",
      ),
      SHEET_AUTH_WORKFLOW_HTTP_BROWSER_AUDIENCE: valueOrDefault(
        values,
        "SHEET_AUTH_WORKFLOW_HTTP_BROWSER_AUDIENCE",
        "sheet-zero",
      ),
      SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID: valueOrDefault(
        values,
        "SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID",
        "local-bot",
      ),
      SHEET_AUTH_TRUSTED_DELEGATION_CLIENT_IDS: valueOrDefault(
        values,
        "SHEET_AUTH_TRUSTED_DELEGATION_CLIENT_IDS",
        "sheet-auto-checkin",
      ),
      SHEET_AUTO_CHECKIN_SERVICE_ID: valueOrDefault(
        values,
        "SHEET_AUTO_CHECKIN_SERVICE_ID",
        "auto-checkin",
      ),
      SHEET_AUTO_CHECKIN_OAUTH_CLIENT_ID: valueOrDefault(
        values,
        "SHEET_AUTO_CHECKIN_OAUTH_CLIENT_ID",
        "sheet-auto-checkin",
      ),
      SHEET_WEB_BASE_URL: valueOrDefault(values, "SHEET_WEB_BASE_URL", environment.APP_BASE_URL),
      POSTGRES_URL: valueOrDefault(
        values,
        "POSTGRES_URL",
        `postgres://tiara@localhost:${DETERMINISTIC_PORTS.postgres}/tiara`,
      ),
      WORKFLOWS_RUNNER_HOST: valueOrDefault(values, "WORKFLOWS_RUNNER_HOST", "localhost"),
      WORKFLOWS_RUNNER_PORT: String(workflowsRunnerPort.value),
      WORKFLOWS_RUNNER_LISTEN_HOST: valueOrDefault(
        values,
        "WORKFLOWS_RUNNER_LISTEN_HOST",
        "127.0.0.1",
      ),
      WORKFLOWS_RUNNER_LISTEN_PORT: String(workflowsRunnerListenPort.value),
      OTEL_EXPORTER_OTLP_ENDPOINT: valueOrDefault(
        values,
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "http://localhost:4318",
      ),
      PROMETHEUS_PORT: String(parsedPrometheusPort.value),
    },
  };
  const localOrigins: readonly [string, string, readonly string[], readonly FastService[]][] = [
    [
      "BASE_URL",
      serviceEnvironments["sheet-auth"].BASE_URL ?? "",
      [localHost(servicePorts["sheet-auth"])],
      ["sheet-auth"],
    ],
    [
      "SHEET_AUTH_ISSUER",
      serviceEnvironments["sheet-db-server"].SHEET_AUTH_ISSUER ?? "",
      [localHost(servicePorts["sheet-auth"])],
      ["sheet-db-server"],
    ],
    [
      "SHEET_AUTH_OAUTH_JWKS_URL",
      serviceEnvironments["sheet-auth"].SHEET_AUTH_OAUTH_JWKS_URL ?? "",
      [localHost(parsedLocalJwksPort.value)],
      ["sheet-auth"],
    ],
    [
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      serviceEnvironments["sheet-auth"].OTEL_EXPORTER_OTLP_ENDPOINT ?? "",
      ["http://localhost:4318"],
      ["sheet-auth", "sheet-db-server", "sheet-workflows"],
    ],
    [
      "SHEET_AUTH_ISSUER",
      serviceEnvironments["sheet-workflows"].SHEET_AUTH_ISSUER ?? "",
      [localHost(servicePorts["sheet-auth"])],
      ["sheet-workflows"],
    ],
    [
      "SHEET_WEB_BASE_URL",
      serviceEnvironments["sheet-workflows"].SHEET_WEB_BASE_URL ?? "",
      [localHost(servicePorts["sheet-web"]), `http://127.0.0.1:${servicePorts["sheet-web"]}`],
      ["sheet-workflows"],
    ],
  ];
  for (const [key, value, allowed, services] of localOrigins) {
    if (!services.some((service) => selectedServices.includes(service))) continue;
    const failure =
      key === "SHEET_AUTH_OAUTH_JWKS_URL"
        ? (() => {
            try {
              const parsed = new URL(value);
              return parsed.origin === allowed[0] && parsed.pathname === "/.well-known/jwks.json"
                ? undefined
                : makeDiagnostic(
                    "unsafe-origin",
                    `${key} is not an allowed local JWKS URL`,
                    "Use the host-reachable local Compose JWKS endpoint.",
                    { mode: input.mode, action: input.action, origin: parsed.origin },
                  );
            } catch {
              return makeDiagnostic(
                "unsafe-origin",
                `${key} is not an allowed local JWKS URL`,
                "Use the host-reachable local Compose JWKS endpoint.",
                { mode: input.mode, action: input.action, origin: safeOriginForDiagnostic(value) },
              );
            }
          })()
        : validateOrigin(input.mode, input.action, key, value, allowed);
    if (failure !== undefined) errors.push(failure);
  }
  if (selectedServices.includes("sheet-workflows")) {
    const runnerHost = serviceEnvironments["sheet-workflows"].WORKFLOWS_RUNNER_HOST ?? "";
    if (runnerHost !== "localhost" && runnerHost !== "127.0.0.1") {
      errors.push(
        makeDiagnostic(
          "unsafe-origin",
          "WORKFLOWS_RUNNER_HOST must be host-reachable",
          "Use WORKFLOWS_RUNNER_HOST=localhost or 127.0.0.1 for the host-native workflow slice.",
          { mode: input.mode, action: input.action, dependency: "sheet-workflows" },
        ),
      );
    }
    const runnerListenHost =
      serviceEnvironments["sheet-workflows"].WORKFLOWS_RUNNER_LISTEN_HOST ?? "";
    if (
      workflowsRole === "combined" &&
      runnerListenHost !== "localhost" &&
      runnerListenHost !== "127.0.0.1"
    ) {
      errors.push(
        makeDiagnostic(
          "unsafe-origin",
          "WORKFLOWS_RUNNER_LISTEN_HOST must be loopback for host-native workflows",
          "Use WORKFLOWS_RUNNER_LISTEN_HOST=127.0.0.1 or localhost. Bind externally only through Compose or Kubernetes configuration.",
          { mode: input.mode, action: input.action, dependency: "sheet-workflows" },
        ),
      );
    }
    const requiredArtifacts = [
      "packages/sheet-zero-api/src/schema.ts",
      "packages/sheet-db-schema/src/migrations.ts",
      "packages/sheet-db-schema/effect-sql-migrations",
    ];
    const missingArtifacts = requiredArtifacts.filter(
      (artifact) => !existsSync(path.join(input.cwd, artifact)),
    );
    if (missingArtifacts.length > 0) {
      errors.push(
        makeDiagnostic(
          "required-dependency-failed",
          `Host-native sheet-workflows requires checked-in Zero artifacts: ${missingArtifacts.join(", ")}`,
          "Run pnpm --filter sheet-db-schema zero:generate and verify pnpm --filter sheet-db-schema schema:check:diff before starting the workflow API.",
          { mode: input.mode, action: input.action, dependency: "Zero schema and migrations" },
        ),
      );
    }
  }
  if (selectedServices.includes("sheet-auth")) {
    for (const origin of (serviceEnvironments["sheet-auth"].TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)) {
      const failure = validateOrigin(input.mode, input.action, "TRUSTED_ORIGINS", origin, [
        safeOriginForDiagnostic(environment.APP_BASE_URL) ?? environment.APP_BASE_URL,
        localHost(servicePorts["sheet-auth"]),
      ]);
      if (failure !== undefined) errors.push(failure);
    }
  }
  const localConnectionKeys = ["POSTGRES_URL", "REDIS_URL"] as const;
  for (const key of localConnectionKeys) {
    if (key === "REDIS_URL" && !selectedServices.includes("sheet-auth")) continue;
    if (
      key === "POSTGRES_URL" &&
      !selectedServices.includes("sheet-auth") &&
      !selectedServices.includes("sheet-db-server") &&
      !selectedServices.includes("sheet-workflows")
    )
      continue;
    const value = values[key] ?? serviceEnvironments["sheet-auth"][key];
    if (
      value === undefined ||
      (!selectedServices.includes("sheet-auth") &&
        !selectedServices.includes("sheet-db-server") &&
        !selectedServices.includes("sheet-workflows"))
    )
      continue;
    try {
      const parsed = new URL(value);
      const expectedProtocol = key === "POSTGRES_URL" ? "postgres:" : "redis:";
      if (
        parsed.protocol !== expectedProtocol ||
        !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
        (parsed.port !== "" &&
          Number(parsed.port) !==
            (key === "POSTGRES_URL" ? DETERMINISTIC_PORTS.postgres : DETERMINISTIC_PORTS.redis))
      )
        throw new Error("not local");
    } catch {
      errors.push(
        makeDiagnostic(
          "unsafe-origin",
          `${key} must point to the local Compose dependency`,
          `Use a host-reachable ${key === "POSTGRES_URL" ? "Postgres" : "Redis"} URL on localhost; Compose-only service DNS names and remote values are rejected.`,
          { mode: input.mode, action: input.action, origin: safeOriginForDiagnostic(value) },
        ),
      );
    }
  }
  for (const [service, requiredKeys] of [
    ["sheet-auth", ["POSTGRES_URL", "REDIS_URL"]],
    ["sheet-db-server", ["POSTGRES_URL"]],
    [
      "sheet-workflows",
      ["POSTGRES_URL", "SHEET_AUTH_OAUTH_CLIENT_ID", "SHEET_AUTH_OAUTH_CLIENT_SECRET"],
    ],
  ] as const) {
    if (!selectedServices.includes(service as FastService)) continue;
    for (const key of requiredKeys) {
      if (values[key]?.trim()) continue;
      errors.push(
        makeDiagnostic(
          "unsafe-credential",
          `${key} is required for host-native ${service}`,
          key === "POSTGRES_URL"
            ? `Set ${key} to a host-reachable local dependency URL before starting ${service}.`
            : `Set ${key} to the dedicated local OAuth credential before starting ${service}.`,
          { mode: input.mode, action: input.action, dependency: service },
        ),
      );
    }
  }
  return {
    config:
      errors.length === 0
        ? {
            mode: "fast",
            envFile: filePath,
            environment,
            urls: [
              { name: "app", url: environment.APP_BASE_URL },
              { name: "auth", url: environment.AUTH_BASE_URL },
              { name: "zero", url: environment.SHEET_ZERO_BASE_URL },
              { name: "workflows", url: environment.SHEET_WORKFLOWS_BASE_URL },
            ],
            ports: servicePorts,
            servicePorts,
            serviceEnvironments,
          }
        : null,
    errors,
    warnings: [],
  };
};

const composeOrigin = (key: string, environment: EnvironmentValues, fallback: string) =>
  valueOrDefault(environment, key, fallback);

const composeCredentials = [
  "POSTGRES_PASSWORD",
  "REDIS_PASSWORD",
  "SHEET_BOT_CAPABILITY_ENCRYPTION_SECRET",
  "SHEET_BOT_OAUTH_CLIENT_ID",
  "SHEET_BOT_OAUTH_CLIENT_SECRET",
  "SHEET_WORKFLOWS_OAUTH_CLIENT_ID",
  "SHEET_WORKFLOWS_OAUTH_CLIENT_SECRET",
] as const;

const composePackages = [
  "sheet-auth",
  "sheet-db-server",
  "sheet-workflows",
  "sheet-web",
  "sheet-bot",
] as const;

const checkoutSlug = (cwd: string) => {
  const slug = path
    .basename(path.resolve(cwd))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  return slug.replace(/^-+|-+$/g, "").slice(0, 32) || "checkout";
};

export const composeProjectName = (cwd: string) => {
  const resolvedPath = path.resolve(cwd);
  const resolved = (() => {
    try {
      return realpathSync(resolvedPath);
    } catch {
      return resolvedPath;
    }
  })();
  const digest = createHash("sha256").update(resolved).digest("hex").slice(0, 10);
  return `tiara-${checkoutSlug(resolved)}-${digest}`.slice(0, 63);
};

const missingComposeArtifacts = (cwd: string, selectedServices: readonly string[]) => {
  if (!existsSync(path.join(cwd, "docker-compose.yml"))) return [];
  return composePackages
    .filter(
      (packageName) =>
        selectedServices.includes(packageName) &&
        existsSync(path.join(cwd, "packages", packageName)),
    )
    .filter((packageName) => !existsSync(path.join(cwd, "packages", packageName, "dist.tar.zst")));
};

// fallow-ignore-next-line complexity
const validateCompose = (
  input: ConfigInput,
  values: EnvironmentValues,
  filePath: string | null,
): ModeConfigValidation => {
  const errors: Diagnostic[] = [];
  const workflowRole = valueOrDefault(values, "SHEET_WORKFLOWS_ROLE", "combined");
  if (
    (input.selectedServices ?? composePackages).some(
      (service) => service === "sheet-workflows" || service === "sheet-bot",
    ) &&
    !["combined", "api", "runner", "browser-runner"].includes(workflowRole)
  ) {
    errors.push(
      makeDiagnostic(
        "invalid-environment",
        `SHEET_WORKFLOWS_ROLE=${workflowRole} is not a supported workflow role`,
        "Use combined, api, runner, or browser-runner for Compose workflow services.",
        { mode: input.mode, action: input.action, dependency: "sheet-workflows" },
      ),
    );
  }
  const parsedPostgresPort = parsePort(
    input.mode,
    input.action,
    "POSTGRES_PORT",
    valueOrDefault(values, "POSTGRES_PORT", String(DETERMINISTIC_PORTS.postgres)),
    DETERMINISTIC_PORTS.postgres,
  );
  if (parsedPostgresPort.error !== undefined) errors.push(parsedPostgresPort.error);
  const ports = {
    "sheet-web": DETERMINISTIC_PORTS["sheet-web"],
    "sheet-auth": DETERMINISTIC_PORTS["sheet-auth"],
    "sheet-workflows": DETERMINISTIC_PORTS["sheet-workflows"],
    "zero-cache": DETERMINISTIC_PORTS["zero-cache"],
    postgres: parsedPostgresPort.value,
    redis: DETERMINISTIC_PORTS.redis,
  };
  const portOwners = new Map<number, string>();
  for (const [owner, port] of Object.entries(ports)) {
    const previousOwner = portOwners.get(port);
    if (previousOwner !== undefined) {
      errors.push(
        makeDiagnostic(
          "port-collision",
          `Compose assigns port ${port} to both ${previousOwner} and ${owner}`,
          "Choose an explicit deterministic port assignment that does not collide.",
          { mode: input.mode, action: input.action, dependency: owner, port },
        ),
      );
    } else {
      portOwners.set(port, owner);
    }
  }
  const environment = {
    SHEET_AUTH_PUBLIC_BASE_URL: composeOrigin(
      "SHEET_AUTH_PUBLIC_BASE_URL",
      values,
      COMPOSE_ENDPOINTS.auth,
    ),
    SHEET_WEB_PUBLIC_BASE_URL: composeOrigin(
      "SHEET_WEB_PUBLIC_BASE_URL",
      values,
      COMPOSE_ENDPOINTS.app,
    ),
    SHEET_ZERO_PUBLIC_BASE_URL: composeOrigin(
      "SHEET_ZERO_PUBLIC_BASE_URL",
      values,
      COMPOSE_ENDPOINTS.zero,
    ),
    SHEET_WORKFLOWS_PUBLIC_BASE_URL: composeOrigin(
      "SHEET_WORKFLOWS_PUBLIC_BASE_URL",
      values,
      COMPOSE_ENDPOINTS.workflows,
    ),
    TRUSTED_ORIGINS: composeOrigin(
      "TRUSTED_ORIGINS",
      values,
      `${COMPOSE_ENDPOINTS.app},${COMPOSE_ENDPOINTS.auth}`,
    ),
  };
  const cookieDomain = valueOrDefault(values, "COOKIE_DOMAIN", "");
  if (cookieDomain !== "" && cookieDomain !== "localhost") {
    errors.push(
      makeDiagnostic(
        "unsafe-origin",
        "COOKIE_DOMAIN is not a local Compose cookie domain",
        "Leave COOKIE_DOMAIN empty or set it to localhost for local development.",
        { mode: input.mode, action: input.action },
      ),
    );
  }
  const otelEndpoint = valueOrDefault(values, "OTEL_EXPORTER_OTLP_ENDPOINT", "");
  if (otelEndpoint !== "") {
    const failure = validateOrigin(
      input.mode,
      input.action,
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      otelEndpoint,
      ["http://localhost:4318", "http://local-otel-sink:4318"],
    );
    if (failure !== undefined) errors.push(failure);
  }
  const origins: readonly [string, string, string][] = [
    ["SHEET_AUTH_PUBLIC_BASE_URL", environment.SHEET_AUTH_PUBLIC_BASE_URL, COMPOSE_ENDPOINTS.auth],
    ["SHEET_WEB_PUBLIC_BASE_URL", environment.SHEET_WEB_PUBLIC_BASE_URL, COMPOSE_ENDPOINTS.app],
    ["SHEET_ZERO_PUBLIC_BASE_URL", environment.SHEET_ZERO_PUBLIC_BASE_URL, COMPOSE_ENDPOINTS.zero],
    [
      "SHEET_WORKFLOWS_PUBLIC_BASE_URL",
      environment.SHEET_WORKFLOWS_PUBLIC_BASE_URL,
      COMPOSE_ENDPOINTS.workflows,
    ],
  ];
  for (const [key, value, expected] of origins) {
    const failure = validateOrigin(input.mode, input.action, key, value, [expected]);
    if (failure !== undefined) errors.push(failure);
  }
  const trustedOrigins = environment.TRUSTED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (trustedOrigins.length === 0) {
    errors.push(
      makeDiagnostic(
        "unsafe-origin",
        "TRUSTED_ORIGINS must contain at least one local development origin",
        "Set TRUSTED_ORIGINS to the local web and auth origins.",
        { mode: input.mode, action: input.action },
      ),
    );
  } else {
    for (const origin of trustedOrigins) {
      const failure = validateOrigin(input.mode, input.action, "TRUSTED_ORIGINS", origin, [
        COMPOSE_ENDPOINTS.app,
        COMPOSE_ENDPOINTS.auth,
      ]);
      if (failure !== undefined) errors.push(failure);
    }
  }
  if (["up", "seed"].includes(input.action ?? "")) {
    for (const key of composeCredentials) {
      if (values[key]?.trim()) continue;
      errors.push(
        makeDiagnostic(
          "unsafe-credential",
          `${key} is required for Compose ${input.action}`,
          "Fill the dedicated local development credential in deploy/compose/.env.",
          { mode: input.mode, action: input.action },
        ),
      );
    }
  }
  if (input.action === "up") {
    const missing = missingComposeArtifacts(input.cwd, input.selectedServices ?? composePackages);
    if (missing.length > 0) {
      errors.push(
        makeDiagnostic(
          "required-dependency-failed",
          `Compose package artifacts are missing: ${missing.join(", ")}`,
          "Run pnpm dev compose build, then retry pnpm dev compose up. Compose never builds implicitly.",
          { mode: input.mode, action: input.action, dependency: "package artifacts" },
        ),
      );
    }
  }
  const projectName = composeProjectName(input.cwd);
  return {
    config:
      errors.length === 0
        ? {
            mode: "compose",
            envFile: filePath,
            projectName,
            checkoutState: `Checkout State ${projectName}`,
            environment,
            urls: [
              { name: "app", url: environment.SHEET_WEB_PUBLIC_BASE_URL },
              { name: "auth", url: environment.SHEET_AUTH_PUBLIC_BASE_URL },
              { name: "zero", url: environment.SHEET_ZERO_PUBLIC_BASE_URL },
              { name: "workflows", url: environment.SHEET_WORKFLOWS_PUBLIC_BASE_URL },
            ],
            ports,
          }
        : null,
    errors,
    warnings: [],
  };
};

// fallow-ignore-next-line complexity
const validateKubernetes = (
  input: ConfigInput,
  values: EnvironmentValues,
  filePath: string | null,
): ModeConfigValidation => {
  const errors: Diagnostic[] = [];
  const context = valueOrDefault(values, "KUBE_CONTEXT", "");
  const namespace = valueOrDefault(values, "KUBE_NAMESPACE", "tiara-stack-dev");
  const release = valueOrDefault(values, "KUBE_RELEASE", "tiara-stack-dev");
  const registry = valueOrDefault(values, "DEV_IMAGE_REGISTRY", DEVELOPMENT_IMAGE_REGISTRY);
  if (input.action === "preview" && context !== "tiara-stack-dev") {
    errors.push(
      makeDiagnostic(
        "invalid-environment",
        "KUBE_CONTEXT must be the approved tiara-stack-dev development context",
        "Set KUBE_CONTEXT=tiara-stack-dev before running a preview. Production contexts are rejected.",
        { mode: input.mode, action: input.action },
      ),
    );
  }
  if (namespace !== "tiara-stack-dev") {
    errors.push(
      makeDiagnostic(
        "invalid-environment",
        `KUBE_NAMESPACE must be tiara-stack-dev, received ${namespace}`,
        "Use the fixed development namespace. Production namespaces are rejected.",
        { mode: input.mode, action: input.action },
      ),
    );
  }
  if (release !== "tiara-stack-dev") {
    errors.push(
      makeDiagnostic(
        "invalid-environment",
        `KUBE_RELEASE must be tiara-stack-dev, received ${release}`,
        "Use the fixed development release name.",
        { mode: input.mode, action: input.action },
      ),
    );
  }
  if (registry !== DEVELOPMENT_IMAGE_REGISTRY) {
    errors.push(
      makeDiagnostic(
        "invalid-environment",
        "DEV_IMAGE_REGISTRY is not the approved development registry",
        `Use ${DEVELOPMENT_IMAGE_REGISTRY} for development previews.`,
        { mode: input.mode, action: input.action },
      ),
    );
  }
  return {
    config:
      errors.length === 0
        ? {
            mode: "kubernetes",
            envFile: filePath,
            environment: {
              KUBE_CONTEXT: context,
              KUBE_NAMESPACE: namespace,
              KUBE_RELEASE: release,
              DEV_IMAGE_REGISTRY: registry,
            },
            urls: [
              { name: "app", url: KUBERNETES_ENDPOINTS.app },
              { name: "auth", url: KUBERNETES_ENDPOINTS.auth },
              { name: "zero", url: KUBERNETES_ENDPOINTS.zero },
              { name: "workflows", url: KUBERNETES_ENDPOINTS.workflows },
            ],
          }
        : null,
    errors,
    warnings: [],
  };
};

export const validateModeConfig = (input: ConfigInput): ModeConfigValidation => {
  const loaded = loadEnvironment(input);
  const keyErrors = validateEnvironmentKeys(
    input.mode,
    input.action,
    loaded.values,
    loaded.filePath,
    loaded.fileKeys,
    input.selectedServices,
  );
  const validated =
    input.mode === "fast"
      ? validateFast(input, loaded.values, loaded.filePath)
      : input.mode === "compose"
        ? validateCompose(input, loaded.values, loaded.filePath)
        : validateKubernetes(input, loaded.values, loaded.filePath);
  const errors = [...loaded.errors, ...keyErrors, ...validated.errors];
  return {
    config: errors.length === 0 ? validated.config : null,
    errors,
    warnings: validated.warnings,
  };
};

export const validateAmbientEnvironment = (
  mode: DevelopmentMode,
  action: ModeAction | null,
  env: NodeJS.ProcessEnv,
  selectedServices: readonly string[] = [],
): readonly Diagnostic[] => {
  // The mode-specific validators receive filtered values. This separate pass
  // keeps ambient disallowed credentials and cross-mode application settings
  // from bypassing the safety check used by the command boundary.
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) values[key] = value;
  }
  return validateEnvironmentKeys(mode, action, values, null, new Set<string>(), selectedServices);
};
