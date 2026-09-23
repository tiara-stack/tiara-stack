import { Schema } from "effect";

export const developmentModes = ["fast", "compose", "kubernetes"] as const;
export type DevelopmentMode = (typeof developmentModes)[number];
export const DevelopmentModeSchema = Schema.Literals(developmentModes);
export const connectedPreviewActions = [
  "plan",
  "doctor",
  "start",
  "status",
  "resume",
  "stop",
  "cleanup",
] as const;
export type ConnectedPreviewAction = (typeof connectedPreviewActions)[number];
export type LauncherMode = DevelopmentMode | "preview";
export const connectedPreviewRoles = [
  "sheet-web",
  "sheet-auth",
  "sheet-db-server",
  "sheet-bot",
  "sheet-workflows-api",
  "sheet-workflows-runner",
  "sheet-workflows-browser-runner",
] as const;
export type ConnectedPreviewRole = (typeof connectedPreviewRoles)[number];
export const connectedPreviewGroups = [
  "application-zero",
  "workflow-execution",
  "auth",
  "bot-storage",
  "search",
] as const;
export type ConnectedPreviewGroup = (typeof connectedPreviewGroups)[number];
export type CompatibilityClassification =
  | "implementation-only"
  | "compatible"
  | "incompatible"
  | "unknown";
export const changedSurfaces = [
  "http",
  "backend-runtime",
  "packaging",
  "environment-contract",
  "secret-contract",
  "database-schema",
  "zero-schema",
  "authentication",
  "workflow-api",
  "workflow-storage",
  "workflow-actions",
  "workflow-runner",
  "browser-runner",
  "chromium",
  "screenshot",
  "browser-credentials",
  "helm",
  "ingress",
  "network-policy",
  "persistence",
  "cross-service",
  "discord",
  "google-sheets",
] as const;
export type ChangedSurface = (typeof changedSurfaces)[number];
export type ParityGateId =
  | "compose-evidence"
  | "api-evidence"
  | "helm-lint"
  | "helm-render"
  | "workload-readiness"
  | "api-smoke"
  | "ordinary-runner-smoke"
  | "workflow-contract-smoke"
  | "browser-runner-smoke"
  | "kubernetes-invariants"
  | "discord-development-check"
  | "google-sheets-development-check";
export interface ParityGate {
  readonly id: ParityGateId;
  readonly status: "required" | "not-affected";
  readonly reason: string;
}

export const fastServices = [
  "sheet-web",
  "sheet-auth",
  "sheet-db-server",
  "sheet-workflows",
  "sheet-bot",
] as const;
export type FastService = (typeof fastServices)[number];

export const composeServices = [
  "sheet-auth",
  "sheet-db-server",
  "sheet-workflows",
  "sheet-web",
  "sheet-bot",
] as const;
export type ComposeService = (typeof composeServices)[number];

export const modeActions = {
  fast: ["up"] as const,
  compose: ["up", "build", "down", "seed", "reset"] as const,
  kubernetes: ["validate", "preview"] as const,
} as const satisfies Readonly<Record<DevelopmentMode, readonly string[]>>;

export type FastAction = (typeof modeActions.fast)[number];
export type ComposeAction = (typeof modeActions.compose)[number];
export type KubernetesAction = (typeof modeActions.kubernetes)[number];
export type ModeAction = FastAction | ComposeAction | KubernetesAction;
export type ReadinessState = "help" | "planned" | "ready" | "completed" | "stopped" | "blocked";
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
  | "context-preparation-failed"
  | "access-failed"
  | "cleanup-failed"
  | "confirmation-required"
  | "invalid-image-tag"
  | "invalid-changed-surface"
  | "preview-incomplete"
  | "invalid-preview-config"
  | "missing-compatibility"
  | "stale-compatibility"
  | "unknown-compatibility"
  | "unsafe-preview-endpoint"
  | "conflicting-preview-endpoint"
  | "unsafe-preview-credential"
  | "required-role-missing"
  | "required-group-missing"
  | "invalid-preview-intent"
  | "prerequisite-unavailable"
  | "not-implemented";

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly kind: DiagnosticKind;
  readonly message: string;
  readonly mode: LauncherMode | "all" | null;
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
  readonly schemaVersion: 3;
  readonly ok: boolean;
  readonly command: string;
  readonly mode: LauncherMode | "all" | null;
  readonly action: string | null;
  readonly selectedServices: readonly string[];
  readonly checkoutState: string | null;
  readonly plannedProcesses: readonly PlannedProcess[];
  readonly urls: readonly PlannedUrl[];
  readonly readiness: ReadinessState;
  readonly warnings: readonly Diagnostic[];
  readonly errors: readonly Diagnostic[];
  readonly changedSurfaces: readonly ChangedSurface[];
  readonly parityGates: readonly ParityGate[];
  readonly connectedPreview?: ConnectedPreviewReport;
}

export interface ConnectedPreviewPrerequisite {
  readonly id: string;
  readonly status: "unavailable";
  readonly reason: string;
}

export interface ConnectedPreviewReport {
  readonly status: "planned" | "blocked" | "unavailable";
  readonly configSchemaVersion: 1;
  readonly catalog: { readonly version: number; readonly digest: string };
  readonly environment: string;
  readonly profile: string;
  readonly owner: string;
  readonly identities: {
    readonly sourceRevision: string;
    readonly artifactDigests: Readonly<Partial<Record<ConnectedPreviewRole, string>>>;
    readonly deployedManifestDigest: string;
  };
  readonly environmentFileInputs: readonly {
    readonly role: ConnectedPreviewRole;
    readonly path: string;
    readonly digest: string | null;
    readonly keys: readonly string[];
    readonly status: "declared" | "unavailable";
  }[];
  readonly selectedRoles: readonly ConnectedPreviewRole[];
  readonly requiredRoles: readonly ConnectedPreviewRole[];
  readonly missingRoles: readonly ConnectedPreviewRole[];
  readonly requiredGroups: readonly {
    readonly id: ConnectedPreviewGroup;
    readonly ownership: "owned" | "reused" | "missing";
  }[];
  readonly roleCatalog: readonly {
    readonly role: ConnectedPreviewRole;
    readonly providedContracts: readonly string[];
    readonly consumedContracts: readonly string[];
    readonly stateGroups: readonly ConnectedPreviewGroup[];
    readonly requiredRoles: readonly ConnectedPreviewRole[];
    readonly externalEffects: readonly string[];
    readonly credentialNames: readonly string[];
    readonly environmentKeys: readonly string[];
  }[];
  readonly groupPlans: readonly {
    readonly id: ConnectedPreviewGroup;
    readonly ownership: "owned" | "reused";
    readonly endpoint?: string;
    readonly stateIdentity?: string;
    readonly deployedManifestDigest?: string;
    readonly allocationProfile?: string;
  }[];
  readonly quotaRequirements: readonly {
    readonly group: ConnectedPreviewGroup;
    readonly ownership: "owned" | "reused" | "missing";
    readonly status: "unavailable";
    readonly resourceDimensions: readonly string[];
    readonly requested: number | null;
    readonly reserved: number | null;
    readonly available: number | null;
    readonly reason: string;
  }[];
  readonly compatibility: readonly {
    readonly role: ConnectedPreviewRole;
    readonly contract: string | null;
    readonly classification: CompatibilityClassification;
    readonly requiredCallers: readonly ConnectedPreviewRole[];
  }[];
  readonly externalEffects: readonly string[];
  readonly externalOwnership: readonly {
    readonly target: string;
    readonly purposes: readonly string[];
    readonly ownership: "declared" | "exclusive";
    readonly status: "unavailable";
    readonly reason: string;
  }[];
  readonly credentialReferences: readonly {
    readonly role: ConnectedPreviewRole;
    readonly names: readonly string[];
    readonly status: "declared" | "unavailable";
  }[];
  readonly declaredIntent: {
    readonly sharedExecution: "disabled" | "producer-only";
    readonly seed: string | null;
    readonly additionalUserGrants: readonly string[];
    readonly triggers: readonly { readonly name: string; readonly targets: readonly string[] }[];
    readonly externalTargets: readonly string[];
    readonly botHandoff: {
      readonly targetAllocation: string;
      readonly acknowledgedSharedInterruption: boolean;
    } | null;
  };
  readonly prerequisites: readonly ConnectedPreviewPrerequisite[];
  readonly effects: {
    readonly allocations: false;
    readonly migrations: false;
    readonly registrations: false;
    readonly externalEffects: false;
    readonly botHandoffs: false;
  };
  readonly executionAvailable: false;
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

export type ProcessExecutor = (
  request: ProcessRequest,
  signal?: AbortSignal,
) => Promise<ProcessResult>;

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
export type ReadinessChecker = AccessChecker;
export type TcpAccessChecker = (origin: string, timeoutMs: number) => Promise<AccessCheckResult>;

export interface RunningProcess {
  readonly pid: number | undefined;
  readonly exited: Promise<ProcessResult>;
  readonly kill: () => Promise<void>;
}

export type ProcessStarter = (
  request: ProcessRequest,
  signal?: AbortSignal,
) => Promise<RunningProcess>;

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
