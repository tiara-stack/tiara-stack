import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type {
  JsonValue,
  MigrationExtension,
  MigrationExtensionContext,
  MigrationExtensionResult,
  ResolvedConfig,
} from "effect-sql-kit";
import { describe, expect, it } from "@effect/vitest";
import { schema } from "./schema";
import { table } from "./table";
import { zeroPublication } from "./publication";

const model = {
  fields: {
    id: Schema.String,
    name: Schema.String,
    secret: Schema.String,
  },
};

const config = (dialect: "postgresql" | "sqlite" = "postgresql"): ResolvedConfig => ({
  dialect,
  out: "./migrations",
  prefix: "",
  migrations: {
    table: "effect_sql_migrations",
    schema: "public",
  },
  breakpoints: true,
  extensions: [],
});

const context = (
  previousExtensions: Readonly<Record<string, JsonValue>> = {},
  dialect: "postgresql" | "sqlite" = "postgresql",
): MigrationExtensionContext => ({
  config: config(dialect),
  schema: {} as never,
  previous: {} as never,
  current: {} as never,
  previousExtensions,
});

const publicationKey = "effect-zero:publication:default";

const generate = (
  extension: MigrationExtension,
  previousExtensions?: Readonly<Record<string, JsonValue>>,
): MigrationExtensionResult =>
  extension.generate(context(previousExtensions)) as MigrationExtensionResult;

type IntrospectableMigrationExtension = MigrationExtension & {
  readonly introspect: (
    context: MigrationExtensionContext,
  ) =>
    | JsonValue
    | undefined
    | Promise<JsonValue | undefined>
    | Effect.Effect<JsonValue | undefined, unknown, SqlClient.SqlClient>;
};

const fakeSql = (rows: readonly unknown[]): SqlClient.SqlClient =>
  ({
    unsafe: () => Effect.succeed(rows),
  }) as unknown as SqlClient.SqlClient;

const introspect = (
  extension: MigrationExtension,
  rows: readonly unknown[],
): Promise<JsonValue | undefined> => {
  const introspectable = extension as IntrospectableMigrationExtension;
  if (!introspectable.introspect) {
    throw new Error("expected extension to define introspect");
  }
  const result = introspectable.introspect(context());
  if (!Effect.isEffect(result)) {
    return Promise.resolve(result);
  }
  return Effect.runPromise(
    result.pipe(Effect.provideService(SqlClient.SqlClient, fakeSql(rows))) as Effect.Effect<
      JsonValue | undefined
    >,
  );
};

describe("zeroPublication", () => {
  it("creates an initial publication from Zero schema columns", () => {
    const users = table(model, {
      name: "users",
      serverName: "app_users",
      key: ["id"],
      columns: {
        name: { serverName: "display_name" },
        secret: false,
      },
    });

    const result = generate(
      zeroPublication({
        schema: schema({ users }),
      }),
    );

    expect(result.statements.map((statement) => statement.sql)).toEqual([
      'CREATE PUBLICATION "zero_data" FOR TABLE\n  "public"."app_users" ("display_name", "id");',
    ]);
  });

  it("orders tables and columns deterministically and quotes identifiers", () => {
    const users = table(model, {
      name: "users",
      serverName: 'app_"users',
      key: ["id"],
      columns: {
        name: { serverName: 'display_"name' },
        secret: false,
      },
    });
    const accounts = table(model, {
      name: "accounts",
      serverName: "app_accounts",
      key: ["id"],
      columns: {
        secret: false,
      },
    });

    const result = generate(
      zeroPublication({
        name: "zero_data",
        schema: schema({ users, accounts }),
        tableSchema: 'tenant_"one',
      }),
    );

    expect(result.statements.map((statement) => statement.sql)).toEqual([
      'CREATE PUBLICATION "zero_data" FOR TABLE\n  "tenant_""one"."app_""users" ("display_""name", "id"),\n  "tenant_""one"."app_accounts" ("id", "name");',
    ]);
  });

  it("sets the full table list when existing table columns change", () => {
    const users = table(model, {
      name: "users",
      key: ["id"],
      columns: {
        secret: false,
      },
    });
    const extension = zeroPublication({ schema: schema({ users }) });
    const first = generate(extension);
    const nextUsers = table(model, {
      name: "users",
      key: ["id"],
      columns: {
        name: false,
        secret: false,
      },
    });

    const second = generate(zeroPublication({ schema: schema({ users: nextUsers }) }), {
      [publicationKey]: first.snapshot,
    });

    expect(second.statements.map((statement) => statement.sql)).toEqual([
      'ALTER PUBLICATION "zero_data" SET TABLE\n  "public"."users" ("id");',
    ]);
  });

  it("adds and drops tables when the table set changes", () => {
    const users = table(model, { name: "users", key: ["id"] });
    const accounts = table(model, { name: "accounts", key: ["id"] });
    const first = generate(zeroPublication({ schema: schema({ users }) }));

    const added = generate(zeroPublication({ schema: schema({ users, accounts }) }), {
      [publicationKey]: first.snapshot,
    });
    expect(added.statements.map((statement) => statement.sql)).toEqual([
      'ALTER PUBLICATION "zero_data" ADD TABLE\n  "public"."accounts" ("id", "name", "secret");',
    ]);

    const removed = generate(zeroPublication({ schema: schema({ users }) }), {
      [publicationKey]: added.snapshot,
    });
    expect(removed.statements.map((statement) => statement.sql)).toEqual([
      'ALTER PUBLICATION "zero_data" DROP TABLE\n  "public"."accounts";',
    ]);
  });

  it("drops and creates a publication when the publication name changes", () => {
    const users = table(model, { name: "users", key: ["id"] });
    const first = generate(zeroPublication({ name: "old_publication", schema: schema({ users }) }));

    const second = generate(
      zeroPublication({ name: "new_publication", schema: schema({ users }) }),
      { [publicationKey]: first.snapshot },
    );

    expect(second.statements.map((statement) => statement.sql)).toEqual([
      'DROP PUBLICATION IF EXISTS "old_publication";',
      'CREATE PUBLICATION "new_publication" FOR TABLE\n  "public"."users" ("id", "name", "secret");',
    ]);
  });

  it("does not drop removed tables through SET TABLE when dropRemovedTables is false", () => {
    const users = table(model, {
      name: "users",
      key: ["id"],
      columns: {
        secret: false,
      },
    });
    const accounts = table(model, { name: "accounts", key: ["id"] });
    const first = generate(
      zeroPublication({
        schema: schema({ users, accounts }),
        dropRemovedTables: false,
      }),
    );
    const nextUsers = table(model, {
      name: "users",
      key: ["id"],
      columns: {
        name: false,
        secret: false,
      },
    });

    const second = generate(
      zeroPublication({
        schema: schema({ users: nextUsers }),
        dropRemovedTables: false,
      }),
      { [publicationKey]: first.snapshot },
    );

    expect(second.statements.map((statement) => statement.sql)).toEqual([
      'ALTER PUBLICATION "zero_data" SET TABLE\n  "public"."accounts" ("id", "name", "secret"),\n  "public"."users" ("id");',
    ]);
  });

  it("marks SET TABLE destructive when it removes tables", () => {
    const users = table(model, {
      name: "users",
      key: ["id"],
      columns: {
        secret: false,
      },
    });
    const accounts = table(model, { name: "accounts", key: ["id"] });
    const first = generate(
      zeroPublication({
        schema: schema({ users, accounts }),
      }),
    );
    const nextUsers = table(model, {
      name: "users",
      key: ["id"],
      columns: {
        name: false,
        secret: false,
      },
    });

    const second = generate(zeroPublication({ schema: schema({ users: nextUsers }) }), {
      [publicationKey]: first.snapshot,
    });

    expect(second.statements).toEqual([
      {
        sql: 'ALTER PUBLICATION "zero_data" SET TABLE\n  "public"."users" ("id");',
        destructive: true,
      },
    ]);
  });

  it("rejects unsupported dialects and invalid publication inputs", () => {
    const users = table(model, { name: "users", key: ["id"] });

    expect(() =>
      zeroPublication({ schema: schema({ users }) }).generate({
        ...context({}, "sqlite"),
        previousExtensions: {},
      }),
    ).toThrow("effect-zero: zeroPublication only supports PostgreSQL migrations");

    expect(() =>
      zeroPublication({ name: " ", schema: schema({ users }) }).generate(context()),
    ).toThrow("effect-zero: publication name cannot be empty");

    expect(() => zeroPublication({ schema: schema({}) }).generate(context())).toThrow(
      "effect-zero: publication requires at least one table",
    );
  });

  it("rejects tables with no publishable columns", () => {
    const users = table(model, {
      name: "users",
      key: ["id"],
      columns: {
        id: false,
        name: false,
        secret: false,
      },
    });

    expect(() => zeroPublication({ schema: schema({ users }) }).generate(context())).toThrow(
      "effect-zero: publication table public.users requires at least one column",
    );
  });

  it("introspects undefined when the publication does not exist", async () => {
    const users = table(model, { name: "users", key: ["id"] });
    const extension = zeroPublication({ schema: schema({ users }) });

    await expect(introspect(extension, [])).resolves.toBeUndefined();
  });

  it("introspects existing publication tables and columns deterministically", async () => {
    const users = table(model, { name: "users", key: ["id"] });
    const extension = zeroPublication({ schema: schema({ users }) });

    await expect(
      introspect(extension, [
        {
          publication_name: "zero_data",
          puballtables: false,
          publication_schemas: [],
          table_schema: "public",
          table_name: "users",
          columns: ["secret", "id", "name"],
        },
        {
          publication_name: "zero_data",
          puballtables: false,
          publication_schemas: [],
          table_schema: "public",
          table_name: "accounts",
          columns: ["name", "id"],
        },
      ]),
    ).resolves.toEqual({
      name: "zero_data",
      tables: [
        {
          schema: "public",
          name: "accounts",
          columns: ["id", "name"],
        },
        {
          schema: "public",
          name: "users",
          columns: ["id", "name", "secret"],
        },
      ],
    });
  });

  it("does not emit statements when push introspection matches desired publication", async () => {
    const users = table(model, { name: "users", key: ["id"] });
    const extension = zeroPublication({ schema: schema({ users }) });
    const snapshot = await introspect(extension, [
      {
        publication_name: "zero_data",
        puballtables: false,
        publication_schemas: [],
        table_schema: "public",
        table_name: "users",
        columns: ["id", "name", "secret"],
      },
    ]);

    const result = generate(extension, { [publicationKey]: snapshot! });

    expect(result.statements).toEqual([]);
  });

  it("creates a publication when push introspection finds no publication", async () => {
    const users = table(model, { name: "users", key: ["id"] });
    const extension = zeroPublication({ schema: schema({ users }) });
    const snapshot = await introspect(extension, []);

    const result = generate(
      extension,
      snapshot === undefined ? {} : { [publicationKey]: snapshot },
    );

    expect(result.statements.map((statement) => statement.sql)).toEqual([
      'CREATE PUBLICATION "zero_data" FOR TABLE\n  "public"."users" ("id", "name", "secret");',
    ]);
  });

  it("rejects malformed publication introspection rows", async () => {
    const users = table(model, { name: "users", key: ["id"] });
    const extension = zeroPublication({ schema: schema({ users }) });

    await expect(
      introspect(extension, [
        {
          publication_name: "zero_data",
          puballtables: false,
          publication_schemas: [],
          table_schema: "public",
          table_name: "users",
          columns: null,
        },
      ]),
    ).rejects.toThrow("effect-zero: invalid publication introspection row for zero_data");
  });

  it("rejects all-tables and schema-level publication modes during push introspection", async () => {
    const users = table(model, { name: "users", key: ["id"] });
    const extension = zeroPublication({ schema: schema({ users }) });

    await expect(
      introspect(extension, [
        {
          publication_name: "zero_data",
          puballtables: true,
          publication_schemas: [],
          table_schema: null,
          table_name: null,
          columns: [],
        },
      ]),
    ).rejects.toThrow(
      "effect-zero: publication zero_data uses FOR ALL TABLES, which zeroPublication push cannot diff",
    );

    await expect(
      introspect(extension, [
        {
          publication_name: "zero_data",
          puballtables: false,
          publication_schemas: ["public"],
          table_schema: null,
          table_name: null,
          columns: [],
        },
      ]),
    ).rejects.toThrow(
      "effect-zero: publication zero_data uses schema-level publication entries (public), which zeroPublication push cannot diff",
    );
  });
});
