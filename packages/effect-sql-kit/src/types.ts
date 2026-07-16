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

import type { Dialect, EffectSqlSchema } from "effect-sql-schema";
import type { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { MigrationStatement } from "./diff/types";
import type { SchemaSnapshot } from "./snapshot";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type MigrationConfig = {
  readonly table?: string | undefined;
  readonly schema?: string | undefined;
};

export type EffectSqlKitConfig = {
  readonly dialect: Dialect;
  readonly schema?: string | undefined;
  readonly out?: string | undefined;
  readonly prefix?: string | undefined;
  readonly dbCredentials?: {
    readonly url?: string | undefined;
  };
  readonly migrations?: MigrationConfig | undefined;
  readonly breakpoints?: boolean | undefined;
  readonly extensions?: readonly MigrationExtension[] | undefined;
};

export type ResolvedConfig = {
  readonly dialect: Dialect;
  readonly schema?: string | undefined;
  readonly out: string;
  readonly prefix: string;
  readonly dbCredentials?: {
    readonly url?: string | undefined;
  };
  readonly migrations: {
    readonly table: string;
    readonly schema: string;
  };
  readonly breakpoints: boolean;
  readonly extensions: readonly MigrationExtension[];
};

export type MigrationExtensionContext = {
  readonly config: ResolvedConfig;
  readonly schema: EffectSqlSchema;
  readonly previous: SchemaSnapshot;
  readonly current: SchemaSnapshot;
  readonly statements?: readonly MigrationStatement[] | undefined;
  readonly previousExtensions: Readonly<Record<string, JsonValue>>;
};

export type MigrationExtensionIntrospectContext = {
  readonly config: ResolvedConfig;
  readonly schema: EffectSqlSchema;
  readonly previous: SchemaSnapshot;
  readonly current: SchemaSnapshot;
};

export type MigrationExtensionResult = {
  readonly beforeStatements?: readonly MigrationStatement[] | undefined;
  readonly statements: readonly MigrationStatement[];
  readonly snapshot: JsonValue;
};

export type MigrationExtension = {
  readonly _tag: "EffectSqlKitMigrationExtension";
  readonly name: string;
  readonly generate: (
    context: MigrationExtensionContext,
  ) => MigrationExtensionResult | Promise<MigrationExtensionResult>;
  readonly introspect?:
    | ((
        context: MigrationExtensionIntrospectContext,
      ) =>
        | JsonValue
        | undefined
        | Promise<JsonValue | undefined>
        | Effect.Effect<JsonValue | undefined, unknown, SqlClient.SqlClient>)
    | undefined;
};
