import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path, Result, Schema } from "effect";
import type { EffectSqlSchema, ResolvedConfig } from "../types";
import { diffPg } from "../diff/pg";
import { diffSqlite } from "../diff/sqlite";
import type { MigrationStatement } from "../diff/types";
import { emptySnapshot, snapshotSchema } from "../snapshot";
import { lowerToDrizzleSnapshot } from "../drizzle-lower";
import {
  nextMigrationName,
  readJournalEffect,
  readLatestSnapshotEffect,
  writeMigrationRecordEffect,
} from "./journal";
import { renderEffectMigration } from "./render";

export type GenerateOptions = {
  readonly config: ResolvedConfig;
  readonly schema: EffectSqlSchema;
  readonly name?: string;
  readonly custom?: boolean;
  readonly prefix?: "index" | "timestamp";
};

export type GenerateResult = {
  readonly written: boolean;
  readonly tag?: string;
  readonly statements: readonly MigrationStatement[];
};

export const generateMigrationEffect = ({
  config,
  schema,
  name,
  custom,
  prefix = "index",
}: GenerateOptions): Effect.Effect<GenerateResult, unknown, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const current = snapshotSchema(schema);
    if (current.dialect !== config.dialect) {
      return yield* Effect.fail(
        new Error(
          `effect-sql-kit: config dialect ${config.dialect} does not match schema dialect ${current.dialect}`,
        ),
      );
    }

    const journal = yield* readJournalEffect(config.out, config.dialect);
    const previousStored = yield* readLatestSnapshotEffect(config.out, journal);
    const previous = previousStored?.schema ?? emptySnapshot(config.dialect);
    const diff =
      config.dialect === "postgresql" ? diffPg(previous, current) : diffSqlite(previous, current);
    const currentDrizzleResult = yield* Effect.result(
      Effect.tryPromise({
        try: () => lowerToDrizzleSnapshot(schema),
        catch: (error) => ({ error: String(error) }),
      }),
    );
    const currentDrizzle = Result.isSuccess(currentDrizzleResult)
      ? currentDrizzleResult.success
      : currentDrizzleResult.failure;
    const drizzleStatements = yield* generateWithDrizzleEffect({
      dialect: config.dialect,
      previous: previousStored?.drizzle,
      current: currentDrizzle,
    });
    const statements: readonly MigrationStatement[] =
      drizzleStatements.length > 0 ? drizzleStatements.map((sql) => ({ sql })) : diff.statements;
    const unsupported = statements.filter((statement) => statement.unsupported);
    if (unsupported.length > 0 && !custom) {
      return yield* Effect.fail(
        new Error(unsupported.map((statement) => statement.reason).join("\n")),
      );
    }
    if (!custom && statements.filter((statement) => statement.sql.trim().length > 0).length === 0) {
      return { written: false, statements: [] };
    }

    const {
      idx,
      prefix: migrationPrefix,
      tag,
    } = nextMigrationName(journal, name ?? (custom ? "custom" : "migration"), prefix);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(config.out, { recursive: true });
    yield* fs.writeFileString(
      path.join(config.out, `${tag}.ts`),
      renderEffectMigration(custom ? [] : statements, { breakpoints: config.breakpoints }),
    );
    yield* writeMigrationRecordEffect({
      out: config.out,
      journal,
      snapshot: current,
      tag,
      prefix: migrationPrefix,
      idx,
      breakpoints: config.breakpoints,
      prevSnapshotId: previousStored?.id,
      drizzle: currentDrizzle,
    });

    return { written: true, tag, statements: custom ? [] : statements };
  });

export const generateMigration = (options: GenerateOptions): Promise<GenerateResult> =>
  Effect.runPromise(generateMigrationEffect(options).pipe(Effect.provide(NodeServices.layer)));

const DrizzleSnapshotSchema = Schema.Struct({
  version: Schema.String,
  dialect: Schema.String,
  tables: Schema.Record(Schema.String, Schema.Unknown),
});

const SqliteDrizzleSnapshotSchema = Schema.Struct({
  version: Schema.String,
  dialect: Schema.String,
  tables: Schema.Record(Schema.String, Schema.Unknown),
});

const generateWithDrizzleEffect = ({
  dialect,
  previous,
  current,
}: {
  readonly dialect: "postgresql" | "sqlite";
  readonly previous: unknown;
  readonly current: unknown;
}): Effect.Effect<readonly string[]> => {
  if (!previous || !current || typeof previous !== "object" || typeof current !== "object") {
    return Effect.succeed([]);
  }

  const snapshotSchema =
    dialect === "postgresql" ? DrizzleSnapshotSchema : SqliteDrizzleSnapshotSchema;
  const previousResult = Schema.decodeUnknownOption(snapshotSchema)(previous);
  const currentResult = Schema.decodeUnknownOption(snapshotSchema)(current);
  if (previousResult._tag === "None" || currentResult._tag === "None") {
    return Effect.succeed([]);
  }

  return Effect.tryPromise({
    try: async () => {
      const api = await import("drizzle-kit/api");
      return dialect === "postgresql"
        ? await api.generateMigration(previousResult.value, currentResult.value)
        : await api.generateSQLiteMigration(previousResult.value, currentResult.value);
    },
    catch: (error) => error,
  }).pipe(Effect.catch(() => Effect.succeed([])));
};
