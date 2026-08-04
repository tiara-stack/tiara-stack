export type PackageRole = "foundation" | "contract" | "client" | "implementation" | "runtime";

export interface PackageBoundary {
  readonly role: PackageRole;
  readonly allowedSheetDependencies: readonly string[];
  readonly browserEntrypoints?: readonly string[];
}

export type ViolationCode =
  | "browser-entry-unresolved"
  | "browser-server-export"
  | "cross-package-reexport"
  | "deployable-runtime-dependency"
  | "duplicate-exception"
  | "forbidden-sheet-dependency"
  | "gateway-capability-combination"
  | "invalid-exception"
  | "legacy-package-present"
  | "source-analysis-unresolved"
  | "stale-exception"
  | "wildcard-export";

export interface BoundaryViolation {
  readonly code: ViolationCode;
  readonly package: string;
  readonly target?: string;
  readonly path?: string;
  readonly message: string;
}

export interface BoundaryException {
  readonly code: Exclude<
    ViolationCode,
    "duplicate-exception" | "invalid-exception" | "stale-exception"
  >;
  readonly package: string;
  readonly target?: string;
  readonly path?: string;
  readonly reason: string;
  readonly removeWhen: string;
}

export interface BoundaryPolicy {
  readonly packages: Readonly<Record<string, PackageBoundary>>;
  readonly deployableRuntimes: readonly string[];
  readonly gatewayCapabilities: readonly string[];
  readonly legacyPackages: readonly string[];
  readonly exceptions: readonly BoundaryException[];
}

export interface BoundaryAudit {
  readonly violations: readonly BoundaryViolation[];
  readonly suppressed: readonly BoundaryViolation[];
}
