import { Schema } from "effect";

export const developmentModes = ["fast", "compose", "kubernetes"] as const;
export type DevelopmentMode = (typeof developmentModes)[number];
export const DevelopmentModeSchema = Schema.Literals(developmentModes);

export const fastServices = [
  "sheet-web",
  "sheet-auth",
  "sheet-db-server",
  "sheet-workflows",
] as const;
export type FastService = (typeof fastServices)[number];

export const modeActions = {
  fast: ["up"] as const,
  compose: ["up", "build", "down", "seed", "reset"] as const,
  kubernetes: ["validate", "preview"] as const,
} as const satisfies Readonly<Record<DevelopmentMode, readonly string[]>>;

export type FastAction = (typeof modeActions.fast)[number];
export type ComposeAction = (typeof modeActions.compose)[number];
export type KubernetesAction = (typeof modeActions.kubernetes)[number];
export type ModeAction = FastAction | ComposeAction | KubernetesAction;
export type ReadinessState = "help" | "planned" | "ready" | "stopped" | "blocked";
export type DiagnosticKind = "error" | "warning";

export type DiagnosticCode =
  | "invalid-command"
  | "invalid-option"
  | "invalid-mode"
  | "invalid-action"
  | "invalid-service"
  | "invalid-environment"
  | "env-file-not-found"
  | "unsafe-origin"
  | "unsafe-credential"
  | "invalid-port"
  | "port-collision"
  | "required-dependency-failed"
  | "dependency-timeout"
  | "dependency-unavailable"
  | "access-failed"
  | "confirmation-required"
  | "invalid-image-tag"
  | "not-implemented";

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly kind: DiagnosticKind;
  readonly message: string;
  readonly mode: DevelopmentMode | "all" | null;
  readonly action: string | null;
  readonly dependency: string | null;
  readonly origin: string | null;
  readonly port: number | null;
  readonly remediation: string;
}

export interface PlannedProcess {
  readonly id: string;
  readonly packageName: string | null;
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly longLived: boolean;
  readonly readOnly: boolean;
}

export interface PlannedUrl {
  readonly name: string;
  readonly url: string;
}

export interface LauncherOutput {
  readonly schemaVersion: 2;
  readonly ok: boolean;
  readonly command: string;
  readonly mode: DevelopmentMode | "all" | null;
  readonly action: string | null;
  readonly selectedServices: readonly string[];
  readonly checkoutState: string | null;
  readonly plannedProcesses: readonly PlannedProcess[];
  readonly urls: readonly PlannedUrl[];
  readonly readiness: ReadinessState;
  readonly warnings: readonly Diagnostic[];
  readonly errors: readonly Diagnostic[];
}

export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly kind: "dependency-check" | "runtime";
  readonly readOnly: boolean;
  readonly output?: "capture" | "inherit" | "stderr";
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly timedOut?: boolean;
}

export type ProcessExecutor = (request: ProcessRequest) => Promise<ProcessResult>;

export interface PortCheckResult {
  readonly available: boolean;
  readonly status?: "available" | "occupied" | "unavailable" | "unsupported";
  readonly reason?: string;
}

export type PortChecker = (port: number) => Promise<PortCheckResult>;

export interface AccessCheckRequest {
  readonly mode: DevelopmentMode;
  readonly dependency: string;
  readonly origin: string;
  readonly timeoutMs: number;
  readonly optional: boolean;
}

export interface AccessCheckResult {
  readonly reachable: boolean;
  readonly status?: number;
  readonly timedOut?: boolean;
  readonly reason?: string;
}

export type AccessChecker = (request: AccessCheckRequest) => Promise<AccessCheckResult>;

export interface LauncherOptions {
  readonly executor?: ProcessExecutor;
  readonly portChecker?: PortChecker;
  readonly accessChecker?: AccessChecker;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly envFile?: string | null;
  readonly selectedServices?: readonly string[];
}

export interface LauncherResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: LauncherOutput;
}
