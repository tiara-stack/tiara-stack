/**
 * Server-authoritative Sheet Zero test database.
 *
 * This test-only entry point executes the real generated queries and mutators
 * against PGlite. It intentionally does not model reactive views, sync, or the
 * optimistic client mutation phase.
 */
import { PGlite } from "@electric-sql/pglite";
import type {
  HumanReadable,
  MutateRequest,
  Query,
  QueryOrQueryRequest,
  QueryRequest,
} from "@rocicorp/zero";
import { zeroDrizzle } from "@rocicorp/zero/server/adapters/drizzle";
import { drizzle } from "drizzle-orm/pglite";
import { Data, Effect, Predicate, Schema, Scope } from "effect";
import {
  snapshotSchema,
  type ColumnSnapshot,
  type SchemaSnapshot,
} from "effect-sql-schema/snapshot";
import type { ZeroClient } from "typhoon-zero/client";
import {
  configUserPlatform,
  configWorkspace,
  configWorkspaceConversation,
  configWorkspaceFeatureFlag,
  configWorkspaceMonitorRole,
  configWorkspaceTeamSubmissionChannel,
  configWorkspaceUpdateAnnouncementDelivery,
  messageCheckin,
  messageCheckinMember,
  messageRoomOrder,
  messageRoomOrderEntry,
  messageSlot,
  messageTeamSubmission,
  sheetApisDispatchJobs,
} from "./models";
import { schema as canonicalSchema } from "./schema";
import { builder, schema as zeroSchema, type Schema as SheetZeroSchema } from "./zero/schema";

type Insert<Model extends { readonly insert: Schema.Top }> = Schema.Schema.Type<Model["insert"]>;
type Row<Model extends { readonly json: Schema.Top }> = Schema.Schema.Type<Model["json"]>;

export interface SheetSeeds {
  readonly configUserPlatform?: ReadonlyArray<Insert<typeof configUserPlatform>>;
  readonly configWorkspace?: ReadonlyArray<Insert<typeof configWorkspace>>;
  readonly configWorkspaceConversation?: ReadonlyArray<Insert<typeof configWorkspaceConversation>>;
  readonly configWorkspaceFeatureFlag?: ReadonlyArray<Insert<typeof configWorkspaceFeatureFlag>>;
  readonly configWorkspaceMonitorRole?: ReadonlyArray<Insert<typeof configWorkspaceMonitorRole>>;
  readonly configWorkspaceTeamSubmissionChannel?: ReadonlyArray<
    Insert<typeof configWorkspaceTeamSubmissionChannel>
  >;
  readonly configWorkspaceUpdateAnnouncementDelivery?: ReadonlyArray<
    Insert<typeof configWorkspaceUpdateAnnouncementDelivery>
  >;
  readonly messageCheckin?: ReadonlyArray<Insert<typeof messageCheckin>>;
  readonly messageCheckinMember?: ReadonlyArray<Insert<typeof messageCheckinMember>>;
  readonly messageRoomOrder?: ReadonlyArray<Insert<typeof messageRoomOrder>>;
  readonly messageRoomOrderEntry?: ReadonlyArray<Insert<typeof messageRoomOrderEntry>>;
  readonly messageSlot?: ReadonlyArray<Insert<typeof messageSlot>>;
  readonly messageTeamSubmission?: ReadonlyArray<Insert<typeof messageTeamSubmission>>;
  readonly sheetApisDispatchJobs?: ReadonlyArray<Insert<typeof sheetApisDispatchJobs>>;
}

export interface SheetRows {
  readonly configUserPlatform: Row<typeof configUserPlatform>;
  readonly configWorkspace: Row<typeof configWorkspace>;
  readonly configWorkspaceConversation: Row<typeof configWorkspaceConversation>;
  readonly configWorkspaceFeatureFlag: Row<typeof configWorkspaceFeatureFlag>;
  readonly configWorkspaceMonitorRole: Row<typeof configWorkspaceMonitorRole>;
  readonly configWorkspaceTeamSubmissionChannel: Row<typeof configWorkspaceTeamSubmissionChannel>;
  readonly configWorkspaceUpdateAnnouncementDelivery: Row<
    typeof configWorkspaceUpdateAnnouncementDelivery
  >;
  readonly messageCheckin: Row<typeof messageCheckin>;
  readonly messageCheckinMember: Row<typeof messageCheckinMember>;
  readonly messageRoomOrder: Row<typeof messageRoomOrder>;
  readonly messageRoomOrderEntry: Row<typeof messageRoomOrderEntry>;
  readonly messageSlot: Row<typeof messageSlot>;
  readonly messageTeamSubmission: Row<typeof messageTeamSubmission>;
  readonly sheetApisDispatchJobs: Row<typeof sheetApisDispatchJobs>;
}

export type SheetTableName = keyof SheetSeeds;

export class TestDatabaseError extends Data.TaggedError("TestDatabaseError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface TestDatabaseTimings {
  readonly startupMs: number;
  readonly bootstrapMs: number;
  readonly truncateResetMs: number | undefined;
  readonly rollbackRoundTripMs: number | undefined;
}

export interface TestSheetZeroDatabase<Context> {
  readonly executor: ZeroClient.ZeroClientExecutor<SheetZeroSchema, Context>;
  readonly timings: TestDatabaseTimings;
  readonly seed: (seeds: SheetSeeds) => Effect.Effect<void, TestDatabaseError>;
  readonly rows: <K extends SheetTableName>(
    table: K,
  ) => Effect.Effect<ReadonlyArray<SheetRows[K]>, TestDatabaseError>;
  readonly reset: Effect.Effect<void, TestDatabaseError>;
  readonly close: Effect.Effect<void>;
}

export interface TestSheetZeroDatabaseOptions<Context> {
  readonly seeds?: SheetSeeds | undefined;
  readonly context?: Context | undefined;
  /** Run reset-strategy microbenchmarks during acquisition. Disabled for normal suites. */
  readonly measureTimings?: boolean | undefined;
}

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

const sqlType = (column: ColumnSnapshot): string => {
  const types: Readonly<Record<string, string>> = {
    boolean: "boolean",
    integer: "integer",
    jsonb: "jsonb",
    real: "real",
    text: "text",
    timestamp: column.config?.withTimezone ? "timestamp with time zone" : "timestamp",
    uuid: "uuid",
    varchar: "varchar",
  };
  if (column.kind === "array" && column.config?.elementKind === "varchar") {
    return "varchar[]";
  }
  const type = types[column.kind];
  if (!type) {
    throw new TypeError(`Unsupported test DDL column kind: ${column.kind}`);
  }
  return type;
};

const literal = (value: string | number | boolean | null): string => {
  if (value === null) return "null";
  if (Predicate.isString(value)) return `'${value.replaceAll("'", "''")}'`;
  return String(value);
};

const columnDefinition = (column: ColumnSnapshot): string => {
  const parts = [quote(column.name), sqlType(column)];
  if (column.notNull) parts.push("not null");
  if (column.unique) {
    if (Predicate.isString(column.unique)) parts.push(`constraint ${quote(column.unique)} unique`);
    else parts.push("unique");
  }
  if (column.default !== undefined) parts.push(`default ${literal(column.default)}`);
  else if (column.defaultSql !== undefined) parts.push(`default ${column.defaultSql}`);
  return parts.join(" ");
};

const canonicalSchemaSnapshot = snapshotSchema(canonicalSchema);

export const canonicalSnapshot = (): SchemaSnapshot => canonicalSchemaSnapshot;

/** Stable structural projection used to detect test-DDL drift from stored migrations. */
export const ddlParityShape = (snapshot: SchemaSnapshot) =>
  Object.fromEntries(
    Object.entries(snapshot.tables)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, table]) => [
        key,
        {
          name: table.name,
          columns: Object.fromEntries(
            Object.entries(table.columns)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([field, column]) => [
                field,
                {
                  name: column.name,
                  kind: column.kind,
                  notNull: column.notNull,
                  primaryKey: column.primaryKey,
                  unique: column.unique,
                  default: column.default,
                  defaultSql: column.defaultSql,
                  references: column.references,
                  config: column.config,
                },
              ]),
          ),
          primaryKey: table.primaryKey,
          indexes: table.indexes,
        },
      ]),
  );

export const testDdlIntentionalDifferences = [
  "PostgreSQL publication CREATE/ALTER statements are replication setup, not schema structure.",
  "Migration-only DM invariant CHECK constraints are absent from canonical snapshot metadata.",
  "Partial-index predicates cannot currently be represented by effect-sql-schema snapshots.",
] as const;

export const makeCanonicalDdl = (
  snapshot: SchemaSnapshot = canonicalSnapshot(),
): ReadonlyArray<string> => {
  const tablesAndIndexes = Object.values(snapshot.tables).flatMap((table) => {
    const columns = Object.values(table.columns).map(columnDefinition);
    const primaryKey = table.primaryKey.map((field) => quote(table.columns[field]!.name));
    const constraints = primaryKey.length > 0 ? [`primary key (${primaryKey.join(", ")})`] : [];
    const createTable = `create table ${quote(table.name)} (${[...columns, ...constraints].join(", ")})`;
    const indexes = table.indexes.map((index) => {
      const fields = index.fields.map((field) => quote(table.columns[field]!.name));
      return `create ${index.unique ? "unique " : ""}index ${quote(index.name)} on ${quote(table.name)} (${fields.join(", ")})`;
    });
    return [createTable, ...indexes];
  });
  const references = Object.values(snapshot.tables).flatMap((table) =>
    Object.values(table.columns).flatMap((column) => {
      if (!column.references) return [];
      const actions = [
        column.references.onDelete ? `on delete ${column.references.onDelete}` : "",
        column.references.onUpdate ? `on update ${column.references.onUpdate}` : "",
      ]
        .filter(Predicate.isTruthy)
        .join(" ");
      return [
        `alter table ${quote(table.name)} add foreign key (${quote(column.name)}) references ${quote(column.references.table)} (${quote(column.references.column)})${actions ? ` ${actions}` : ""}`,
      ];
    }),
  );
  return [...tablesAndIndexes, ...references];
};

export const canonicalTableNames = Object.values(canonicalSnapshot().tables).map(
  ({ name }) => name,
);

export const truncateCanonicalTablesSql = `truncate table ${canonicalTableNames
  .map(quote)
  .join(", ")} cascade`;

const isQueryRequest = <Context, Return>(
  request: QueryOrQueryRequest<any, any, any, SheetZeroSchema, Return, Context>,
): request is QueryRequest<any, any, any, SheetZeroSchema, Return, Context> =>
  Predicate.hasProperty(request, "~") && request["~"] === "QueryRequest";

type DynamicTransaction = {
  readonly mutate: Record<
    string,
    { readonly insert: (row: Readonly<Record<string, unknown>>) => Promise<void> }
  >;
};

type DynamicBuilder = Record<string, unknown>;

const databaseError = (operation: string) => (cause: unknown) =>
  new TestDatabaseError({ operation, cause });

export const makeTestSheetZeroDatabase = <Context = undefined>(
  options: TestSheetZeroDatabaseOptions<Context> = {},
): Effect.Effect<TestSheetZeroDatabase<Context>, TestDatabaseError, Scope.Scope> =>
  Effect.gen(function* () {
    const startupStartedAt = performance.now();
    let closed = false;
    const pg = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => PGlite.create("memory://"),
        catch: databaseError("start PGlite"),
      }),
      (database) =>
        Effect.suspend(() => {
          if (closed) return Effect.void;
          closed = true;
          return Effect.promise(() => database.close());
        }),
    );
    const startupMs = performance.now() - startupStartedAt;
    const bootstrapStartedAt = performance.now();
    yield* Effect.tryPromise({
      try: async () => {
        for (const statement of makeCanonicalDdl()) await pg.exec(statement);
      },
      catch: databaseError("bootstrap schema"),
    });
    const bootstrapMs = performance.now() - bootstrapStartedAt;

    const db = drizzle({ client: pg });
    const zqlDb = zeroDrizzle(zeroSchema, db);
    const context = options.context as Context;

    let truncateResetMs: number | undefined;
    let rollbackRoundTripMs: number | undefined;
    if (options.measureTimings) {
      const resetSamples = 10;
      const truncateStartedAt = performance.now();
      for (let index = 0; index < resetSamples; index++) {
        yield* Effect.tryPromise({
          try: () => pg.exec(truncateCanonicalTablesSql),
          catch: databaseError("benchmark truncate reset"),
        });
      }
      truncateResetMs = (performance.now() - truncateStartedAt) / resetSamples;
      const rollbackStartedAt = performance.now();
      for (let index = 0; index < resetSamples; index++) {
        yield* Effect.tryPromise({
          try: async () => {
            await pg.exec("begin");
            await pg.exec("rollback");
          },
          catch: databaseError("benchmark rollback reset"),
        });
      }
      rollbackRoundTripMs = (performance.now() - rollbackStartedAt) / resetSamples;
    }

    const executor: ZeroClient.ZeroClientExecutor<SheetZeroSchema, Context> = {
      run: <Return>(
        request: QueryOrQueryRequest<any, any, any, SheetZeroSchema, Return, Context>,
      ) =>
        Effect.promise(async () => {
          const query = isQueryRequest(request)
            ? request.query.fn({ args: request.args, ctx: context })
            : request;
          return (await zqlDb.run(query)) as HumanReadable<Return>;
        }),
      mutate: (request: MutateRequest<any, SheetZeroSchema, Context, any>) =>
        Effect.succeed({
          /** PGlite models authoritative server execution, not optimistic cache writes. */
          client: () => Effect.void,
          server: () =>
            Effect.promise(() =>
              zqlDb.transaction((tx) =>
                request.mutator.fn({ args: request.args, ctx: context, tx }),
              ),
            ),
        }),
    };

    const seed = (seeds: SheetSeeds) =>
      Effect.tryPromise({
        try: () =>
          zqlDb.transaction(async (tx) => {
            const dynamic = tx as unknown as DynamicTransaction;
            for (const [table, rows] of Object.entries(seeds)) {
              if (!rows) continue;
              for (const row of rows) {
                await dynamic.mutate[table]!.insert(row as Readonly<Record<string, unknown>>);
              }
            }
          }),
        catch: databaseError("seed rows"),
      });

    const rows = <K extends SheetTableName>(table: K) =>
      Effect.tryPromise({
        try: () =>
          zqlDb.run(
            (builder as unknown as DynamicBuilder)[table] as Query<
              any,
              SheetZeroSchema,
              SheetRows[K]
            >,
          ) as Promise<ReadonlyArray<SheetRows[K]>>,
        catch: databaseError(`read ${table} rows`),
      });

    const reset = Effect.tryPromise({
      try: () => pg.exec(truncateCanonicalTablesSql),
      catch: databaseError("reset tables"),
    }).pipe(Effect.asVoid);
    const close = Effect.suspend(() => {
      if (closed) return Effect.void;
      closed = true;
      return Effect.promise(() => pg.close());
    });

    const testDb = {
      executor,
      timings: { startupMs, bootstrapMs, truncateResetMs, rollbackRoundTripMs },
      seed,
      rows,
      reset,
      close,
    } satisfies TestSheetZeroDatabase<Context>;
    if (options.seeds) yield* seed(options.seeds);
    return testDb;
  });
