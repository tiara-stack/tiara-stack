import { configureWorkflowZeroSchema } from "effect-zero-workflow";
import { fromSqlSchema } from "effect-zero";
import { schema } from "./src/schema";

export default configureWorkflowZeroSchema(fromSqlSchema(schema));
