import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "@effect/vitest";
import { migrate, sqliteLayer, withSqlite } from "./client";
import { dedupeKeyForFinding, ReviewRepository } from "./repository";

const makeRepositoryLayer = () => {
  const dir = mkdtempSync(join(tmpdir(), "tiara-review-db."));
  const dbPath = join(dir, "nested", "reviews.sqlite");
  return { dbPath, dir, layer: ReviewRepository.layer(dbPath) };
};

describe("ReviewRepository", () => {
  it.live("withSqlite migrates a fresh database before running the effect", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "tiara-review-db."));
      const dbPath = join(dir, "nested", "reviews.sqlite");
      try {
        const runCount = yield* withSqlite(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`
              insert into review_runs (
                id, repo_root, base_ref, checkpoint_ref, checkpoint_commit,
                diff_hash, diff_stat_json, created_at, status
              ) values (
                'run-1', '/repo', 'HEAD', 'checkpoint', 'checkpoint-commit',
                'hash', '{}', 1, 'running'
              )
            `;
            const rows = yield* sql.unsafe<{ readonly count: number }>(
              `select count(*) as count from review_runs`,
            );
            return rows[0]?.count ?? 0;
          }),
        );
        expect(runCount).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.live("creates schema idempotently and loads unresolved prior findings for the same repo", () =>
    Effect.gen(function* () {
      const { dir, layer } = makeRepositoryLayer();
      try {
        const findings = yield* Effect.gen(function* () {
          const repository = yield* ReviewRepository;
          yield* repository.run(
            Effect.gen(function* () {
              yield* repository.insertRun({
                id: "run-1",
                repoRoot: "/repo",
                branch: "main",
                headCommit: "head",
                baseRef: "HEAD",
                baseCommit: "head",
                checkpointRef: "checkpoint-1",
                checkpointCommit: "checkpoint-commit-1",
                checkpointCreatedAtMillis: 1_000,
                diffHash: "hash",
                diffStatJson: "{}",
                createdAt: 1,
                status: "completed",
              });
              yield* repository.insertRun({
                id: "run-2",
                repoRoot: "/other",
                branch: "main",
                headCommit: "head",
                baseRef: "HEAD",
                baseCommit: "head",
                checkpointRef: "checkpoint-2",
                checkpointCommit: "checkpoint-commit-2",
                checkpointCreatedAtMillis: 2_000,
                diffHash: "hash",
                diffStatJson: "{}",
                createdAt: 2,
                status: "completed",
              });
              yield* repository.insertRun({
                id: "current-run",
                repoRoot: "/repo",
                branch: "main",
                headCommit: "head",
                baseRef: "HEAD",
                baseCommit: "head",
                checkpointRef: "checkpoint-current",
                checkpointCommit: "checkpoint-commit-current",
                checkpointCreatedAtMillis: 3_000,
                diffHash: "hash",
                diffStatJson: "{}",
                createdAt: 3,
                status: "running",
              });
              yield* repository.insertFindings({
                runId: "run-1",
                agentId: null,
                source: "orchestrator",
                findings: [
                  {
                    id: "finding-open",
                    severity: "medium",
                    type: "logic-bug",
                    location: "a.ts:1",
                    issue: "Open issue",
                    evidence: "evidence",
                    suggestedFix: "fix",
                  },
                  {
                    id: "finding-fixed",
                    severity: "low",
                    type: "maintainability",
                    issue: "Fixed issue",
                    evidence: "evidence",
                    suggestedFix: "fix",
                  },
                ],
              });
              yield* repository.insertFindings({
                runId: "run-1",
                agentId: null,
                source: "specialist",
                findings: [
                  {
                    id: "finding-specialist-draft",
                    severity: "medium",
                    type: "logic-bug",
                    issue: "Draft specialist issue",
                    evidence: "evidence",
                    suggestedFix: "fix",
                  },
                ],
              });
              yield* repository.insertFindings({
                runId: "run-2",
                agentId: null,
                source: "orchestrator",
                findings: [
                  {
                    id: "finding-other",
                    severity: "high",
                    type: "security",
                    issue: "Other repo",
                    evidence: "evidence",
                    suggestedFix: "fix",
                  },
                ],
              });
              yield* repository.insertPriorIssueRechecks({
                runId: "run-1",
                rechecks: [
                  {
                    priorIssue: "Fixed issue",
                    priorFindingId: "finding-fixed",
                    status: "fixed",
                    evidence: "fixed",
                  },
                ],
              });
            }),
          );

          return yield* repository.run(
            repository.loadReviewInputFindings({
              repoRoot: "/repo",
              currentRunId: "current-run",
            }),
          );
        }).pipe(Effect.provide(layer));

        expect(findings.map((finding) => finding.id)).toEqual(["finding-open"]);
        expect(findings[0]?.baseRef).toBe("HEAD");
        expect(findings[0]?.source).toBe("orchestrator");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.live("loads review input findings from orchestrator history and external imports", () =>
    Effect.gen(function* () {
      const { dir, layer } = makeRepositoryLayer();
      try {
        const findings = yield* Effect.gen(function* () {
          const repository = yield* ReviewRepository;
          yield* repository.run(
            Effect.gen(function* () {
              for (const id of ["previous-run", "current-run", "other-running-run", "failed-run"]) {
                yield* repository.insertRun({
                  id,
                  repoRoot: "/repo",
                  branch: "main",
                  headCommit: "head",
                  baseRef: "HEAD",
                  baseCommit: "head",
                  checkpointRef: `${id}-checkpoint`,
                  checkpointCommit: `${id}-checkpoint-commit`,
                  checkpointCreatedAtMillis: 1_000,
                  diffHash: "hash",
                  diffStatJson: "{}",
                  createdAt: 1,
                  status:
                    id === "previous-run"
                      ? "completed"
                      : id === "failed-run"
                        ? "failed"
                        : "running",
                });
              }
              yield* repository.insertRun({
                id: "other-branch-completed-run",
                repoRoot: "/repo",
                branch: "other",
                headCommit: "head",
                baseRef: "HEAD",
                baseCommit: "head",
                checkpointRef: "other-branch-completed-run-checkpoint",
                checkpointCommit: "other-branch-completed-run-checkpoint-commit",
                checkpointCreatedAtMillis: 1_000,
                diffHash: "hash",
                diffStatJson: "{}",
                createdAt: 1,
                status: "completed",
              });
              yield* repository.insertFindings({
                runId: "previous-run",
                agentId: null,
                source: "orchestrator",
                findings: [
                  {
                    id: "previous-orchestrator-open",
                    severity: "medium",
                    type: "security",
                    issue: "Previous orchestrator issue",
                    evidence: "evidence",
                    suggestedFix: "fix",
                  },
                ],
              });
              yield* repository.insertFindings({
                runId: "failed-run",
                agentId: null,
                source: "orchestrator",
                findings: [
                  {
                    id: "failed-orchestrator-excluded",
                    severity: "medium",
                    type: "security",
                    issue: "Failed run orchestrator issue",
                    evidence: "evidence",
                    suggestedFix: "fix",
                  },
                ],
              });
              yield* repository.insertFindings({
                runId: "other-branch-completed-run",
                agentId: null,
                source: "orchestrator",
                findings: [
                  {
                    id: "other-branch-orchestrator-excluded",
                    severity: "medium",
                    type: "security",
                    issue: "Other branch orchestrator issue",
                    evidence: "evidence",
                    suggestedFix: "fix",
                  },
                ],
              });
              yield* repository.insertFindings({
                runId: "current-run",
                agentId: null,
                source: "orchestrator",
                findings: [
                  {
                    id: "current-orchestrator-excluded",
                    severity: "medium",
                    type: "security",
                    issue: "Current orchestrator issue",
                    evidence: "evidence",
                    suggestedFix: "fix",
                  },
                ],
              });
              yield* repository.insertFindings({
                runId: "previous-run",
                agentId: null,
                source: "external-review",
                findings: [
                  {
                    id: "previous-external-open",
                    severity: "low",
                    type: "maintainability",
                    issue: "Previous external issue",
                    evidence: "evidence",
                    suggestedFix: "fix",
                  },
                ],
              });
              yield* repository.insertFindings({
                runId: "other-running-run",
                agentId: null,
                source: "external-review",
                findings: [
                  {
                    id: "other-running-external-excluded",
                    severity: "low",
                    type: "maintainability",
                    issue: "Other running external issue",
                    evidence: "evidence",
                    suggestedFix: "fix",
                  },
                ],
              });
              yield* repository.insertFindings({
                runId: "other-branch-completed-run",
                agentId: null,
                source: "external-review",
                findings: [
                  {
                    id: "other-branch-external-excluded",
                    severity: "low",
                    type: "maintainability",
                    issue: "Other branch external issue",
                    evidence: "evidence",
                    suggestedFix: "fix",
                  },
                ],
              });
              yield* repository.insertFindings({
                runId: "current-run",
                agentId: null,
                source: "external-review",
                findings: [
                  {
                    id: "current-external-open",
                    severity: "medium",
                    type: "logic-bug",
                    issue: "Current external issue",
                    evidence: "evidence",
                    suggestedFix: "fix",
                  },
                  {
                    id: "current-external-fixed",
                    severity: "low",
                    type: "code-quality",
                    issue: "Fixed current external issue",
                    evidence: "evidence",
                    suggestedFix: "fix",
                  },
                ],
              });
              yield* repository.insertFindings({
                runId: "previous-run",
                agentId: null,
                source: "specialist",
                findings: [
                  {
                    id: "specialist-excluded",
                    severity: "high",
                    type: "security",
                    issue: "Specialist draft",
                    evidence: "evidence",
                    suggestedFix: "fix",
                  },
                ],
              });
              yield* repository.insertPriorIssueRechecks({
                runId: "current-run",
                rechecks: [
                  {
                    priorIssue: "Fixed current external issue",
                    priorFindingId: "current-external-fixed",
                    status: "fixed",
                    evidence: "fixed",
                  },
                ],
              });
            }),
          );

          return yield* repository.run(
            repository.loadReviewInputFindings({
              repoRoot: "/repo",
              currentRunId: "current-run",
            }),
          );
        }).pipe(Effect.provide(layer));

        expect(findings.map((finding) => finding.id).sort()).toEqual([
          "current-external-open",
          "previous-external-open",
          "previous-orchestrator-open",
        ]);
        expect(findings.find((finding) => finding.id === "current-external-open")?.source).toBe(
          "external-review",
        );
        expect(
          findings.find((finding) => finding.id === "previous-orchestrator-open")?.source,
        ).toBe("orchestrator");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.live("rolls back batched finding inserts when one row fails", () =>
    Effect.gen(function* () {
      const { dbPath, dir, layer } = makeRepositoryLayer();
      try {
        yield* Effect.gen(function* () {
          const repository = yield* ReviewRepository;
          yield* repository.run(
            repository.insertRun({
              id: "run-1",
              repoRoot: "/repo",
              branch: "main",
              headCommit: "head",
              baseRef: "HEAD",
              baseCommit: "head",
              checkpointRef: "checkpoint-1",
              checkpointCommit: "checkpoint-commit-1",
              checkpointCreatedAtMillis: 1_000,
              diffHash: "hash",
              diffStatJson: "{}",
              createdAt: 1,
              status: "running",
            }),
          );
        }).pipe(Effect.provide(layer));

        const exit770 = yield* Effect.exit(
          Effect.gen(function* () {
            const repository = yield* ReviewRepository;
            yield* repository.run(
              repository.insertFindings({
                runId: "run-1",
                agentId: null,
                source: "orchestrator",
                findings: [
                  {
                    id: "duplicate-finding",
                    severity: "medium",
                    type: "logic-bug",
                    issue: "First insert should roll back",
                    evidence: "evidence",
                    suggestedFix: "fix",
                  },
                  {
                    id: "duplicate-finding",
                    severity: "medium",
                    type: "logic-bug",
                    issue: "Duplicate primary key fails",
                    evidence: "evidence",
                    suggestedFix: "fix",
                  },
                ],
              }),
            );
          }).pipe(Effect.provide(layer)),
        );
        expect(exit770._tag).toBe("Failure");

        const insertedCount = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql.unsafe<{ readonly count: number }>(
            `select count(*) as count from findings where run_id = 'run-1'`,
          );
          return rows[0]?.count;
        }).pipe(Effect.provide(sqliteLayer(dbPath)));

        expect(insertedCount).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.live("preserves agent thread IDs when updateAgent omits codexThreadId", () =>
    Effect.gen(function* () {
      const { dbPath, dir, layer } = makeRepositoryLayer();
      try {
        yield* Effect.gen(function* () {
          const repository = yield* ReviewRepository;
          yield* repository.run(
            Effect.gen(function* () {
              yield* repository.insertRun({
                id: "run-1",
                repoRoot: "/repo",
                branch: "main",
                headCommit: "head",
                baseRef: "HEAD",
                baseCommit: "head",
                checkpointRef: "checkpoint",
                checkpointCommit: "checkpoint-commit",
                checkpointCreatedAtMillis: 1_000,
                diffHash: "hash",
                diffStatJson: "{}",
                createdAt: 1,
                status: "running",
              });
              yield* repository.insertAgent({
                id: "agent-1",
                runId: "run-1",
                aspect: "security",
                codexThreadId: "thread-1",
                status: "running",
                startedAt: 1,
              });
              yield* repository.updateAgent({
                id: "agent-1",
                status: "failed",
                completedAt: 2,
                error: "failed",
              });
              yield* repository.updateAgent({
                id: "agent-1",
                status: "completed",
                codexThreadId: undefined,
                completedAt: 3,
              });
            }),
          );
        }).pipe(Effect.provide(layer));
        const threadId = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql.unsafe<{ readonly codex_thread_id: string | null }>(
            `select codex_thread_id from review_agents where id = 'agent-1'`,
          );
          return rows[0]?.codex_thread_id;
        }).pipe(Effect.provide(sqliteLayer(dbPath)));

        expect(threadId).toBe("thread-1");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.live(
    "dedupes review input findings and lets orchestrator findings supersede current imports",
    () =>
      Effect.gen(function* () {
        const { dbPath, dir, layer } = makeRepositoryLayer();
        try {
          const result = yield* Effect.gen(function* () {
            const repository = yield* ReviewRepository;
            const duplicateFinding = {
              severity: "medium" as const,
              type: "logic-bug" as const,
              location: "a.ts:1",
              issue: "Duplicate issue",
              evidence: "evidence",
              suggestedFix: "fix",
            };
            yield* repository.run(
              Effect.gen(function* () {
                for (const id of ["previous-run", "current-run"]) {
                  yield* repository.insertRun({
                    id,
                    repoRoot: "/repo",
                    branch: "main",
                    headCommit: "head",
                    baseRef: "HEAD",
                    baseCommit: "head",
                    checkpointRef: `${id}-checkpoint`,
                    checkpointCommit: `${id}-checkpoint-commit`,
                    checkpointCreatedAtMillis: 1_000,
                    diffHash: "hash",
                    diffStatJson: "{}",
                    createdAt: 1,
                    status: id === "previous-run" ? "completed" : "running",
                  });
                }
                yield* repository.insertRun({
                  id: "other-branch-run",
                  repoRoot: "/repo",
                  branch: "other",
                  headCommit: "head",
                  baseRef: "HEAD",
                  baseCommit: "head",
                  checkpointRef: "other-branch-run-checkpoint",
                  checkpointCommit: "other-branch-run-checkpoint-commit",
                  checkpointCreatedAtMillis: 1_000,
                  diffHash: "hash",
                  diffStatJson: "{}",
                  createdAt: 1,
                  status: "completed",
                });
                yield* repository.insertFindings({
                  runId: "previous-run",
                  agentId: null,
                  source: "external-review",
                  findings: [{ id: "previous-external-duplicate", ...duplicateFinding }],
                });
                yield* repository.insertFindings({
                  runId: "current-run",
                  agentId: null,
                  source: "external-review",
                  findings: [{ id: "current-external-duplicate", ...duplicateFinding }],
                });
                yield* repository.insertFindings({
                  runId: "previous-run",
                  agentId: null,
                  source: "orchestrator",
                  findings: [{ id: "previous-orchestrator-duplicate", ...duplicateFinding }],
                });
                yield* repository.insertFindings({
                  runId: "other-branch-run",
                  agentId: null,
                  source: "orchestrator",
                  findings: [{ id: "other-branch-duplicate", ...duplicateFinding }],
                });
              }),
            );

            const before = yield* repository.run(
              repository.loadReviewInputFindings({
                repoRoot: "/repo",
                currentRunId: "current-run",
              }),
            );
            yield* repository.run(
              repository.markSupersededByDedupeKeys(
                [dedupeKeyForFinding(duplicateFinding)],
                "current-run",
              ),
            );
            const after = yield* repository.run(
              repository.loadReviewInputFindings({
                repoRoot: "/repo",
                currentRunId: "current-run",
              }),
            );
            return { before, after };
          }).pipe(Effect.provide(layer));
          const otherBranchStatus = yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql.unsafe<{ readonly status: string }>(
              `select status from findings where id = 'other-branch-duplicate'`,
            );
            return rows[0]?.status;
          }).pipe(Effect.provide(sqliteLayer(dbPath)));

          expect(result.before.map((finding) => finding.id)).toEqual([
            "previous-orchestrator-duplicate",
          ]);
          expect(result.after).toEqual([]);
          expect(otherBranchStatus).toBe("open");
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }),
  );

  it.live("marks hidden external-review duplicates fixed when the visible prior is fixed", () =>
    Effect.gen(function* () {
      const { dir, layer } = makeRepositoryLayer();
      try {
        const findings = yield* Effect.gen(function* () {
          const repository = yield* ReviewRepository;
          const duplicateFinding = {
            severity: "medium" as const,
            type: "logic-bug" as const,
            location: "a.ts:1",
            issue: "Duplicate issue",
            evidence: "evidence",
            suggestedFix: "fix",
          };
          yield* repository.run(
            Effect.gen(function* () {
              for (const id of ["previous-run", "current-run"]) {
                yield* repository.insertRun({
                  id,
                  repoRoot: "/repo",
                  branch: "main",
                  headCommit: "head",
                  baseRef: "HEAD",
                  baseCommit: "head",
                  checkpointRef: `${id}-checkpoint`,
                  checkpointCommit: `${id}-checkpoint-commit`,
                  checkpointCreatedAtMillis: 1_000,
                  diffHash: "hash",
                  diffStatJson: "{}",
                  createdAt: 1,
                  status: id === "previous-run" ? "completed" : "running",
                });
              }
              yield* repository.insertFindings({
                runId: "current-run",
                agentId: null,
                source: "external-review",
                findings: [{ id: "current-external-duplicate", ...duplicateFinding }],
              });
              yield* repository.insertFindings({
                runId: "previous-run",
                agentId: null,
                source: "external-review",
                findings: [{ id: "previous-external-duplicate", ...duplicateFinding }],
              });
              yield* repository.insertFindings({
                runId: "previous-run",
                agentId: null,
                source: "orchestrator",
                findings: [{ id: "previous-orchestrator-duplicate", ...duplicateFinding }],
              });
              yield* repository.insertPriorIssueRechecks({
                runId: "current-run",
                rechecks: [
                  {
                    priorIssue: "Duplicate issue",
                    priorFindingId: "previous-orchestrator-duplicate",
                    status: "fixed",
                    evidence: "fixed",
                  },
                ],
              });
            }),
          );
          const currentRunFindings = yield* repository.run(
            repository.loadReviewInputFindings({
              repoRoot: "/repo",
              currentRunId: "current-run",
            }),
          );
          const laterRunFindings = yield* repository.run(
            repository.loadReviewInputFindings({
              repoRoot: "/repo",
              currentRunId: "later-run",
            }),
          );
          return { currentRunFindings, laterRunFindings };
        }).pipe(Effect.provide(layer));

        expect(findings.currentRunFindings).toEqual([]);
        expect(findings.laterRunFindings).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.live("rolls back orchestrator finalization when completing the run fails", () =>
    Effect.gen(function* () {
      const { dbPath, dir, layer } = makeRepositoryLayer();
      try {
        const duplicateFinding = {
          severity: "medium" as const,
          type: "logic-bug" as const,
          location: "a.ts:1",
          issue: "Duplicate issue",
          evidence: "evidence",
          suggestedFix: "fix",
        };
        yield* Effect.gen(function* () {
          const repository = yield* ReviewRepository;
          yield* repository.run(
            Effect.gen(function* () {
              yield* repository.insertRun({
                id: "previous-run",
                repoRoot: "/repo",
                branch: "main",
                headCommit: "head",
                baseRef: "HEAD",
                baseCommit: "head",
                checkpointRef: "previous-checkpoint",
                checkpointCommit: "previous-checkpoint-commit",
                checkpointCreatedAtMillis: 1_000,
                diffHash: "hash",
                diffStatJson: "{}",
                createdAt: 1,
                status: "completed",
              });
              yield* repository.insertRun({
                id: "current-run",
                repoRoot: "/repo",
                branch: "main",
                headCommit: "head",
                baseRef: "HEAD",
                baseCommit: "head",
                checkpointRef: "current-checkpoint",
                checkpointCommit: "current-checkpoint-commit",
                checkpointCreatedAtMillis: 2_000,
                diffHash: "hash",
                diffStatJson: "{}",
                createdAt: 2,
                status: "running",
              });
              yield* repository.insertAgent({
                id: "orchestrator-agent",
                runId: "current-run",
                aspect: "orchestrator",
                status: "running",
                startedAt: 1,
              });
              yield* repository.insertFindings({
                runId: "previous-run",
                agentId: null,
                source: "orchestrator",
                findings: [{ id: "previous-finding", ...duplicateFinding }],
              });
            }),
          );
        }).pipe(Effect.provide(layer));
        yield* withSqlite(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.unsafe(
              `create trigger fail_current_run_completion
               before update of status on review_runs
               when new.id = 'current-run' and new.status = 'completed'
               begin
                 select raise(ABORT, 'completion failed');
               end`,
            );
          }),
        );
        const exit2679 = yield* Effect.exit(
          Effect.gen(function* () {
            const repository = yield* ReviewRepository;
            yield* repository.run(
              repository.completeOrchestratorRun({
                runId: "current-run",
                agentId: "orchestrator-agent",
                threadId: "thread-orchestrator",
                findings: [{ id: "current-finding", ...duplicateFinding }],
                rechecks: [
                  {
                    priorIssue: "Duplicate issue",
                    priorFindingId: "previous-finding",
                    status: "fixed",
                    evidence: "fixed",
                  },
                ],
                completedAt: 3,
                safetyConfidence: 5,
                reportMarkdown: "report",
                reportJson: "{}",
              }),
            );
          }).pipe(Effect.provide(layer)),
        );
        expect(exit2679._tag).toBe("Failure");

        const rows = yield* withSqlite(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const prior = yield* sql.unsafe<{ readonly status: string }>(
              `select status from findings where id = 'previous-finding'`,
            );
            const current = yield* sql.unsafe<{ readonly count: number }>(
              `select count(*) as count from findings where id = 'current-finding'`,
            );
            const rechecks = yield* sql.unsafe<{ readonly count: number }>(
              `select count(*) as count from prior_issue_rechecks where run_id = 'current-run'`,
            );
            const run = yield* sql.unsafe<{ readonly status: string }>(
              `select status from review_runs where id = 'current-run'`,
            );
            const agent = yield* sql.unsafe<{ readonly status: string }>(
              `select status from review_agents where id = 'orchestrator-agent'`,
            );
            return {
              priorStatus: prior[0]?.status,
              currentCount: current[0]?.count,
              recheckCount: rechecks[0]?.count,
              runStatus: run[0]?.status,
              agentStatus: agent[0]?.status,
            };
          }),
        );

        expect(rows).toEqual({
          priorStatus: "open",
          currentCount: 0,
          recheckCount: 0,
          runStatus: "running",
          agentStatus: "running",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.live("links recheck records to matching current-run orchestrator findings", () =>
    Effect.gen(function* () {
      const { dbPath, dir, layer } = makeRepositoryLayer();
      try {
        yield* Effect.gen(function* () {
          const repository = yield* ReviewRepository;
          yield* repository.run(
            Effect.gen(function* () {
              yield* repository.insertRun({
                id: "prior-run",
                repoRoot: "/repo",
                branch: "main",
                headCommit: "head",
                baseRef: "HEAD",
                baseCommit: "head",
                checkpointRef: "checkpoint-prior",
                checkpointCommit: "checkpoint-commit-prior",
                checkpointCreatedAtMillis: 1_000,
                diffHash: "hash",
                diffStatJson: "{}",
                createdAt: 1,
                status: "completed",
              });
              yield* repository.insertRun({
                id: "current-run",
                repoRoot: "/repo",
                branch: "main",
                headCommit: "head",
                baseRef: "HEAD",
                baseCommit: "head",
                checkpointRef: "checkpoint-current",
                checkpointCommit: "checkpoint-commit-current",
                checkpointCreatedAtMillis: 2_000,
                diffHash: "hash",
                diffStatJson: "{}",
                createdAt: 2,
                status: "running",
              });
              yield* repository.insertFindings({
                runId: "prior-run",
                agentId: null,
                source: "orchestrator",
                findings: [
                  {
                    id: "prior-finding",
                    severity: "medium",
                    type: "logic-bug",
                    location: "a.ts:1",
                    issue: "Persisting issue",
                    evidence: "prior evidence",
                    suggestedFix: "prior fix",
                  },
                ],
              });
              yield* repository.insertFindings({
                runId: "current-run",
                agentId: null,
                source: "orchestrator",
                findings: [
                  {
                    id: "current-finding",
                    severity: "medium",
                    type: "logic-bug",
                    location: "a.ts:1",
                    issue: "Persisting issue",
                    evidence: "current evidence",
                    suggestedFix: "current fix",
                  },
                ],
              });
              yield* repository.insertPriorIssueRechecks({
                runId: "current-run",
                rechecks: [
                  {
                    priorIssue: "Persisting issue",
                    priorFindingId: "prior-finding",
                    status: "not-fixed",
                    evidence: "The issue is still present.",
                  },
                ],
              });
            }),
          );
        }).pipe(Effect.provide(layer));

        const recheck = yield* withSqlite(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql.unsafe<{
              readonly finding_id: string | null;
              readonly prior_finding_id: string | null;
            }>(
              `select finding_id, prior_finding_id
               from prior_issue_rechecks
               where run_id = 'current-run'
               limit 1`,
            );
            return rows[0];
          }),
        );

        expect(recheck).toEqual({
          finding_id: "current-finding",
          prior_finding_id: "prior-finding",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.live("persists rechecks with unknown prior finding IDs without violating foreign keys", () =>
    Effect.gen(function* () {
      const { dir, layer } = makeRepositoryLayer();
      try {
        yield* Effect.gen(function* () {
          const repository = yield* ReviewRepository;
          yield* repository.run(
            Effect.gen(function* () {
              yield* repository.insertRun({
                id: "current-run",
                repoRoot: "/repo",
                branch: "main",
                headCommit: "head",
                baseRef: "HEAD",
                baseCommit: "head",
                checkpointRef: "checkpoint",
                checkpointCommit: "checkpoint-commit",
                checkpointCreatedAtMillis: 1_000,
                diffHash: "hash",
                diffStatJson: "{}",
                createdAt: 1,
                status: "running",
              });
              yield* repository.insertPriorIssueRechecks({
                runId: "current-run",
                rechecks: [
                  {
                    priorIssue: "Unknown imported issue",
                    priorFindingId: "missing-finding",
                    status: "unclear",
                    evidence: "The orchestrator referenced an ID that is not in SQLite.",
                  },
                ],
              });
            }),
          );
        }).pipe(Effect.provide(layer));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.live("ignores prior finding IDs from other repos or branches", () =>
    Effect.gen(function* () {
      const { dbPath, dir, layer } = makeRepositoryLayer();
      try {
        yield* Effect.gen(function* () {
          const repository = yield* ReviewRepository;
          yield* repository.run(
            Effect.gen(function* () {
              for (const run of [
                { id: "current-run", repoRoot: "/repo", branch: "main" },
                { id: "other-repo-run", repoRoot: "/other-repo", branch: "main" },
                { id: "other-branch-run", repoRoot: "/repo", branch: "feature" },
              ]) {
                yield* repository.insertRun({
                  id: run.id,
                  repoRoot: run.repoRoot,
                  branch: run.branch,
                  headCommit: "head",
                  baseRef: "HEAD",
                  baseCommit: "head",
                  checkpointRef: `checkpoint-${run.id}`,
                  checkpointCommit: `checkpoint-commit-${run.id}`,
                  checkpointCreatedAtMillis: 1_000,
                  diffHash: "hash",
                  diffStatJson: "{}",
                  createdAt: 1,
                  status: run.id === "current-run" ? "running" : "completed",
                });
              }
              yield* repository.insertFindings({
                runId: "other-repo-run",
                agentId: null,
                source: "orchestrator",
                findings: [
                  {
                    id: "other-repo-finding",
                    severity: "medium",
                    type: "logic-bug",
                    location: "a.ts:1",
                    issue: "Other repo issue",
                    evidence: "evidence",
                    suggestedFix: "fix",
                  },
                ],
              });
              yield* repository.insertFindings({
                runId: "other-branch-run",
                agentId: null,
                source: "orchestrator",
                findings: [
                  {
                    id: "other-branch-finding",
                    severity: "medium",
                    type: "logic-bug",
                    location: "a.ts:1",
                    issue: "Other branch issue",
                    evidence: "evidence",
                    suggestedFix: "fix",
                  },
                ],
              });
              yield* repository.insertPriorIssueRechecks({
                runId: "current-run",
                rechecks: [
                  {
                    priorIssue: "Injected foreign repo issue",
                    priorFindingId: "other-repo-finding",
                    status: "fixed",
                    evidence: "Should not update a different repo.",
                  },
                  {
                    priorIssue: "Injected foreign branch issue",
                    priorFindingId: "other-branch-finding",
                    status: "fixed",
                    evidence: "Should not update a different branch.",
                  },
                ],
              });
            }),
          );
        }).pipe(Effect.provide(layer));

        const rows = yield* withSqlite(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const rechecks = yield* sql.unsafe<{
              readonly prior_finding_id: string | null;
            }>(
              `select prior_finding_id
               from prior_issue_rechecks
               where run_id = 'current-run'
               order by id`,
            );
            const findings = yield* sql.unsafe<{
              readonly id: string;
              readonly status: string;
            }>(
              `select id, status
               from findings
               where id in ('other-repo-finding', 'other-branch-finding')
               order by id`,
            );
            return { rechecks, findings };
          }),
        );

        expect(rows.rechecks).toEqual([{ prior_finding_id: null }, { prior_finding_id: null }]);
        expect(rows.findings).toEqual([
          { id: "other-branch-finding", status: "open" },
          { id: "other-repo-finding", status: "open" },
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.live("loads the latest completed checkpoint for the same repo and branch", () =>
    Effect.gen(function* () {
      const { dir, layer } = makeRepositoryLayer();
      try {
        const checkpoint = yield* Effect.gen(function* () {
          const repository = yield* ReviewRepository;
          yield* repository.run(
            Effect.gen(function* () {
              yield* repository.insertRun({
                id: "running",
                repoRoot: "/repo",
                branch: "main",
                headCommit: "head",
                baseRef: "HEAD",
                baseCommit: "head",
                checkpointRef: "running-ref",
                checkpointCommit: "running-commit",
                checkpointCreatedAtMillis: 3_000,
                diffHash: "hash",
                diffStatJson: "{}",
                createdAt: 3,
                status: "running",
              });
              yield* repository.insertRun({
                id: "older-completed-late",
                repoRoot: "/repo",
                branch: "main",
                headCommit: "head",
                baseRef: "HEAD",
                baseCommit: "head",
                checkpointRef: "older-completed-late-ref",
                checkpointCommit: "older-completed-late-commit",
                checkpointCreatedAtMillis: 2_000,
                diffHash: "hash",
                diffStatJson: "{}",
                createdAt: 1,
                completedAt: 9,
                status: "completed",
              });
              yield* repository.insertRun({
                id: "newer-completed-early",
                repoRoot: "/repo",
                branch: "main",
                headCommit: "head",
                baseRef: "HEAD",
                baseCommit: "head",
                checkpointRef: "newer-completed-early-ref",
                checkpointCommit: "newer-completed-early-commit",
                checkpointCreatedAtMillis: 3_000,
                diffHash: "hash",
                diffStatJson: "{}",
                createdAt: 1,
                completedAt: 7,
                status: "completed",
              });
              yield* repository.insertRun({
                id: "other-branch",
                repoRoot: "/repo",
                branch: "other",
                headCommit: "head",
                baseRef: "HEAD",
                baseCommit: "head",
                checkpointRef: "other-ref",
                checkpointCommit: "other-commit",
                checkpointCreatedAtMillis: 5_000,
                diffHash: "hash",
                diffStatJson: "{}",
                createdAt: 5,
                completedAt: 5,
                status: "completed",
              });
            }),
          );
          return yield* repository.run(repository.loadLatestCompletedCheckpoint("/repo", "main"));
        }).pipe(Effect.provide(layer));

        expect(checkpoint?.checkpointRef).toBe("newer-completed-early-ref");
        expect(checkpoint?.checkpointCommit).toBe("newer-completed-early-commit");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.live("normalizes legacy second-based checkpoint timestamps during migration", () =>
    Effect.gen(function* () {
      const { dbPath, dir, layer } = makeRepositoryLayer();
      try {
        yield* Effect.gen(function* () {
          const repository = yield* ReviewRepository;
          yield* repository.run(
            repository.insertRun({
              id: "legacy-run",
              repoRoot: "/repo",
              branch: "main",
              headCommit: "head",
              baseRef: "HEAD",
              baseCommit: "head",
              checkpointRef: "legacy-ref",
              checkpointCommit: "legacy-commit",
              checkpointCreatedAtMillis: 1_700_000_000_123,
              diffHash: "hash",
              diffStatJson: "{}",
              createdAt: 1_700_000_000,
              completedAt: 1_700_000_001,
              status: "completed",
            }),
          );
        }).pipe(Effect.provide(layer));

        const timestamp = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`update review_runs set checkpoint_created_at = ${1_700_000_000}, created_at = ${1_700_000_005} where id = 'legacy-run'`;
          yield* sql`delete from schema_migrations where id = 'normalize-checkpoint-created-at-v1'`;
          yield* migrate(dbPath);
          yield* migrate(dbPath);
          const rows = yield* sql.unsafe<{ readonly checkpoint_created_at: number }>(
            `select checkpoint_created_at from review_runs where id = 'legacy-run'`,
          );
          return rows[0]?.checkpoint_created_at;
        }).pipe(Effect.provide(sqliteLayer(dbPath)));

        expect(timestamp).toBe(1_700_000_000_000);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );
});
