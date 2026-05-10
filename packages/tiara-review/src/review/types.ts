import * as Data from "effect/Data";

export const reviewAspects = [
  "security",
  "code-quality",
  "logic-bugs",
  "race-conditions",
  "test-flakiness",
  "maintainability",
] as const;

export const findingTypes = [
  "security",
  "code-quality",
  "logic-bug",
  "race-condition",
  "test-flakiness",
  "maintainability",
] as const;

export type ReviewAspect = (typeof reviewAspects)[number];
export type AgentAspect = ReviewAspect | "orchestrator" | "external-review-parser";
export type FindingType = (typeof findingTypes)[number];
export type Severity = "high" | "medium" | "low";
export type FindingStatus = "open" | "fixed" | "not-fixed" | "unclear" | "superseded";
export type FindingSource = "specialist" | "orchestrator" | "external-review";
export type AgentStatus = "running" | "completed" | "failed" | "timed-out";
export type RunStatus = "running" | "completed" | "failed";
export type SafetyConfidence = 0 | 1 | 2 | 3 | 4 | 5;
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type AiProvider = "codex" | "openai" | "openrouter" | "kimi";

export type JsonConfigValue =
  | null
  | string
  | number
  | boolean
  | ReadonlyArray<JsonConfigValue>
  | { readonly [key: string]: JsonConfigValue };

export type CodexReviewProviderConfig = {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly codexPathOverride?: string;
  readonly cleanupGraceMs?: number;
  readonly config?: { readonly [key: string]: JsonConfigValue };
};

export type OpenAiReviewProviderConfig = {
  readonly apiKey?: string;
  readonly apiUrl?: string;
  readonly organizationId?: string;
  readonly projectId?: string;
  readonly config?: { readonly [key: string]: JsonConfigValue };
};

export type OpenRouterReviewProviderConfig = {
  readonly apiKey?: string;
  readonly apiUrl?: string;
  readonly siteReferrer?: string;
  readonly siteTitle?: string;
  readonly config?: { readonly [key: string]: JsonConfigValue };
};

export type KimiReviewProviderConfig = {
  readonly executable?: string;
  readonly env?: Record<string, string>;
  readonly thinking?: boolean;
  readonly yoloMode?: boolean;
  readonly approvalPolicy?: "reject" | "allow-read-only-git";
  readonly agentFile?: string;
  readonly skillsDir?: string;
  readonly shareDir?: string;
  readonly cleanupGraceMs?: number;
  readonly config?: { readonly [key: string]: JsonConfigValue };
};

export type ReviewProviderConfig = {
  readonly provider?: AiProvider;
  readonly model?: string;
  readonly modelReasoningEffort?: ReasoningEffort;
  readonly timeoutMs?: number;
  readonly dbPath?: string;
  readonly providers?: {
    readonly codex?: CodexReviewProviderConfig;
    readonly openai?: OpenAiReviewProviderConfig;
    readonly openrouter?: OpenRouterReviewProviderConfig;
    readonly kimi?: KimiReviewProviderConfig;
  };
};

export type ResolvedReviewProviderConfig = {
  readonly codex?: CodexReviewProviderConfig;
  readonly openai?: OpenAiReviewProviderConfig;
  readonly openrouter?: OpenRouterReviewProviderConfig;
  readonly kimi?: KimiReviewProviderConfig;
};

export type Checkpoint = {
  readonly checkpointRef: string;
  readonly checkpointCommit: string;
  readonly headCommit: string | null;
  readonly createdAt: number;
  readonly workingDirOnly: true;
};

export type ReviewBase = {
  readonly baseRef: string;
  readonly baseCommit: string | null;
  readonly priorCheckpointRef: string | null;
};

export type DiffInfo = {
  readonly diffText: string;
  readonly diffHash: string;
  readonly changedFiles: ReadonlyArray<string>;
  readonly stat: {
    readonly files: ReadonlyArray<{
      readonly path: string;
      readonly insertions: number;
      readonly deletions: number;
    }>;
    readonly summary: string;
  };
};

export type ReviewFinding = {
  readonly id?: string;
  readonly severity: Severity;
  readonly type: FindingType;
  readonly location?: string | null;
  readonly issue: string;
  readonly evidence: string;
  readonly suggestedFix: string;
};

export type PriorFinding = ReviewFinding & {
  readonly id: string;
  readonly runId: string;
  readonly source: "orchestrator" | "external-review";
  readonly status: FindingStatus;
  readonly baseRef: string;
  readonly checkpointRef: string;
};

export type PriorIssueRecheck = {
  readonly priorIssue: string;
  readonly priorFindingId: string | null;
  readonly status: "fixed" | "not-fixed" | "unclear";
  readonly evidence: string;
};

export type SpecialistReviewOutput = {
  readonly aspect: ReviewAspect;
  readonly findings: ReadonlyArray<ReviewFinding>;
  readonly priorIssuesRechecked: ReadonlyArray<PriorIssueRecheck>;
  readonly contextUsed: {
    readonly baseReviewed: string;
    readonly currentCheckpoint: string;
    readonly extraContextInspected: string;
  };
  readonly markdown: string;
};

export type ConsolidatedReview = {
  readonly baseReviewed: string;
  readonly currentCheckpoint: string;
  readonly safetyConfidence: SafetyConfidence;
  readonly issues: ReadonlyArray<ReviewFinding>;
  readonly priorIssuesRechecked: ReadonlyArray<PriorIssueRecheck>;
  readonly reviewNotes: ReadonlyArray<string>;
};

export type ReviewRunConfig = {
  readonly cwd: string;
  readonly dbPath?: string;
  readonly provider?: AiProvider;
  readonly providerConfig?: ResolvedReviewProviderConfig;
  readonly model?: string;
  readonly modelReasoningEffort?: ReasoningEffort;
  readonly timeoutMs?: number;
  readonly externalReviewMarkdown?: string;
  readonly graphMcpCommand?: string;
  readonly graphMcpArgsPrefix?: ReadonlyArray<string>;
};

export type ExternalReviewImportResult = {
  readonly importedFindingCount: number;
  readonly skippedFindingCount: number;
  readonly warnings: ReadonlyArray<string>;
  readonly codexThreadId: string | null;
};

export type ReviewRunResult = {
  readonly runId: string;
  readonly baseReviewed: string;
  readonly checkpointRef: string;
  readonly checkpointCommit: string;
  readonly safetyConfidence: SafetyConfidence;
  readonly findings: ReadonlyArray<ReviewFinding>;
  readonly reportMarkdown: string;
  readonly failedAspects: ReadonlyArray<ReviewAspect>;
  readonly externalReviewImport?: ExternalReviewImportResult;
};

export type ReviewAgentRecord = {
  readonly id: string;
  readonly runId: string;
  readonly aspect: AgentAspect;
  readonly codexThreadId?: string | null;
  readonly status: AgentStatus;
  readonly startedAt: number;
  readonly completedAt?: number | null;
  readonly error?: string | null;
};

export type ReviewRunRecord = {
  readonly id: string;
  readonly repoRoot: string;
  readonly branch: string | null;
  readonly headCommit: string | null;
  readonly baseRef: string;
  readonly baseCommit: string | null;
  readonly checkpointRef: string;
  readonly checkpointCommit: string;
  readonly checkpointCreatedAtMillis: number;
  readonly diffHash: string;
  readonly diffStatJson: string;
  readonly createdAt: number;
  readonly completedAt?: number | null;
  readonly status: RunStatus;
  readonly safetyConfidence?: SafetyConfidence | null;
  readonly reportMarkdown?: string | null;
  readonly reportJson?: string | null;
  readonly error?: string | null;
};

export class NotGitRepository extends Data.TaggedError("NotGitRepository")<{
  readonly cwd: string;
  readonly message: string;
}> {}

export class GitCommandFailed extends Data.TaggedError("GitCommandFailed")<{
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {}

export class CheckpointFailed extends Data.TaggedError("CheckpointFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class DatabaseOpenFailed extends Data.TaggedError("DatabaseOpenFailed")<{
  readonly dbPath: string;
  readonly cause: unknown;
}> {}

export class DatabaseMigrationFailed extends Data.TaggedError("DatabaseMigrationFailed")<{
  readonly dbPath: string;
  readonly cause: unknown;
}> {}

export class CodexAgentFailed extends Data.TaggedError("CodexAgentFailed")<{
  readonly aspect: AgentAspect;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CodexAgentTimedOut extends Data.TaggedError("CodexAgentTimedOut")<{
  readonly aspect: AgentAspect;
  readonly timeoutMs: number;
}> {}

export class OrchestratorFailed extends Data.TaggedError("OrchestratorFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class InvalidAgentOutput extends Data.TaggedError("InvalidAgentOutput")<{
  readonly aspect: AgentAspect;
  readonly message: string;
  readonly output: string;
}> {}
