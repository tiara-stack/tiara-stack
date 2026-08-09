import { Schema } from "effect";
import { pg } from "effect-sql-schema";

export const WorkflowRunStatus = Schema.Literals([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export type WorkflowRunStatus = typeof WorkflowRunStatus.Type;

export const WorkflowCommandKind = Schema.Literals(["start", "cancel", "resume", "event"]);

export type WorkflowCommandKind = typeof WorkflowCommandKind.Type;

export const WorkflowCommandStatus = Schema.Literals([
  "pending",
  "delivering",
  "delivered",
  "failed",
  "cancelled",
]);

export type WorkflowCommandStatus = typeof WorkflowCommandStatus.Type;

const createdAt = () =>
  pg.timestamp("created_at", { withTimezone: true }).notNull().generatedByApp();

const updatedAt = () =>
  pg.timestamp("updated_at", { withTimezone: true }).notNull().generatedByApp();

class WorkflowRun extends pg.Class<WorkflowRun>("WorkflowRun")({
  table: "workflow_run",
  fields: {
    runId: pg.text("run_id").primaryKey(),
    workflowName: pg.text("workflow_name").notNull(),
    contractIdentity: pg.text("contract_identity"),
    contractWireVersion: pg.text("contract_wire_version"),
    canonicalInputHash: pg.text("canonical_input_hash"),
    definitionVersion: pg.text("definition_version").notNull(),
    executionId: pg.text("execution_id").notNull(),
    idempotencyKey: pg.text("idempotency_key").notNull(),
    visibilityKey: pg.text("visibility_key").notNull(),
    principal: pg.jsonb("principal"),
    actorProvenance: pg.jsonb("actor_provenance"),
    input: pg.jsonb("input").notNull(),
    status: pg.text("status").notNull().decodeTo(WorkflowRunStatus),
    result: pg.jsonb("result"),
    error: pg.jsonb("error"),
    maxAttempts: pg.integer("max_attempts").notNull(),
    runAfter: pg.timestamp("run_after", { withTimezone: true }).notNull(),
    startedAt: pg.timestamp("started_at", { withTimezone: true }),
    completedAt: pg.timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  indexes: [
    pg.uniqueIndex("workflow_run_workflow_idempotency_idx").on("workflowName", "idempotencyKey"),
    pg
      .index("workflow_run_workflow_owner_submitted_idx")
      .on("workflowName", "visibilityKey", "createdAt", "runId"),
    pg.index("workflow_run_visibility_updated_idx").on("visibilityKey", "updatedAt"),
    pg.index("workflow_run_status_updated_idx").on("status", "updatedAt"),
  ],
}) {}

class WorkflowCommand extends pg.Class<WorkflowCommand>("WorkflowCommand")({
  table: "workflow_command",
  fields: {
    commandId: pg.text("command_id").primaryKey(),
    runId: pg.text("run_id").notNull(),
    kind: pg.text("kind").notNull().decodeTo(WorkflowCommandKind),
    payload: pg.jsonb("payload").notNull(),
    status: pg.text("status").notNull().decodeTo(WorkflowCommandStatus),
    attempts: pg.integer("attempts").notNull(),
    availableAt: pg.timestamp("available_at", { withTimezone: true }).notNull(),
    leaseOwner: pg.text("lease_owner"),
    leaseToken: pg.integer("lease_token").notNull(),
    leaseUntil: pg.timestamp("lease_until", { withTimezone: true }),
    deliveredAt: pg.timestamp("delivered_at", { withTimezone: true }),
    lastError: pg.jsonb("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  indexes: [
    pg.index("workflow_command_delivery_idx").on("status", "availableAt", "createdAt"),
    pg.index("workflow_command_run_idx").on("runId", "createdAt"),
  ],
}) {}

export const workflowRun = WorkflowRun;
export const workflowCommand = WorkflowCommand;
