import { Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  WorkflowCommandKind,
  WorkflowCommandStatus,
  workflowCommand,
  workflowRun,
  WorkflowRunStatus,
} from "./models";

describe("workflow models", () => {
  it("defines portable unprefixed SQL tables", () => {
    expect(workflowRun.sqlName).toBe("workflow_run");
    expect(workflowCommand.sqlName).toBe("workflow_command");
    expect(workflowRun.primaryKey).toEqual(["runId"]);
    expect(workflowCommand.primaryKey).toEqual(["commandId"]);
  });

  it("decodes the public lifecycle statuses", () => {
    expect(Schema.decodeUnknownSync(WorkflowRunStatus)("pending")).toBe("pending");
    expect(Schema.decodeUnknownSync(WorkflowCommandKind)("event")).toBe("event");
    expect(Schema.decodeUnknownSync(WorkflowCommandStatus)("delivering")).toBe("delivering");
  });
});
