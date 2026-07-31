import { Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  WorkflowCommandKind,
  WorkflowCommandStatus,
  workflowCommand,
  workflowRun,
  WorkflowRunStatus,
} from "./models";
import { isTerminalWorkflowRunStatus, workflowTableNames } from "./store";

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

  it("recognizes terminal run statuses", () => {
    expect(isTerminalWorkflowRunStatus("pending")).toBe(false);
    expect(isTerminalWorkflowRunStatus("running")).toBe(false);
    expect(isTerminalWorkflowRunStatus("succeeded")).toBe(true);
    expect(isTerminalWorkflowRunStatus("failed")).toBe(true);
    expect(isTerminalWorkflowRunStatus("cancelled")).toBe(true);
  });

  it("normalizes application table prefixes", () => {
    expect(workflowTableNames()).toEqual({
      command: "workflow_command",
      run: "workflow_run",
    });
    expect(workflowTableNames("sheet_db_")).toEqual({
      command: "sheet_db_workflow_command",
      run: "sheet_db_workflow_run",
    });
  });
});
