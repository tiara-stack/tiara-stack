import { fromSqlSchema } from "effect-zero";
import { schema } from "./src/schema";

const generated = fromSqlSchema(schema);
const { workflowCommand: _, ...publicTables } = generated.tables;
const publicWorkflowRun = {
  ...publicTables.workflowRun,
  columns: {
    ...publicTables.workflowRun.columns,
    executionId: false,
    idempotencyKey: false,
    principal: false,
    input: false,
    maxAttempts: false,
  },
};

export default {
  ...generated,
  tables: {
    ...publicTables,
    workflowRun: publicWorkflowRun,
  },
};
