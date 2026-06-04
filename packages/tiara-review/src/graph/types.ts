import * as Data from "effect/Data";

export const dependencyEdgeKinds = [
  "import",
  "export",
  "reference",
  "call",
  "construct",
  "type-reference",
  "extends",
  "implements",
] as const;

export type DependencyEdgeKind = (typeof dependencyEdgeKinds)[number];
export type DependencyGraphMode = "full" | "incremental";
export type DependencyGraphStatus = "running" | "completed" | "failed";

export type DependencyGraphVersion = {
  readonly id: string;
  readonly repoRoot: string;
  readonly branch: string | null;
  readonly checkpointRef: string;
  readonly checkpointCommit: string;
  readonly baseVersionId: string | null;
  readonly diffHash: string;
  readonly mode: DependencyGraphMode;
  readonly status: DependencyGraphStatus;
  readonly createdAt: number;
  readonly completedAt?: number | null;
  readonly leaseExpiresAt?: number | null;
  readonly error?: string | null;
};

export type DependencyGraphFile = {
  readonly fileKey: string;
  readonly repoRoot: string;
  readonly path: string;
  readonly contentHash: string;
  readonly tsconfigPath: string;
};

export type DependencyGraphSymbol = {
  readonly symbolKey: string;
  readonly fileKey: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: string;
  readonly path: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly exported: boolean;
  readonly metadataJson: string;
};

export const dependencyGraphSymbolStableIdentity = (
  symbol: Pick<DependencyGraphSymbol, "path" | "kind" | "name" | "startLine" | "startColumn">,
) =>
  [
    symbol.path,
    symbol.kind,
    symbol.name,
    String(symbol.startLine),
    String(symbol.startColumn),
  ].join("\0");

export type DependencyGraphEdge = {
  readonly edgeKey: string;
  readonly fromSymbolKey: string;
  readonly toSymbolKey: string;
  readonly kind: DependencyEdgeKind;
  readonly sourcePath: string;
  readonly sourceStartLine: number;
  readonly sourceStartColumn: number;
  readonly metadataJson: string;
};

export type ExtractedDependencyGraph = {
  readonly files: ReadonlyArray<DependencyGraphFile>;
  readonly symbols: ReadonlyArray<DependencyGraphSymbol>;
  readonly edges: ReadonlyArray<DependencyGraphEdge>;
};

export type SymbolLookupResult = {
  readonly versionId: string;
  readonly symbols: ReadonlyArray<DependencyGraphSymbol>;
};

export type SymbolDependenciesResult = {
  readonly versionId: string;
  readonly symbol: DependencyGraphSymbol | null;
  readonly edges: ReadonlyArray<DependencyGraphEdge & { readonly target: DependencyGraphSymbol }>;
};

export type SymbolDependentsResult = {
  readonly versionId: string;
  readonly symbol: DependencyGraphSymbol | null;
  readonly edges: ReadonlyArray<DependencyGraphEdge & { readonly source: DependencyGraphSymbol }>;
};

export class DependencyGraphFailed extends Data.TaggedError("DependencyGraphFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class DependencyGraphVersionNotFound extends Data.TaggedError(
  "DependencyGraphVersionNotFound",
)<{
  readonly versionId: string;
}> {}
