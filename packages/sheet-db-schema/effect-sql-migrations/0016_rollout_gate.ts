import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`
    create table "sheet_db_rollout_gate" (
      "gate_key" text primary key not null,
      "contract_identity" text not null,
      "contract_wire_version" text not null,
      "client_platform" text not null,
      "client_id" text not null,
      "workspace_id" text,
      "effective_principal_key" text not null,
      "execution_path" text not null check ("execution_path" in ('legacy', 'replacement')),
      "revision" integer not null check ("revision" > 0),
      "reason" text not null,
      "evidence_url" text not null,
      "changed_by" jsonb not null,
      "updated_at" timestamptz not null
    )
  `).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`
    create index "sheet_db_rollout_gate_contract_client_idx"
      on "sheet_db_rollout_gate" (
        "contract_identity",
        "contract_wire_version",
        "client_platform",
        "client_id"
      )
  `).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`
    create index "sheet_db_rollout_gate_principal_idx"
      on "sheet_db_rollout_gate" ("effective_principal_key")
  `).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`
    -- RolloutGateControl performs bounded retention cleanup using evaluated_at.
    create table "sheet_db_rollout_gate_evaluation" (
      "evaluation_id" text primary key not null,
      "invocation_id" text not null,
      "gate_key" text not null,
      "gate_revision" integer not null,
      "contract_identity" text not null,
      "contract_wire_version" text not null,
      "client_platform" text not null,
      "client_id" text not null,
      "workspace_id" text,
      "effective_principal_key" text not null,
      "execution_path" text not null check ("execution_path" in ('legacy', 'replacement')),
      "matched" boolean not null,
      "reason" text not null,
      "effective_principal" jsonb not null,
      "actor_provenance" jsonb,
      "evaluated_at" timestamptz not null
    )
  `).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`
    create unique index "sheet_db_rollout_gate_evaluation_invocation_idx"
      on "sheet_db_rollout_gate_evaluation" ("invocation_id")
  `).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`
    create index "sheet_db_rollout_gate_evaluation_gate_idx"
      on "sheet_db_rollout_gate_evaluation" ("gate_key", "evaluated_at")
  `).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`
    create table "sheet_db_rollout_gate_decision" (
      "decision_id" text primary key not null,
      "gate_key" text not null,
      "gate_revision" integer not null,
      "contract_identity" text not null,
      "contract_wire_version" text not null,
      "client_platform" text not null,
      "client_id" text not null,
      "workspace_id" text,
      "effective_principal_key" text not null,
      "execution_path" text not null check ("execution_path" in ('legacy', 'replacement')),
      "reason" text not null,
      "evidence_url" text not null,
      "changed_by" jsonb not null,
      "actor_provenance" jsonb,
      "decided_at" timestamptz not null
    )
  `).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`
    create index "sheet_db_rollout_gate_decision_gate_idx"
      on "sheet_db_rollout_gate_decision" ("gate_key", "decided_at")
  `).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`
    create index "sheet_db_rollout_gate_decision_principal_idx"
      on "sheet_db_rollout_gate_decision" ("effective_principal_key")
  `).withoutTransform;
});
