import { fromSqlSchema } from "effect-zero";
import { schema } from "./src/schema";

export default fromSqlSchema(schema);
