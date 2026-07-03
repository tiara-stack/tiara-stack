import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Command, Flag } from "effect/unstable/cli";
import { SqlClient } from "effect/unstable/sql";
import type { PgPoolConfig } from "@effect/sql-pg/PgClient";
import { diffPg } from "../diff/pg";
import { diffSqlite } from "../diff/sqlite";
import type { MigrationStatement } from "../diff/types";
import { introspectPg } from "../introspect/pg";
import { introspectSqlite } from "../introspect/sqlite";
import {
  introspectMigrationExtensionsEffect,
  runMigrationExtensionsEffect,
} from "../migration/extensions";
import { snapshotSchema } from "../snapshot";
import type { EffectSqlSchema } from "../types";
import { loadConfig, loadConfigEffect, loadSchemaEffect } from "./config";
import { configFlags, configInputToOverrides, optionalValue, tryPromise } from "./options";
import * as Data from "effect/Data";

class EffectSqlKitCliPushError extends Data.TaggedError("EffectSqlKitCliPushError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const confirmEffect = (message: string) =>
  tryPromise(async (): Promise<boolean> => {
    if (!process.stdin.isTTY) {
      return false;
    }
    const rl = createInterface({ input, output });
    try {
      const answer = await rl.question(`${message} Type "yes" to continue: `);
      return answer.trim().toLowerCase() === "yes";
    } finally {
      rl.close();
    }
  });

const applyStatements = (statements: readonly MigrationStatement[]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of statements) {
      if (statement.sql.trim().length > 0) {
        yield* sql.unsafe(statement.sql).withoutTransform;
      }
    }
  });

const runWithClient = async <A>(
  config: Awaited<ReturnType<typeof loadConfig>>["config"],
  effect: Effect.Effect<A, unknown, SqlClient.SqlClient>,
) => {
  const url = config.dbCredentials?.url;
  if (!url) {
    throw new Error("effect-sql-kit: --url or dbCredentials.url is required for push");
  }
  if (config.dialect === "postgresql") {
    const [{ PgClient }, { NodeServices }] = await Promise.all([
      import("@effect/sql-pg"),
      import("@effect/platform-node"),
    ]);
    const pgConfig = { url: Redacted.make(url) } satisfies PgPoolConfig;
    return await Effect.runPromise(
      effect.pipe(Effect.provide(Layer.mergeAll(PgClient.layer(pgConfig), NodeServices.layer))),
    );
  }
  const [{ SqliteClient }, { NodeServices, NodeFileSystem, NodePath }] = await Promise.all([
    import("@effect/sql-sqlite-node"),
    import("@effect/platform-node"),
  ]);
  return await Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteClient.layer({ filename: url }),
          NodeServices.layer,
          NodeFileSystem.layer,
          NodePath.layer,
        ),
      ),
    ),
  );
};

const runWithClientEffect = <A>(
  config: Awaited<ReturnType<typeof loadConfig>>["config"],
  effect: Effect.Effect<A, unknown, SqlClient.SqlClient>,
) => tryPromise(() => runWithClient(config, effect));

export const buildPushStatementsEffect = ({
  config,
  schema,
  live,
  desired,
}: {
  readonly config: Awaited<ReturnType<typeof loadConfig>>["config"];
  readonly schema: EffectSqlSchema;
  readonly live: ReturnType<typeof snapshotSchema>;
  readonly desired: ReturnType<typeof snapshotSchema>;
}): Effect.Effect<readonly MigrationStatement[], unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const diff =
      config.dialect === "postgresql" ? diffPg(live, desired) : diffSqlite(live, desired);
    const previousExtensions = yield* introspectMigrationExtensionsEffect({
      config,
      schema,
      previous: live,
      current: desired,
    });
    const extensionResults = yield* runMigrationExtensionsEffect({
      config,
      schema,
      previous: live,
      current: desired,
      previousExtensions,
    });
    const extensionStatements = extensionResults.flatMap((result) => result.statements);
    return [...diff.statements, ...extensionStatements] as readonly MigrationStatement[];
  });

export const pushCommand = Command.make(
  "push",
  {
    ...configFlags,
    strict: Flag.boolean("strict").pipe(Flag.withDefault(false)),
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
    force: Flag.boolean("force").pipe(Flag.withDefault(false)),
  },
  (options) =>
    Effect.gen(function* () {
      const { config } = yield* loadConfigEffect(
        optionalValue(options.config),
        configInputToOverrides(options),
      );
      const sqlSchema = yield* loadSchemaEffect(optionalValue(options.schema), config);
      const schemaWithPrefix = {
        ...sqlSchema,
        prefix: config.prefix ?? sqlSchema.prefix,
      };
      const desired = snapshotSchema(schemaWithPrefix);
      const excludedTables = [config.migrations.table];
      const live = yield* runWithClientEffect(
        config,
        (config.dialect === "postgresql"
          ? introspectPg(config.migrations.schema, { excludedTables })
          : introspectSqlite({ excludedTables })) as Effect.Effect<
          typeof desired,
          unknown,
          SqlClient.SqlClient
        >,
      );
      const allStatements = yield* runWithClientEffect(
        config,
        buildPushStatementsEffect({
          config,
          schema: schemaWithPrefix,
          live,
          desired,
        }),
      );
      const unsupported = allStatements.filter((statement) => statement.unsupported);
      if (unsupported.length > 0) {
        return yield* new EffectSqlKitCliPushError({
          message: unsupported.map((statement) => statement.reason).join("\n"),
        });
      }
      const statements = allStatements.filter((statement) => statement.sql.trim().length > 0);
      if (statements.length === 0) {
        yield* Console.log("effect-sql-kit: no changes detected");
        return;
      }
      if (options.verbose) {
        yield* Console.log(statements.map((statement) => `${statement.sql};`).join("\n"));
      }
      const destructive = statements.filter((statement) => statement.destructive);
      if (!options.force && (options.strict || destructive.length > 0)) {
        const ok = yield* confirmEffect(
          destructive.length > 0
            ? "effect-sql-kit: destructive statements detected."
            : "effect-sql-kit: apply these statements?",
        );
        if (!ok) {
          yield* Console.log("effect-sql-kit: push aborted");
          return;
        }
      }
      yield* runWithClientEffect(config, applyStatements(statements));
      yield* Console.log(`effect-sql-kit: applied ${statements.length} statement(s)`);
    }),
).pipe(Command.withDescription("Push schema changes directly to the database"));
