import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import { makeDiagnostic } from "./diagnostics";
import { type DevelopmentMode, type Diagnostic, type ModeAction, type PlannedUrl } from "./types";

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
  "SHEET_WEB_PUBLIC_BASE_URL",
  "SHEET_WORKFLOWS_OAUTH_CLIENT_ID",
  "SHEET_WORKFLOWS_OAUTH_CLIENT_SECRET",
  "SHEET_WORKFLOWS_PUBLIC_BASE_URL",
  "SHEET_ZERO_PUBLIC_BASE_URL",
  "TRUSTED_OAUTH_CLIENT_IDS",
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

const isDisallowedEnvironmentKey = (mode: DevelopmentMode, key: string) => {
  const normalizedKey = key.toUpperCase();
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

export interface ConfigInput {
  readonly mode: DevelopmentMode;
  readonly action: ModeAction | null;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly envFile: string | null;
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
  readonly ports: Readonly<Record<"sheet-web", number>>;
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
const readEnvironmentFile = (filePath: string): EnvironmentFileResult => {
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
    values[key] =
      rawValue.length >= 2 &&
      ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'")))
        ? rawValue.slice(1, -1)
        : rawValue;
  }
  return { values, errors };
};

const environmentFilePath = (input: ConfigInput) => {
  if (input.envFile !== null) return path.resolve(input.cwd, input.envFile);
  if (input.mode === "compose") return path.resolve(input.cwd, "deploy/compose/.env");
  if (input.mode === "fast") return path.resolve(input.cwd, ".env.development.local");
  return null;
};

const loadEnvironment = (input: ConfigInput) => {
  const filePath = environmentFilePath(input);
  const fileIsRequired =
    input.envFile !== null ||
    (input.mode === "compose" && input.action !== "build" && input.action !== "down");
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
) => {
  const errors: Diagnostic[] = [];
  const allowedKeys = modeEnvironmentKeySets[mode];
  const sourceKeys = new Set(
    Object.keys(values).filter((key) => fileKeys.has(key) || ambientModeMixingKeys.has(key)),
  );

  for (const key of Object.keys(values)) {
    if (!isDisallowedEnvironmentKey(mode, key)) continue;
    errors.push(
      makeDiagnostic(
        "unsafe-credential",
        `${key} is not accepted by the development launcher`,
        "Remove the credential from this command environment and use the mode-owned development credential set.",
        { mode, action },
      ),
    );
  }

  for (const key of sourceKeys) {
    if (isDisallowedEnvironmentKey(mode, key)) continue;
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
      if (isDisallowedEnvironmentKey(mode, key)) continue;
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

const validateFast = (
  input: ConfigInput,
  values: EnvironmentValues,
  filePath: string | null,
): ModeConfigValidation => {
  const errors: Diagnostic[] = [];
  const parsedPort = parsePort(
    input.mode,
    input.action,
    "DEV_SHEET_WEB_PORT",
    valueOrDefault(values, "DEV_SHEET_WEB_PORT", String(DETERMINISTIC_PORTS["sheet-web"])),
    DETERMINISTIC_PORTS["sheet-web"],
  );
  if (parsedPort.error !== undefined) errors.push(parsedPort.error);
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
            ports: { "sheet-web": parsedPort.value },
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

// fallow-ignore-next-line complexity
const validateCompose = (
  input: ConfigInput,
  values: EnvironmentValues,
  filePath: string | null,
): ModeConfigValidation => {
  const errors: Diagnostic[] = [];
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
  if (["up", "seed", "reset"].includes(input.action ?? "")) {
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
  return {
    config:
      errors.length === 0
        ? {
            mode: "compose",
            envFile: filePath,
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
): readonly Diagnostic[] => {
  // The mode-specific validators receive filtered values. This separate pass
  // keeps ambient disallowed credentials and cross-mode application settings
  // from bypassing the safety check used by the command boundary.
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) values[key] = value;
  }
  return validateEnvironmentKeys(mode, action, values, null, new Set<string>());
};
