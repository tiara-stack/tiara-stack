import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vitest";
import {
  admitSheetDbMigrationHistory,
  compareMigrationHistory,
  MigrationAdmissionError,
} from "./index";
import { sheetDbMigrationArtifacts } from "../migrations";

describe("State Plane migration admission", () => {
  it.effect("accepts only the complete expected migration id and artifact-name history", () =>
    Effect.gen(function* () {
      const history = sheetDbMigrationArtifacts.map(([id, name]) => [id, name] as const);
      yield* compareMigrationHistory(history);
    }),
  );

  it.effect("refuses missing, unknown, reordered, or renamed migration artifacts", () =>
    Effect.gen(function* () {
      const history = sheetDbMigrationArtifacts.map(([id, name]) => [id, name] as const);
      const unknown = [...history, [26, "unregistered"] as const];
      const mismatched = history.map(
        ([id, name]) => [id, id === 25 ? "changed_artifact" : name] as const,
      );
      for (const observed of [history.slice(0, -1), unknown, mismatched]) {
        const exit = yield* Effect.exit(compareMigrationHistory(observed));
        expect(Exit.isFailure(exit)).toBe(true);
      }
    }),
  );

  it.effect("uses a read-only journal query and starts no work after failed admission", () =>
    Effect.gen(function* () {
      const history = sheetDbMigrationArtifacts
        .slice(0, -1)
        .map(([migration_id, name]) => ({ migration_id, name }));
      const statements: string[] = [];
      const sql = Object.assign(() => Effect.succeed([]), {
        unsafe: (statement: string) => {
          statements.push(statement);
          return { withoutTransform: Effect.succeed(history) };
        },
      }) as unknown as SqlClient.SqlClient;
      let applicationWorkStarted = false;
      const startup = Effect.gen(function* () {
        yield* admitSheetDbMigrationHistory;
        applicationWorkStarted = true;
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));

      const exit = yield* Effect.exit(startup);
      expect(Exit.isFailure(exit)).toBe(true);
      const error = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        : undefined;
      expect(error).toBeInstanceOf(MigrationAdmissionError);
      expect(applicationWorkStarted).toBe(false);
      expect(statements).toHaveLength(1);
      expect(statements[0]?.trim()).toMatch(/^SELECT migration_id, name/);
      expect(statements[0]).not.toMatch(/CREATE|ALTER|INSERT|UPDATE|DELETE|DROP/i);
    }),
  );
});
