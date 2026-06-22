import { Schema } from "effect";
import type { JsonValue, MigrationExtensionResult } from "../types";

export const DialectSchema = Schema.Literals(["postgresql", "sqlite"]);

const DbCredentialsSchema = Schema.Struct({
  url: Schema.optional(Schema.String),
});

const MigrationsConfigSchema = Schema.Struct({
  table: Schema.optional(Schema.String),
  schema: Schema.optional(Schema.String),
});

const FunctionSchema = Schema.declare(
  (input): input is (...args: readonly never[]) => unknown => typeof input === "function",
);

export const JsonValueSchema: Schema.Codec<JsonValue> = Schema.suspend(
  (): Schema.Codec<JsonValue> =>
    Schema.Union([
      Schema.Null,
      Schema.String,
      Schema.Number,
      Schema.Boolean,
      Schema.Array(JsonValueSchema),
      Schema.Record(Schema.String, JsonValueSchema),
    ]) as Schema.Codec<JsonValue>,
);

const MigrationStatementSchema = Schema.Struct({
  sql: Schema.String,
  destructive: Schema.optional(Schema.Boolean),
  unsupported: Schema.optional(Schema.Boolean),
  reason: Schema.optional(Schema.String),
});

export const MigrationExtensionResultSchema: Schema.Schema<MigrationExtensionResult> =
  Schema.Struct({
    beforeStatements: Schema.optional(Schema.Array(MigrationStatementSchema)),
    statements: Schema.Array(MigrationStatementSchema),
    snapshot: JsonValueSchema,
  });

const MigrationExtensionSchema = Schema.Struct({
  _tag: Schema.Literal("EffectSqlKitMigrationExtension"),
  name: Schema.String,
  generate: FunctionSchema,
  introspect: Schema.optional(FunctionSchema),
});

export const EffectSqlKitConfigSchema = Schema.Struct({
  dialect: DialectSchema,
  schema: Schema.optional(Schema.String),
  out: Schema.optional(Schema.String),
  prefix: Schema.optional(Schema.String),
  dbCredentials: Schema.optional(DbCredentialsSchema),
  migrations: Schema.optional(MigrationsConfigSchema),
  breakpoints: Schema.optional(Schema.Boolean),
  extensions: Schema.optional(Schema.Array(MigrationExtensionSchema)),
});

export const EffectSqlKitConfigOverridesSchema = Schema.Struct({
  dialect: Schema.optional(DialectSchema),
  schema: Schema.optional(Schema.String),
  out: Schema.optional(Schema.String),
  prefix: Schema.optional(Schema.String),
  dbCredentials: Schema.optional(DbCredentialsSchema),
  migrations: Schema.optional(MigrationsConfigSchema),
  breakpoints: Schema.optional(Schema.Boolean),
  extensions: Schema.optional(Schema.Array(MigrationExtensionSchema)),
});

export const ResolvedConfigSchema = Schema.Struct({
  dialect: DialectSchema,
  schema: Schema.optional(Schema.String),
  out: Schema.String,
  prefix: Schema.String,
  dbCredentials: Schema.optional(DbCredentialsSchema),
  migrations: Schema.Struct({
    table: Schema.String,
    schema: Schema.String,
  }),
  breakpoints: Schema.Boolean,
  extensions: Schema.Array(MigrationExtensionSchema),
});

export const EffectSqlSchemaExportSchema = Schema.Struct({
  _tag: Schema.Literal("EffectSqlSchema"),
  tables: Schema.Record(Schema.String, Schema.Unknown),
  prefix: Schema.optional(Schema.String),
});
