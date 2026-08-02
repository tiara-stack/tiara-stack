import type { EffectZeroSchema, EffectZeroTable } from "effect-zero";
import { Predicate } from "effect";
import { PublicWorkflowRun } from "./schemas";

type WorkflowTables = {
  readonly workflowCommand: EffectZeroTable;
  readonly workflowRun: EffectZeroTable;
};

const publicWorkflowRunColumns = Object.keys(PublicWorkflowRun.fields);

/** Applies the component's public Zero projection to a composed SQL schema. */
export const configureWorkflowZeroSchema = <
  const Config extends EffectZeroSchema<Config["tables"] & WorkflowTables>,
>(
  generated: Config,
) => {
  const { workflowCommand, ...publicTables } = generated.tables;
  const workflowCommandNames = new Set(
    [
      "workflowCommand",
      "workflow_command",
      workflowCommand.name,
      workflowCommand.serverName,
    ].filter(Predicate.isString),
  );
  const hasWorkflowCommandRelationship = Object.entries(generated.relationships).some(
    ([sourceTable, relationships]) =>
      workflowCommandNames.has(sourceTable) ||
      Object.values(relationships).some((steps) =>
        steps.some(({ destSchema }) => workflowCommandNames.has(destSchema)),
      ),
  );
  if (hasWorkflowCommandRelationship) {
    throw new Error("Workflow command relationships cannot be published through Zero");
  }
  const workflowRunColumns = publicTables.workflowRun.columns ?? {};
  const modelFieldNames = new Set(Object.keys(publicTables.workflowRun.model.fields));
  const missingPublicColumns = publicWorkflowRunColumns.filter(
    (column) => !modelFieldNames.has(column),
  );
  if (missingPublicColumns.length > 0) {
    throw new Error(
      `Public workflow run columns are absent from the model: ${missingPublicColumns.join(", ")}`,
    );
  }
  const hiddenPublicColumns = publicWorkflowRunColumns.filter(
    (column) => workflowRunColumns[column] === false,
  );
  if (hiddenPublicColumns.length > 0) {
    throw new Error(
      `Public workflow run columns cannot be hidden: ${hiddenPublicColumns.join(", ")}`,
    );
  }
  const hiddenWorkflowRunColumns = Object.fromEntries(
    Object.keys(publicTables.workflowRun.model.fields).map((column) => [column, false] as const),
  );
  const exposedWorkflowRunColumns = Object.fromEntries(
    publicWorkflowRunColumns.map((column) => [column, workflowRunColumns[column] ?? true] as const),
  );
  return {
    ...generated,
    tables: {
      ...publicTables,
      workflowRun: {
        ...publicTables.workflowRun,
        columns: {
          ...hiddenWorkflowRunColumns,
          ...exposedWorkflowRunColumns,
        },
      },
    },
  } as const;
};
