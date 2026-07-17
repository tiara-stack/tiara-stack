import { randomUUID, createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlClient } from "effect/unstable/sql";
import {
  type AgentStatus,
  type FindingSource,
  type FindingStatus,
  type PriorFinding,
  type PriorIssueRecheck,
  type ReviewAgentRecord,
  type ReviewFinding,
  type ReviewAspect,
  type ReviewRunRecord,
  type RunStatus,
  type SafetyConfidence,
} from "../review/types";
import { migrate, sqliteLayer, withImmediateTransaction } from "./client";

type FindingRow = {
  readonly id: string;
  readonly run_id: string;
  readonly severity: string;
  readonly type: string;
  readonly location: string | null;
  readonly issue: string;
  readonly evidence: string;
  readonly suggested_fix: string;
  readonly source: string;
  readonly status: string;
  readonly dedupe_key: string;
  readonly base_ref: string;
  readonly checkpoint_ref: string;
};

type CheckpointRunRow = {
  readonly checkpoint_ref: string;
  readonly checkpoint_commit: string;
  readonly head_commit: string | null;
  readonly checkpoint_created_at: number;
};

const nullAwareEqualityPredicate = (left: string, right: string) =>
  `(${left} = ${right} or (${left} is null and ${right} is null))`;

const sameBranchPredicate = (leftAlias: string, rightAlias: string) =>
  nullAwareEqualityPredicate(`${leftAlias}.branch`, `${rightAlias}.branch`);

const sameBranchParameterPredicate = (column: string) => nullAwareEqualityPredicate(column, "?");

export const makeId = () => randomUUID();

export const dedupeKeyForFinding = (finding: ReviewFinding) =>
  createHash("sha256")
    .update([finding.type, finding.location ?? "", finding.issue].join("\0"))
    .digest("hex");

const ReviewRepositoryDbPath = Context.Reference<string>("ReviewRepositoryDbPath", {
  defaultValue: () => ":memory:",
});

const makeReviewRepository = (dbPath: string, sql: SqlClient.SqlClient) => {
  const updateAgentRow = (input: {
    readonly id: string;
    readonly status: AgentStatus;
    readonly codexThreadId?: string | null | undefined;
    readonly completedAt?: number | null;
    readonly error?: string | null;
  }) =>
    Effect.gen(function* () {
      if (input.codexThreadId !== undefined) {
        yield* sql`
          update review_agents
          set status = ${input.status},
              codex_thread_id = ${input.codexThreadId ?? null},
              completed_at = ${input.completedAt ?? null},
              error = ${input.error ?? null}
          where id = ${input.id}
        `;
      } else {
        yield* sql`
          update review_agents
          set status = ${input.status},
              completed_at = ${input.completedAt ?? null},
              error = ${input.error ?? null}
          where id = ${input.id}
        `;
      }
    });

  const completeRunRow = (input: {
    readonly runId: string;
    readonly status: RunStatus;
    readonly completedAt: number;
    readonly safetyConfidence?: SafetyConfidence | null;
    readonly reportMarkdown?: string | null;
    readonly reportJson?: string | null;
    readonly error?: string | null;
  }) =>
    sql`
      update review_runs
      set status = ${input.status},
          completed_at = ${input.completedAt},
          safety_confidence = ${input.safetyConfidence ?? null},
          report_markdown = ${input.reportMarkdown ?? null},
          report_json = ${input.reportJson ?? null},
          error = ${input.error ?? null}
      where id = ${input.runId}
    `;

  const insertFindingRows = (input: {
    readonly runId: string;
    readonly agentId: string | null;
    readonly source: FindingSource;
    readonly findings: ReadonlyArray<ReviewFinding>;
    readonly status?: FindingStatus;
  }) =>
    Effect.gen(function* () {
      const createdAt = Math.floor(Date.now() / 1000);
      const ids: Array<string> = [];
      for (const finding of input.findings) {
        const id = finding.id ?? makeId();
        ids.push(id);
        yield* sql`
          insert into findings (
            id, run_id, agent_id, source, severity, type, location, issue, evidence,
            suggested_fix, status, dedupe_key, created_at
          ) values (
            ${id}, ${input.runId}, ${input.agentId}, ${input.source}, ${finding.severity}, ${finding.type},
            ${finding.location ?? null}, ${finding.issue}, ${finding.evidence}, ${finding.suggestedFix},
            ${input.status ?? "open"}, ${dedupeKeyForFinding(finding)}, ${createdAt}
          )
        `;
      }
      return ids;
    });

  const scopedPriorFindingId = (runId: string, priorFindingId: string | null) =>
    priorFindingId
      ? sql
          .unsafe<{ readonly id: string }>(
            `select prior_finding.id
             from findings prior_finding
             inner join review_runs prior_run on prior_run.id = prior_finding.run_id
             inner join review_runs current_run on current_run.id = ?
             where prior_finding.id = ?
               and prior_run.repo_root = current_run.repo_root
               and ${sameBranchPredicate("prior_run", "current_run")}
             limit 1`,
            [runId, priorFindingId],
          )
          .pipe(Effect.map((rows) => rows[0]?.id ?? null))
      : Effect.succeed(null);

  const currentFindingIdForPrior = (runId: string, priorFindingId: string | null) =>
    priorFindingId
      ? sql
          .unsafe<{ readonly id: string }>(
            `select current_finding.id
             from findings current_finding
             inner join findings prior_finding on prior_finding.id = ?
             where current_finding.run_id = ?
               and current_finding.source = 'orchestrator'
               and current_finding.dedupe_key = prior_finding.dedupe_key
             limit 1`,
            [priorFindingId, runId],
          )
          .pipe(Effect.map((rows) => rows[0]?.id ?? null))
      : Effect.succeed(null);

  const insertPriorIssueRecheckRows = (input: {
    readonly runId: string;
    readonly rechecks: ReadonlyArray<PriorIssueRecheck>;
  }) =>
    Effect.gen(function* () {
      for (const recheck of input.rechecks) {
        const priorFindingId = yield* scopedPriorFindingId(input.runId, recheck.priorFindingId);
        const findingId = yield* currentFindingIdForPrior(input.runId, priorFindingId);
        yield* sql`
          insert into prior_issue_rechecks (
            id, run_id, finding_id, prior_finding_id, status, evidence
          ) values (
            ${makeId()}, ${input.runId}, ${findingId ?? null}, ${priorFindingId ?? null}, ${recheck.status}, ${recheck.evidence}
          )
        `;
        if (priorFindingId) {
          yield* sql`
            update findings
            set status = ${recheck.status}
            where id = ${priorFindingId}
          `;
          if (recheck.status === "fixed") {
            yield* sql.unsafe(
              `update findings
               set status = 'fixed'
               where source = 'external-review'
                 and status in ('open', 'not-fixed', 'unclear')
                 and dedupe_key = (
                   select dedupe_key
                   from findings
                   where id = ?
                 )
                 and run_id in (
                   select external_run.id
                   from review_runs external_run
                   inner join review_runs current_run on current_run.id = ?
                   where external_run.repo_root = current_run.repo_root
                     and (
                       external_run.id = current_run.id
                       or external_run.status = 'completed'
                     )
                     and ${sameBranchPredicate("external_run", "current_run")}
                 )`,
              [priorFindingId, input.runId],
            );
          }
        }
      }
    });

  const markSupersededRows = (dedupeKeys: ReadonlyArray<string>, currentRunId: string) =>
    Effect.gen(function* () {
      for (const dedupeKey of dedupeKeys) {
        yield* sql.unsafe(
          `update findings
           set status = 'superseded'
           where dedupe_key = ?
             and (run_id != ? or source = 'external-review')
             and status in ('open', 'not-fixed', 'unclear')
             and exists (
               select 1
               from review_runs finding_run
               inner join review_runs current_run on current_run.id = ?
               where finding_run.id = findings.run_id
                 and finding_run.repo_root = current_run.repo_root
                 and ${sameBranchPredicate("finding_run", "current_run")}
             )`,
          [dedupeKey, currentRunId, currentRunId],
        );
      }
    });

  return {
    dbPath,
    run: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    insertRun: (runRecord: ReviewRunRecord) =>
      sql`
          insert into review_runs (
            id, repo_root, branch, head_commit, base_ref, base_commit, checkpoint_ref,
            checkpoint_commit, checkpoint_created_at, diff_hash, diff_stat_json, created_at,
            completed_at, status, safety_confidence, report_markdown, report_json, error
          ) values (
            ${runRecord.id}, ${runRecord.repoRoot}, ${runRecord.branch}, ${runRecord.headCommit}, ${runRecord.baseRef}, ${runRecord.baseCommit},
            ${runRecord.checkpointRef}, ${runRecord.checkpointCommit}, ${runRecord.checkpointCreatedAtMillis},
            ${runRecord.diffHash}, ${runRecord.diffStatJson}, ${runRecord.createdAt}, ${runRecord.completedAt ?? null},
            ${runRecord.status}, ${runRecord.safetyConfidence ?? null},
            ${runRecord.reportMarkdown ?? null}, ${runRecord.reportJson ?? null}, ${runRecord.error ?? null}
          )
        `,
    completeRun: (input: {
      readonly runId: string;
      readonly status: RunStatus;
      readonly completedAt: number;
      readonly safetyConfidence?: SafetyConfidence | null;
      readonly reportMarkdown?: string | null;
      readonly reportJson?: string | null;
      readonly error?: string | null;
    }) => completeRunRow(input),
    insertAgent: (agent: ReviewAgentRecord) =>
      sql`
          insert into review_agents (
            id, run_id, aspect, codex_thread_id, status, started_at, completed_at, error
          ) values (
            ${agent.id}, ${agent.runId}, ${agent.aspect}, ${agent.codexThreadId ?? null}, ${agent.status},
            ${agent.startedAt}, ${agent.completedAt ?? null}, ${agent.error ?? null}
          )
        `,
    updateAgent: (input: {
      readonly id: string;
      readonly status: AgentStatus;
      readonly codexThreadId?: string | null | undefined;
      readonly completedAt?: number | null;
      readonly error?: string | null;
    }) => updateAgentRow(input),
    insertFindings: (input: {
      readonly runId: string;
      readonly agentId: string | null;
      readonly source: FindingSource;
      readonly findings: ReadonlyArray<ReviewFinding>;
      readonly status?: FindingStatus;
    }) => withImmediateTransaction(sql, insertFindingRows(input)),
    loadReviewInputFindings: (input: {
      readonly repoRoot: string;
      readonly currentRunId: string;
    }) =>
      Effect.gen(function* () {
        const rows = yield* sql.unsafe<FindingRow>(
          `select
             f.id, f.run_id, f.source, f.severity, f.type, f.location, f.issue, f.evidence,
             f.suggested_fix, f.status, f.dedupe_key, r.base_ref, r.checkpoint_ref
           from findings f
           inner join review_runs r on r.id = f.run_id
           where r.repo_root = ?
             and f.status in ('open', 'not-fixed', 'unclear')
             and (
               (
                 f.source = 'orchestrator'
                 and f.run_id != ?
                 and r.status = 'completed'
                 and exists (
                   select 1
                   from review_runs current_run
                   where current_run.id = ?
                     and ${sameBranchPredicate("r", "current_run")}
                 )
               )
	               or (
	                 f.source = 'external-review'
	                 and (
	                   f.run_id = ?
	                   or (
	                     r.status = 'completed'
	                     and exists (
	                       select 1
	                       from review_runs current_run
	                       where current_run.id = ?
	                         and ${sameBranchPredicate("r", "current_run")}
	                     )
	                   )
	                 )
	               )
	             )
           order by
             case f.source when 'orchestrator' then 0 else 1 end,
             f.created_at desc,
             f.id desc`,
          [
            input.repoRoot,
            input.currentRunId,
            input.currentRunId,
            input.currentRunId,
            input.currentRunId,
          ],
        );
        const findings: Array<PriorFinding> = [];
        const seen = new Set<string>();
        for (const row of rows) {
          if (seen.has(row.dedupe_key)) {
            continue;
          }
          seen.add(row.dedupe_key);
          findings.push({
            id: row.id,
            runId: row.run_id,
            source: row.source as PriorFinding["source"],
            severity: row.severity as PriorFinding["severity"],
            type: row.type as PriorFinding["type"],
            location: row.location,
            issue: row.issue,
            evidence: row.evidence,
            suggestedFix: row.suggested_fix,
            status: row.status as PriorFinding["status"],
            baseRef: row.base_ref,
            checkpointRef: row.checkpoint_ref,
          });
        }
        return findings;
      }),
    loadLatestCompletedCheckpoint: (repoRoot: string, branch: string | null) =>
      Effect.gen(function* () {
        const rows = yield* sql.unsafe<CheckpointRunRow>(
          `select
             checkpoint_ref,
             checkpoint_commit,
             head_commit,
             coalesce(checkpoint_created_at, created_at * 1000) as checkpoint_created_at
	           from review_runs
	           where repo_root = ?
	             and status = 'completed'
	             and ${sameBranchParameterPredicate("branch")}
	           order by coalesce(checkpoint_created_at, created_at * 1000) desc,
                    created_at desc,
                    checkpoint_commit desc,
                    id desc
           limit 1`,
          [repoRoot, branch, branch],
        );
        const row = rows[0];
        return row
          ? {
              checkpointRef: row.checkpoint_ref,
              checkpointCommit: row.checkpoint_commit,
              headCommit: row.head_commit,
              createdAt: row.checkpoint_created_at,
            }
          : null;
      }),
    insertPriorIssueRechecks: (input: {
      readonly runId: string;
      readonly rechecks: ReadonlyArray<PriorIssueRecheck>;
    }) => withImmediateTransaction(sql, insertPriorIssueRecheckRows(input)),
    markSupersededByDedupeKeys: (dedupeKeys: ReadonlyArray<string>, currentRunId: string) => {
      if (dedupeKeys.length === 0) {
        return Effect.void;
      }
      return withImmediateTransaction(sql, markSupersededRows(dedupeKeys, currentRunId));
    },
    completeOrchestratorRun: (input: {
      readonly runId: string;
      readonly agentId: string;
      readonly threadId: string | null;
      readonly findings: ReadonlyArray<ReviewFinding>;
      readonly rechecks: ReadonlyArray<PriorIssueRecheck>;
      readonly completedAt: number;
      readonly safetyConfidence: SafetyConfidence;
      readonly reportMarkdown: string;
      readonly reportJson: string;
    }) =>
      withImmediateTransaction(
        sql,
        Effect.gen(function* () {
          yield* updateAgentRow({
            id: input.agentId,
            status: "completed",
            codexThreadId: input.threadId,
            completedAt: input.completedAt,
            error: null,
          });
          yield* insertFindingRows({
            runId: input.runId,
            agentId: input.agentId,
            source: "orchestrator",
            findings: input.findings,
          });
          yield* insertPriorIssueRecheckRows({
            runId: input.runId,
            rechecks: input.rechecks,
          });
          yield* markSupersededRows(input.findings.map(dedupeKeyForFinding), input.runId);
          yield* completeRunRow({
            runId: input.runId,
            status: "completed",
            completedAt: input.completedAt,
            safetyConfidence: input.safetyConfidence,
            reportMarkdown: input.reportMarkdown,
            reportJson: input.reportJson,
            error: null,
          });
        }),
      ),
  };
};

export class ReviewRepository extends Context.Service<ReviewRepository>()("ReviewRepository", {
  make: Effect.gen(function* () {
    const dbPath = yield* ReviewRepositoryDbPath;
    const sql = yield* SqlClient.SqlClient;
    yield* migrate(dbPath);
    return makeReviewRepository(dbPath, sql);
  }),
}) {
  static layer = (dbPath: string) =>
    Layer.effect(
      ReviewRepository,
      this.make.pipe(Effect.provideService(ReviewRepositoryDbPath, dbPath)),
    ).pipe(Layer.provide(sqliteLayer(dbPath)));
}

export const groupedPriorFindings = (findings: ReadonlyArray<PriorFinding>) =>
  findings.reduce<Record<ReviewAspect, ReadonlyArray<PriorFinding>>>(
    (acc, finding) => {
      const aspect =
        finding.type === "logic-bug"
          ? "logic-bugs"
          : finding.type === "race-condition"
            ? "race-conditions"
            : finding.type;
      acc[aspect] = [...(acc[aspect] ?? []), finding];
      return acc;
    },
    {
      security: [],
      "code-quality": [],
      "logic-bugs": [],
      "race-conditions": [],
      "test-flakiness": [],
      maintainability: [],
    },
  );
