import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { readJournalEffect, readLatestSnapshotEffect } from "effect-sql-kit";
import { snapshotSchema, type SchemaSnapshot } from "effect-sql-schema/snapshot";
import { inferTable } from "effect-zero";
import { fileURLToPath } from "node:url";
import effectZeroConfig from "../../effect-zero.config";
import * as publicModels from "../models";
import { schema as canonicalSchema } from "../schema";
import { schema as generatedZeroSchema } from "./schema";

type ZeroTable = (typeof effectZeroConfig.tables)[keyof typeof effectZeroConfig.tables];

const projectZeroTable = (table: ZeroTable) => {
  const inferred = inferTable(table);
  return {
    name: inferred.name,
    columns: Object.fromEntries(
      Object.entries(inferred.columns).map(([name, column]) => [
        name,
        {
          type: column.type,
          optional: column.optional,
          customType: null,
          ...(column.serverName === undefined ? {} : { serverName: column.serverName }),
        },
      ]),
    ),
    primaryKey: inferred.primaryKey,
    ...(inferred.serverName === undefined || inferred.serverName === inferred.name
      ? {}
      : { serverName: inferred.serverName }),
  };
};

const projectZeroSchema = () => ({
  tables: Object.fromEntries(
    Object.entries(effectZeroConfig.tables).map(([name, table]) => [name, projectZeroTable(table)]),
  ),
  relationships: effectZeroConfig.relationships,
  enableLegacyQueries: false,
  enableLegacyMutators: false,
});

const readLatestMigrationSchema = Effect.gen(function* () {
  const migrationsDirectory = fileURLToPath(
    new URL("../../effect-sql-migrations/", import.meta.url),
  );
  const journal = yield* readJournalEffect(migrationsDirectory, "postgresql");
  const latestMigration = yield* readLatestSnapshotEffect(migrationsDirectory, journal);
  if (latestMigration === undefined) {
    return yield* Effect.fail(new Error("The migration journal has no entries"));
  }
  return {
    ...latestMigration.schema,
    relationships: latestMigration.schema.relationships ?? {},
  } satisfies SchemaSnapshot;
}).pipe(
  Effect.mapError(
    (cause) =>
      new Error(
        "Unable to read the latest migration snapshot; run `pnpm --filter sheet-db-schema schema:generate` first",
        { cause },
      ),
  ),
);

const columnFacts = (input: SchemaSnapshot) =>
  Object.values(input.tables)
    .flatMap((table) =>
      Object.values(table.columns).map((column) => ({
        table: table.name,
        column: column.name,
        default: column.default,
        defaultSql: column.defaultSql,
        references: column.references,
      })),
    )
    .sort((left, right) =>
      `${left.table}.${left.column}`.localeCompare(`${right.table}.${right.column}`),
    );

describe("canonical schema artifact parity", () => {
  it("generates Zero tables and relationships from the canonical AST", () => {
    expect(generatedZeroSchema).toEqual(projectZeroSchema());
    expect(effectZeroConfig.relationships).toBe(canonicalSchema.relationships);
    expect(Object.keys(effectZeroConfig.tables)).toEqual(Object.keys(canonicalSchema.tables));
  });

  it("keeps public models as aliases of canonical tables", () => {
    expect(Object.keys(publicModels).sort()).toEqual(Object.keys(canonicalSchema.tables).sort());
    for (const [name, table] of Object.entries(canonicalSchema.tables)) {
      expect(publicModels[name as keyof typeof publicModels]).toBe(table);
    }
  });

  it.live(
    "matches the latest generated migration for tables, indexes, relations, and defaults",
    () =>
      Effect.gen(function* () {
        const current = snapshotSchema(canonicalSchema);
        const latestMigrationSchema = yield* readLatestMigrationSchema;

        expect(current.relationships).toEqual(canonicalSchema.relationships);
        expect(
          Object.fromEntries(
            Object.entries(current.tables).map(([name, table]) => [name, table.indexes]),
          ),
        ).toEqual(
          Object.fromEntries(
            Object.entries(latestMigrationSchema.tables).map(([name, table]) => [
              name,
              table.indexes,
            ]),
          ),
        );
        expect(columnFacts(current)).toEqual(columnFacts(latestMigrationSchema));
        expect(current).toEqual(latestMigrationSchema);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
