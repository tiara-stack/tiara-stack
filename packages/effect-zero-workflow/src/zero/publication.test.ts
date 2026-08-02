import { fromSqlSchema } from "effect-zero";
import { schema as makeSqlSchema } from "effect-sql-schema";
import { Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { workflowCommand, workflowRun } from "../models";
import { configureWorkflowZeroSchema } from "./publication";

describe("workflow Zero publication", () => {
  it("excludes commands and private run columns", () => {
    const configured = configureWorkflowZeroSchema(
      fromSqlSchema(
        makeSqlSchema(
          {
            workflowCommand,
            workflowRun,
          },
          { prefix: "sheet_db" },
        ),
      ),
    );

    expect(configured.tables).not.toHaveProperty("workflowCommand");
    expect(configured.tables.workflowRun.serverName).toBe("sheet_db_workflow_run");
    expect(configured.tables.workflowRun.columns).toEqual({
      completedAt: expect.any(Object),
      createdAt: expect.any(Object),
      definitionVersion: expect.any(Object),
      error: expect.any(Object),
      executionId: false,
      idempotencyKey: false,
      input: false,
      maxAttempts: false,
      principal: false,
      result: expect.any(Object),
      runAfter: expect.any(Object),
      runId: expect.any(Object),
      startedAt: expect.any(Object),
      status: expect.any(Object),
      updatedAt: expect.any(Object),
      visibilityKey: expect.any(Object),
      workflowName: expect.any(Object),
    });
  });

  it("hides unlisted workflow run fields by default", () => {
    const generated = fromSqlSchema(
      makeSqlSchema(
        {
          workflowCommand,
          workflowRun,
        },
        { prefix: "sheet_db" },
      ),
    );
    const configured = configureWorkflowZeroSchema({
      ...generated,
      tables: {
        ...generated.tables,
        workflowRun: {
          ...generated.tables.workflowRun,
          model: {
            ...generated.tables.workflowRun.model,
            fields: {
              ...generated.tables.workflowRun.model.fields,
              futurePrivateField: Schema.String,
            },
          },
        },
      },
    });

    expect(configured.tables.workflowRun.columns.futurePrivateField).toBe(false);
  });

  it("rejects explicitly hidden public workflow run columns", () => {
    const generated = fromSqlSchema(
      makeSqlSchema(
        {
          workflowCommand,
          workflowRun,
        },
        { prefix: "sheet_db" },
      ),
    );

    expect(() =>
      configureWorkflowZeroSchema({
        ...generated,
        tables: {
          ...generated.tables,
          workflowRun: {
            ...generated.tables.workflowRun,
            columns: {
              ...generated.tables.workflowRun.columns,
              status: false,
            },
          },
        },
      }),
    ).toThrow("Public workflow run columns cannot be hidden: status");
  });

  it("rejects relationships to the private workflow command table", () => {
    const generated = fromSqlSchema(
      makeSqlSchema(
        {
          workflowCommand,
          workflowRun,
        },
        { prefix: "sheet_db" },
      ),
    );

    expect(() =>
      configureWorkflowZeroSchema({
        ...generated,
        relationships: {
          workflowRun: {
            commands: [
              {
                cardinality: "many",
                destField: ["runId"],
                destSchema: "workflow_command",
                sourceField: ["runId"],
              },
            ],
          },
        },
      }),
    ).toThrow("Workflow command relationships cannot be published through Zero");
  });
});
