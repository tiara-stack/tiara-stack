import type { MigrationStatement } from "../diff/types";
import { statementDelimiter } from "../util";

const escapeTemplate = (sql: string): string =>
  sql.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");

export const renderEffectMigration = (
  statements: readonly MigrationStatement[],
  options?: { readonly breakpoints?: boolean },
): string => {
  const executable = statements.filter((statement) => statement.sql.trim().length > 0);
  const body =
    executable.length === 0
      ? "  yield* Effect.void;\n"
      : executable
          .map(
            (statement) =>
              `  yield* sql.unsafe(\`${escapeTemplate(statement.sql)}\`).withoutTransform;\n`,
          )
          .join(options?.breakpoints ? `\n  // ${statementDelimiter}\n` : "\n");

  return `// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

${body}});
`;
};
