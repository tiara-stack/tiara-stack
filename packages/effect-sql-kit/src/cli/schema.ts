import { Schema } from "effect";

export const DialectSchema = Schema.Literals(["postgresql", "sqlite"]);

export const DbCredentialsSchema = Schema.Struct({
  url: Schema.optional(Schema.String),
});

export const MigrationsConfigSchema = Schema.Struct({
  table: Schema.optional(Schema.String),
  schema: Schema.optional(Schema.String),
});

export const EffectSqlKitConfigSchema = Schema.Struct({
  dialect: DialectSchema,
  schema: Schema.optional(Schema.String),
  out: Schema.optional(Schema.String),
  dbCredentials: Schema.optional(DbCredentialsSchema),
  migrations: Schema.optional(MigrationsConfigSchema),
  breakpoints: Schema.optional(Schema.Boolean),
});

export const EffectSqlKitConfigOverridesSchema = Schema.Struct({
  dialect: Schema.optional(DialectSchema),
  schema: Schema.optional(Schema.String),
  out: Schema.optional(Schema.String),
  dbCredentials: Schema.optional(DbCredentialsSchema),
  migrations: Schema.optional(MigrationsConfigSchema),
  breakpoints: Schema.optional(Schema.Boolean),
});

export const ResolvedConfigSchema = Schema.Struct({
  dialect: DialectSchema,
  schema: Schema.optional(Schema.String),
  out: Schema.String,
  dbCredentials: Schema.optional(DbCredentialsSchema),
  migrations: Schema.Struct({
    table: Schema.String,
    schema: Schema.String,
  }),
  breakpoints: Schema.Boolean,
});

export const EffectSqlSchemaExportSchema = Schema.Struct({
  _tag: Schema.Literal("EffectSqlSchema"),
  tables: Schema.Record(Schema.String, Schema.Unknown),
});
