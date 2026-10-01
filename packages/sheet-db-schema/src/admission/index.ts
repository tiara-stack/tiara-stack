import { Data, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { sheetDbMigrationArtifacts } from "../migrations";

export class MigrationAdmissionError extends Data.TaggedError("MigrationAdmissionError")<{
  readonly message: string;
  readonly expected: ReadonlyArray<readonly [number, string]>;
  readonly observed: ReadonlyArray<readonly [number, string]>;
}> {}

/** Pure comparison used by both the SQL adapter and its contract tests. */
export const compareMigrationHistory = (
  observed: ReadonlyArray<readonly [number, string]>,
): Effect.Effect<void, MigrationAdmissionError> => {
  const expected = sheetDbMigrationArtifacts.map(([id, name]) => [id, name] as const);
  if (
    observed.length !== expected.length ||
    observed.some(
      ([id, name], index) => id !== expected[index]?.[0] || name !== expected[index]?.[1],
    )
  ) {
    return Effect.fail(
      new MigrationAdmissionError({
        message: "Applied State Plane migration history does not match this runtime",
        expected,
        observed,
      }),
    );
  }
  return Effect.void;
};

/** Reads only the existing journal. It deliberately never creates the journal table. */
export const admitSheetDbMigrationHistory: Effect.Effect<
  void,
  MigrationAdmissionError | SqlError,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql.unsafe<{ migration_id: number; name: string }>(`
    SELECT migration_id, name
    FROM "sheet_db_effect_sql_migrations"
    ORDER BY migration_id
  `).withoutTransform;
  yield* compareMigrationHistory(
    rows.map(({ migration_id, name }) => [migration_id, name] as const),
  );
});
