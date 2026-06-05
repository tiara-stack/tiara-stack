import { Effect, Option, Predicate, Schema, SchemaIssue, SchemaTransformation } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type {
  JsonValue,
  MigrationExtension,
  MigrationExtensionResult,
  ResolvedConfig,
} from "effect-sql-kit";
import type { EffectZeroSchema, EffectZeroTable } from "./types";

export type MigrationExtensionLike = MigrationExtension;

export type ZeroPublicationOptions = {
  readonly id?: string;
  readonly name?: string;
  readonly schema: EffectZeroSchema;
  readonly tableSchema?: string;
  readonly dropRemovedTables?: boolean;
};

type PublicationTableSnapshot = {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly string[];
};

type PublicationSnapshot = {
  readonly name: string;
  readonly tables: readonly PublicationTableSnapshot[];
};

const defaultPublicationName = "zero_data";
const defaultPublicationId = "default";
const defaultTableSchema = "public";

const PublicationTableSnapshotSchema = Schema.Struct({
  schema: Schema.String,
  name: Schema.String,
  columns: Schema.Array(Schema.String),
});

const PublicationSnapshotSchema = Schema.Struct({
  name: Schema.String,
  tables: Schema.Array(PublicationTableSnapshotSchema),
});

const PgTextArraySchema = Schema.Union([
  Schema.Array(Schema.String),
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String),
      SchemaTransformation.transformOrFail<readonly string[], string>({
        decode: (value) => {
          if (!value.startsWith("{") || !value.endsWith("}")) {
            return Effect.fail(
              new SchemaIssue.InvalidValue(Option.some(value), {
                message: "Expected a Postgres text array",
              }),
            );
          }
          const inner = value.slice(1, -1);
          return Effect.succeed(inner.length === 0 ? [] : inner.split(","));
        },
        encode: (value) => Effect.succeed(`{${value.join(",")}}`),
      }),
    ),
  ),
]);

const PublicationRowSchema = Schema.Struct({
  publication_name: Schema.String,
  puballtables: Schema.Boolean,
  publication_schemas: PgTextArraySchema,
  table_schema: Schema.NullOr(Schema.String),
  table_name: Schema.NullOr(Schema.String),
  columns: PgTextArraySchema,
});

type PublicationRow = Schema.Schema.Type<typeof PublicationRowSchema>;

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

const tableSql = (table: PublicationTableSnapshot): string =>
  `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)} (${table.columns
    .map(quoteIdentifier)
    .join(", ")})`;

const createPublicationSql = (snapshot: PublicationSnapshot): string =>
  `CREATE PUBLICATION ${quoteIdentifier(snapshot.name)} FOR TABLE\n  ${snapshot.tables
    .map(tableSql)
    .join(",\n  ")};`;

const addTableSql = (
  publicationName: string,
  tables: readonly PublicationTableSnapshot[],
): string =>
  `ALTER PUBLICATION ${quoteIdentifier(publicationName)} ADD TABLE\n  ${tables
    .map(tableSql)
    .join(",\n  ")};`;

const dropTableSql = (
  publicationName: string,
  tables: readonly PublicationTableSnapshot[],
): string =>
  `ALTER PUBLICATION ${quoteIdentifier(publicationName)} DROP TABLE\n  ${tables
    .map((table) => `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`)
    .join(",\n  ")};`;

const setTableSql = (snapshot: PublicationSnapshot): string =>
  `ALTER PUBLICATION ${quoteIdentifier(snapshot.name)} SET TABLE\n  ${snapshot.tables
    .map(tableSql)
    .join(",\n  ")};`;

const isRecord = (value: unknown): value is Record<string, unknown> => Predicate.isObject(value);

const decodePublicationSnapshot = (value: unknown): PublicationSnapshot | undefined => {
  const result = Schema.decodeUnknownOption(PublicationSnapshotSchema)(value);
  return result._tag === "Some" ? result.value : undefined;
};

const tableKey = (table: PublicationTableSnapshot): string => `${table.schema}.${table.name}`;

const sameColumns = (left: PublicationTableSnapshot, right: PublicationTableSnapshot): boolean =>
  left.columns.length === right.columns.length &&
  left.columns.every((column, index) => right.columns[index] === column);

const columnName = (fieldName: string, config: unknown): string | undefined => {
  if (config === false) {
    return undefined;
  }
  if (isRecord(config)) {
    const serverName = config.serverName;
    const name = config.name;
    if (typeof serverName === "string") {
      return serverName;
    }
    if (typeof name === "string") {
      return name;
    }
  }
  return fieldName;
};

const publicationTable = (
  table: EffectZeroTable,
  tableSchema: string,
): PublicationTableSnapshot => {
  const columnConfigs = table.columns ?? {};
  const columns = Object.keys(table.model.fields)
    .flatMap((fieldName) => {
      const name = columnName(fieldName, columnConfigs[fieldName]);
      return name ? [name] : [];
    })
    .sort((left, right) => left.localeCompare(right));

  return {
    schema: tableSchema,
    name: table.serverName ?? table.name,
    columns,
  };
};

const buildSnapshot = (options: Required<ZeroPublicationOptions>): PublicationSnapshot => {
  const name = options.name.trim();
  if (!name) {
    throw new Error("effect-zero: publication name cannot be empty");
  }

  const tables = Object.values(options.schema.tables)
    .map((table) => publicationTable(table, options.tableSchema))
    .sort((left, right) => tableKey(left).localeCompare(tableKey(right)));

  if (tables.length === 0) {
    throw new Error("effect-zero: publication requires at least one table");
  }
  const emptyTable = tables.find((table) => table.columns.length === 0);
  if (emptyTable) {
    throw new Error(
      `effect-zero: publication table ${emptyTable.schema}.${emptyTable.name} requires at least one column`,
    );
  }

  return Schema.decodeUnknownSync(PublicationSnapshotSchema)({ name, tables });
};

const generateStatements = ({
  previous,
  current,
  dropRemovedTables,
}: {
  readonly previous?: PublicationSnapshot;
  readonly current: PublicationSnapshot;
  readonly dropRemovedTables: boolean;
}): MigrationExtensionResult => {
  if (!previous) {
    return { statements: [{ sql: createPublicationSql(current) }], snapshot: current as JsonValue };
  }

  if (previous.name !== current.name) {
    return {
      statements: [
        { sql: `DROP PUBLICATION IF EXISTS ${quoteIdentifier(previous.name)};`, destructive: true },
        { sql: createPublicationSql(current) },
      ],
      snapshot: current as JsonValue,
    };
  }

  const previousTables = new Map(previous.tables.map((table) => [tableKey(table), table]));
  const currentTables = new Map(current.tables.map((table) => [tableKey(table), table]));
  const added = current.tables.filter((table) => !previousTables.has(tableKey(table)));
  const removed = previous.tables.filter((table) => !currentTables.has(tableKey(table)));
  const retainedRemoved = dropRemovedTables ? [] : removed;
  const effectiveCurrent: PublicationSnapshot = {
    ...current,
    tables: [...current.tables, ...retainedRemoved].sort((left, right) =>
      tableKey(left).localeCompare(tableKey(right)),
    ),
  };
  const changedColumns = current.tables.some((table) => {
    const previousTable = previousTables.get(tableKey(table));
    return previousTable ? !sameColumns(previousTable, table) : false;
  });

  if (changedColumns) {
    const removesTables = dropRemovedTables && removed.length > 0;
    return {
      statements: [
        {
          sql: setTableSql(dropRemovedTables ? current : effectiveCurrent),
          ...(removesTables ? { destructive: true } : {}),
        },
      ],
      snapshot: (dropRemovedTables ? current : effectiveCurrent) as JsonValue,
    };
  }

  const statements: MigrationExtensionResult["statements"][number][] = [];
  if (added.length > 0) {
    statements.push({ sql: addTableSql(current.name, added) });
  }
  if (dropRemovedTables && removed.length > 0) {
    statements.push({
      sql: dropTableSql(current.name, removed),
      destructive: true,
    });
  }
  return {
    statements,
    snapshot: effectiveCurrent as JsonValue,
  };
};

const introspectPublication = (publicationName: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<PublicationRow>(
      `select
  p.pubname as publication_name,
  p.puballtables,
  coalesce(
    (
      select array_agg(pn_ns.nspname order by pn_ns.nspname)
      from pg_publication_namespace pn
      join pg_namespace pn_ns on pn_ns.oid = pn.pnnspid
      where pn.pnpubid = p.oid
    ),
    array[]::text[]
  ) as publication_schemas,
  ns.nspname as table_schema,
  c.relname as table_name,
  coalesce(
    array_agg(a.attname order by a.attname) filter (where a.attname is not null),
    array[]::text[]
  ) as columns
from pg_publication p
left join pg_publication_rel pr on pr.prpubid = p.oid
left join pg_class c on c.oid = pr.prrelid
left join pg_namespace ns on ns.oid = c.relnamespace
left join lateral unnest(pr.prattrs) as attr(attnum) on true
left join pg_attribute a on a.attrelid = c.oid and a.attnum = attr.attnum
where p.pubname = $1
group by p.oid, p.pubname, p.puballtables, ns.nspname, c.relname
order by ns.nspname, c.relname`,
      [publicationName],
    );

    if (rows.length === 0) {
      return undefined;
    }

    const decodedRows = yield* Effect.forEach(rows, (row) =>
      Schema.decodeUnknownEffect(PublicationRowSchema)(row).pipe(
        Effect.mapError(
          (error) =>
            new Error(
              `effect-zero: invalid publication introspection row for ${publicationName}: ${String(error)}`,
            ),
        ),
      ),
    );
    if (decodedRows.some((row) => row.puballtables)) {
      return yield* Effect.fail(
        new Error(
          `effect-zero: publication ${publicationName} uses FOR ALL TABLES, which zeroPublication push cannot diff`,
        ),
      );
    }
    const publicationSchemas = [
      ...new Set(decodedRows.flatMap((row) => row.publication_schemas)),
    ].sort((left, right) => left.localeCompare(right));
    if (publicationSchemas.length > 0) {
      return yield* Effect.fail(
        new Error(
          `effect-zero: publication ${publicationName} uses schema-level publication entries (${publicationSchemas.join(", ")}), which zeroPublication push cannot diff`,
        ),
      );
    }

    const snapshot = {
      name: publicationName,
      tables: decodedRows
        .filter(
          (
            row,
          ): row is PublicationRow & {
            readonly table_schema: string;
            readonly table_name: string;
          } => typeof row.table_schema === "string" && typeof row.table_name === "string",
        )
        .map((row) => ({
          schema: row.table_schema,
          name: row.table_name,
          columns: [...row.columns].sort((left, right) => left.localeCompare(right)),
        }))
        .sort((left, right) => tableKey(left).localeCompare(tableKey(right))),
    };

    return Schema.decodeUnknownSync(PublicationSnapshotSchema)(snapshot) as JsonValue;
  });
export const zeroPublication = (options: ZeroPublicationOptions): MigrationExtensionLike => {
  const resolved = {
    id: options.id ?? defaultPublicationId,
    name: options.name ?? defaultPublicationName,
    schema: options.schema,
    tableSchema: options.tableSchema ?? defaultTableSchema,
    dropRemovedTables: options.dropRemovedTables ?? true,
  };
  const snapshotKey = `effect-zero:publication:${resolved.id}`;

  return {
    _tag: "EffectSqlKitMigrationExtension",
    name: snapshotKey,
    generate: (context) => {
      if (context.config.dialect !== "postgresql") {
        throw new Error("effect-zero: zeroPublication only supports PostgreSQL migrations");
      }

      const current = buildSnapshot(resolved);
      const previous = decodePublicationSnapshot(context.previousExtensions[snapshotKey]);
      return generateStatements({
        previous,
        current,
        dropRemovedTables: resolved.dropRemovedTables,
      });
    },
    introspect: (context: { readonly config: ResolvedConfig }) => {
      if (context.config.dialect !== "postgresql") {
        throw new Error("effect-zero: zeroPublication only supports PostgreSQL migrations");
      }

      return introspectPublication(resolved.name);
    },
  } as MigrationExtensionLike;
};
