import * as Data from "effect/Data";

export const reviewAspects = [
  "security",
  "code-quality",
  "logic-bugs",
  "race-conditions",
  "test-flakiness",
  "maintainability",
] as const;

const findingTypes = [
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
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly codexPathOverride?: string | undefined;
  readonly cleanupGraceMs?: number | undefined;
  readonly config?: { readonly [key: string]: JsonConfigValue } | undefined;
};

export type OpenAiReviewProviderConfig = {
  readonly apiKey?: string | undefined;
  readonly apiUrl?: string | undefined;
  readonly organizationId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly config?: { readonly [key: string]: JsonConfigValue } | undefined;
};

export type OpenRouterReviewProviderConfig = {
  readonly apiKey?: string | undefined;
  readonly apiUrl?: string | undefined;
  readonly siteReferrer?: string | undefined;
  readonly siteTitle?: string | undefined;
  readonly config?: { readonly [key: string]: JsonConfigValue } | undefined;
};

export type KimiReviewProviderConfig = {
  readonly executable?: string | undefined;
  readonly env?: Record<string, string> | undefined;
  readonly thinking?: boolean | undefined;
  readonly yoloMode?: boolean | undefined;
  readonly approvalPolicy?: "reject" | "allow-read-only-git" | undefined;
  readonly agentFile?: string | undefined;
  readonly skillsDir?: string | undefined;
  readonly shareDir?: string | undefined;
  readonly cleanupGraceMs?: number | undefined;
  readonly config?: { readonly [key: string]: JsonConfigValue } | undefined;
};

export type ReviewProviderConfig = {
  readonly provider?: AiProvider | undefined;
  readonly model?: string | undefined;
  readonly modelReasoningEffort?: ReasoningEffort | undefined;
  readonly timeoutMs?: number | undefined;
  readonly dbPath?: string | undefined;
  readonly providers?:
    | {
        readonly codex?: CodexReviewProviderConfig | undefined;
        readonly openai?: OpenAiReviewProviderConfig | undefined;
        readonly openrouter?: OpenRouterReviewProviderConfig | undefined;
        readonly kimi?: KimiReviewProviderConfig | undefined;
      }
    | undefined;
};

export type ResolvedReviewProviderConfig = {
  readonly codex?: CodexReviewProviderConfig | undefined;
  readonly openai?: OpenAiReviewProviderConfig | undefined;
  readonly openrouter?: OpenRouterReviewProviderConfig | undefined;
  readonly kimi?: KimiReviewProviderConfig | undefined;
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
  readonly id?: string | undefined;
  readonly severity: Severity;
  readonly type: FindingType;
  readonly location?: string | null | undefined;
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
  readonly dbPath?: string | undefined;
  readonly provider?: AiProvider | undefined;
  readonly providerConfig?: ResolvedReviewProviderConfig | undefined;
  readonly model?: string | undefined;
  readonly modelReasoningEffort?: ReasoningEffort | undefined;
  readonly timeoutMs?: number | undefined;
  readonly externalReviewMarkdown?: string | undefined;
  readonly graphMcpCommand?: string | undefined;
  readonly graphMcpArgsPrefix?: ReadonlyArray<string> | undefined;
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
  readonly externalReviewImport?: ExternalReviewImportResult | undefined;
};

export type ReviewAgentRecord = {
  readonly id: string;
  readonly runId: string;
  readonly aspect: AgentAspect;
  readonly codexThreadId?: string | null | undefined;
  readonly status: AgentStatus;
  readonly startedAt: number;
  readonly completedAt?: number | null | undefined;
  readonly error?: string | null | undefined;
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
  readonly completedAt?: number | null | undefined;
  readonly status: RunStatus;
  readonly safetyConfidence?: SafetyConfidence | null | undefined;
  readonly reportMarkdown?: string | null | undefined;
  readonly reportJson?: string | null | undefined;
  readonly error?: string | null | undefined;
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
