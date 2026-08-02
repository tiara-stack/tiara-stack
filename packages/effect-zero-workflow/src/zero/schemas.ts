import { Data, Schema } from "effect";
import { ReadonlyJSONValue } from "typhoon-zero/schema";
import { WorkflowEventId } from "../event";
import { WorkflowRunStatus } from "../models";

export const WorkflowZeroContext = Schema.Struct({
  principalId: Schema.String,
  visibilityKey: Schema.String,
});

export type WorkflowZeroContext = typeof WorkflowZeroContext.Type;

export class WorkflowRunNotAccessibleError extends Data.TaggedError(
  "WorkflowRunNotAccessibleError",
)<{
  readonly runId: string;
  readonly visibilityKey: string;
  readonly message: string;
}> {}

export const WorkflowEnqueueRequest = Schema.Struct({
  runId: Schema.String,
  workflowName: Schema.String,
  definitionVersion: Schema.String,
  executionId: Schema.String,
  payload: ReadonlyJSONValue,
  maxAttempts: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  runAfter: Schema.optional(Schema.Finite),
});

export type WorkflowEnqueueRequest = typeof WorkflowEnqueueRequest.Type;

export const DelegatedWorkflowEnqueueRequest = Schema.Struct({
  caller: Schema.Struct({
    principalId: Schema.String,
  }),
  workflow: WorkflowEnqueueRequest,
});

export type DelegatedWorkflowEnqueueRequest = typeof DelegatedWorkflowEnqueueRequest.Type;

export const WorkflowCommandRequest = Schema.Struct({
  commandId: Schema.String,
  runId: Schema.String,
  kind: Schema.Literals(["cancel", "resume"]),
  payload: ReadonlyJSONValue,
  availableAt: Schema.optional(Schema.Finite),
});

export type WorkflowCommandRequest = typeof WorkflowCommandRequest.Type;

export const WorkflowEventRequest = Schema.Struct({
  commandId: Schema.String,
  runId: Schema.String,
  eventId: WorkflowEventId,
  value: ReadonlyJSONValue,
  availableAt: Schema.optional(Schema.Finite),
});

export type WorkflowEventRequest = typeof WorkflowEventRequest.Type;

export const PublicWorkflowRun = Schema.Struct({
  runId: Schema.String,
  workflowName: Schema.String,
  definitionVersion: Schema.String,
  visibilityKey: Schema.String,
  status: WorkflowRunStatus,
  result: Schema.NullOr(ReadonlyJSONValue),
  error: Schema.NullOr(ReadonlyJSONValue),
  runAfter: Schema.Number,
  startedAt: Schema.NullOr(Schema.Number),
  completedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const isWorkflowZeroContext = Schema.is(WorkflowZeroContext);
