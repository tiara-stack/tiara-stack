export type {
  ColumnData,
  Dialect,
  EffectSqlColumn,
  EffectSqlModel,
  EffectSqlSchema,
  EffectSqlSchemaOptions,
  EffectSqlTable,
  FieldName,
  IndexDefinition,
  ReferenceAction,
  ReferenceOptions,
  ReferenceResolver,
  SqlDefaultValue,
  TableColumns,
  TableOptions,
} from "effect-sql-schema";

import type { Dialect } from "effect-sql-schema";

export type MigrationConfig = {
  readonly table?: string;
  readonly schema?: string;
};

export type EffectSqlKitConfig = {
  readonly dialect: Dialect;
  readonly schema?: string;
  readonly out?: string;
  readonly tablePrefix?: string;
  readonly dbCredentials?: {
    readonly url?: string;
  };
  readonly migrations?: MigrationConfig;
  readonly breakpoints?: boolean;
};

export type ResolvedConfig = {
  readonly dialect: Dialect;
  readonly schema?: string;
  readonly out: string;
  readonly tablePrefix: string;
  readonly dbCredentials?: {
    readonly url?: string;
  };
  readonly migrations: {
    readonly table: string;
    readonly schema: string;
  };
  readonly breakpoints: boolean;
};
