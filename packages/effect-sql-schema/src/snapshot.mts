import type {
  AnyEffectSqlColumn,
  AnyEffectSqlTable,
  EffectSqlSchema,
  RelationshipConfig,
  RelationshipDefinition,
  RelationshipStep,
} from "./types.js";

export const snapshotVersion = 1;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ColumnSnapshot = {
  readonly fieldName: string;
  readonly name: string;
  readonly kind: string;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
  readonly unique?: string | boolean | undefined;
  readonly default?: string | number | boolean | null | undefined;
  readonly defaultSql?: string | undefined;
  readonly references?:
    | {
        readonly table: string;
        readonly column: string;
        readonly onDelete?: string | undefined;
        readonly onUpdate?: string | undefined;
      }
    | undefined;
  readonly config?: Record<string, unknown> | undefined;
};

export type IndexSnapshot = {
  readonly name: string;
  readonly unique: boolean;
  readonly fields: readonly string[];
};

export type TableSnapshot = {
  readonly name: string;
  readonly schema?: string | undefined;
  readonly columns: Record<string, ColumnSnapshot>;
  readonly primaryKey: readonly string[];
  readonly indexes: readonly IndexSnapshot[];
};

export type SchemaSnapshot = {
  readonly version: typeof snapshotVersion;
  readonly dialect: "postgresql" | "sqlite";
  readonly tables: Record<string, TableSnapshot>;
  /** Absent only in snapshots written before relationship metadata became canonical. */
  readonly relationships?: RelationshipConfig | undefined;
};

export type StoredSnapshot = {
  readonly version: typeof snapshotVersion;
  readonly dialect: "postgresql" | "sqlite";
  readonly id: string;
  readonly prevId: string;
  readonly schema: SchemaSnapshot;
  readonly drizzle?: unknown;
  readonly extensions?: Readonly<Record<string, JsonValue>> | undefined;
};

const snapshotRelationshipStep = (step: RelationshipStep): RelationshipStep => ({
  ...step,
  sourceField: [...step.sourceField],
  destField: [...step.destField],
});

const snapshotRelationship = ([first, ...rest]: RelationshipDefinition): RelationshipDefinition => [
  snapshotRelationshipStep(first),
  ...rest.map(snapshotRelationshipStep),
];

const snapshotRelationships = (relationships: RelationshipConfig): RelationshipConfig => {
  const snapshot: Record<string, Record<string, RelationshipDefinition>> = {};
  for (const [sourceSchema, definitions] of Object.entries(relationships)) {
    const sourceSnapshot: Record<string, RelationshipDefinition> = {};
    for (const [name, definition] of Object.entries(definitions)) {
      sourceSnapshot[name] = snapshotRelationship(definition);
    }
    snapshot[sourceSchema] = sourceSnapshot;
  }
  return snapshot;
};

const columnName = (column: AnyEffectSqlColumn): string =>
  column.data.name ?? column.data.fieldName ?? "";

const prefixedIdentifierName = (prefix: string | undefined, name: string): string =>
  prefix ? `${prefix.replace(/_+$/, "")}_${name}` : name;

const referenceSnapshot = (
  column: AnyEffectSqlColumn,
  tableNameMap: ReadonlyMap<AnyEffectSqlColumn, string>,
): ColumnSnapshot["references"] => {
  const reference = column.data.references;
  if (!reference) {
    return undefined;
  }
  const target = reference.resolver();
  const table = tableNameMap.get(target);
  const targetName = target.data.name ?? target.data.fieldName;
  if (!table || !targetName) {
    return undefined;
  }
  return {
    table,
    column: targetName,
    onDelete: reference.options?.onDelete,
    onUpdate: reference.options?.onUpdate,
  };
};

export const snapshotTable = (
  table: AnyEffectSqlTable,
  allTableNames?: ReadonlyMap<AnyEffectSqlColumn, string>,
  options?: { readonly prefix?: string | undefined },
): TableSnapshot => {
  const tableName = prefixedIdentifierName(options?.prefix, table.sqlName ?? table.name);
  const tableNameMap = new Map(allTableNames);
  for (const column of Object.values(table.columns)) {
    tableNameMap.set(column, tableName);
  }
  const columns: Record<string, ColumnSnapshot> = {};
  for (const [fieldName, column] of Object.entries(table.columns)) {
    columns[fieldName] = {
      fieldName,
      name: columnName(column),
      kind: column.data.kind,
      notNull: Boolean(column.data.notNull),
      primaryKey: Boolean(column.data.primaryKey),
      unique: column.data.unique,
      default: column.data.defaultValue,
      defaultSql: column.data.defaultExpression,
      references: referenceSnapshot(column, tableNameMap),
      config: column.data.config,
    };
  }
  return {
    name: tableName,
    schema: table.schema,
    columns,
    primaryKey: table.primaryKey,
    indexes: table.indexes.map((index) => ({
      name: prefixedIdentifierName(options?.prefix, index.name),
      unique: index.unique,
      fields: index.fields,
    })),
  };
};

export const snapshotSchema = (config: EffectSqlSchema): SchemaSnapshot => {
  const entries = Object.entries(config.tables);
  const [first] = entries;
  if (!first) {
    throw new Error("effect-sql-schema: schema must contain at least one table");
  }
  const dialect = first[1].dialect;
  const tableNameMap = new Map<AnyEffectSqlColumn, string>();
  for (const [, table] of entries) {
    const tableName = prefixedIdentifierName(config.prefix, table.sqlName ?? table.name);
    for (const column of Object.values(table.columns)) {
      tableNameMap.set(column, tableName);
    }
  }
  const tables: Record<string, TableSnapshot> = {};
  for (const [name, table] of entries) {
    if (table.dialect !== dialect) {
      throw new Error("effect-sql-schema: schema cannot mix Postgres and SQLite tables");
    }
    tables[name] = snapshotTable(table, tableNameMap, {
      prefix: config.prefix,
    });
  }
  return {
    version: snapshotVersion,
    dialect,
    tables,
    relationships: snapshotRelationships(config.relationships ?? {}),
  };
};

export const emptySnapshot = (dialect: "postgresql" | "sqlite"): SchemaSnapshot => ({
  version: snapshotVersion,
  dialect,
  tables: {},
  relationships: {},
});
