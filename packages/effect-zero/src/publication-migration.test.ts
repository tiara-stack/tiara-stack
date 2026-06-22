import { Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import type {
  JsonValue,
  MigrationExtensionContext,
  MigrationExtensionResult,
} from "effect-sql-kit";
import { zeroPublication } from "./publication";
import { schema } from "./schema";
import { table } from "./table";

const model = {
  fields: {
    id: Schema.String,
    name: Schema.String,
    secret: Schema.String,
  },
};

const context = (
  previousExtensions: Readonly<Record<string, JsonValue>> = {},
  statements: MigrationExtensionContext["statements"] = [],
): MigrationExtensionContext => ({
  config: {
    dialect: "postgresql",
    out: "./migrations",
    prefix: "",
    migrations: {
      table: "effect_sql_migrations",
      schema: "public",
    },
    breakpoints: true,
    extensions: [],
  },
  schema: {} as never,
  previous: {} as never,
  current: {} as never,
  statements,
  previousExtensions,
});

const generate = (
  previousExtensions?: Readonly<Record<string, JsonValue>>,
  statements?: MigrationExtensionContext["statements"],
): MigrationExtensionResult => {
  const users = table(model, {
    name: "users",
    key: ["id"],
    columns: {
      secret: false,
    },
  });
  const accounts = table(model, { name: "accounts", key: ["id"] });

  return zeroPublication({ schema: schema({ users, accounts }) }).generate(
    context(previousExtensions, statements),
  ) as MigrationExtensionResult;
};

const generateMixedCase = (
  previousExtensions?: Readonly<Record<string, JsonValue>>,
  statements?: MigrationExtensionContext["statements"],
): MigrationExtensionResult => {
  const myTable = table(model, {
    name: "myTable",
    serverName: "MyTable",
    key: ["id"],
    columns: {
      name: { serverName: "Name" },
      secret: false,
    },
  });

  return zeroPublication({ schema: schema({ myTable }) }).generate(
    context(previousExtensions, statements),
  ) as MigrationExtensionResult;
};

describe("zeroPublication migration wrappers", () => {
  it("temporarily drops affected tables before published column type changes", () => {
    const first = generate();
    const second = generate({ ["effect-zero:publication:default"]: first.snapshot }, [
      {
        sql: 'ALTER TABLE "users" ALTER COLUMN "name" TYPE jsonb USING "name"::jsonb;',
      },
    ]);

    expect(second.beforeStatements?.map((statement) => statement.sql)).toEqual([
      'ALTER PUBLICATION "zero_data" DROP TABLE\n  "public"."users";',
    ]);
    expect(second.statements.map((statement) => statement.sql)).toEqual([
      'ALTER PUBLICATION "zero_data" SET TABLE\n  "public"."accounts" ("id", "name", "secret"),\n  "public"."users" ("id", "name");',
    ]);
  });

  it("does not drop newly added tables before published column type changes", () => {
    const previousUsersOnly = {
      name: "zero_data",
      tables: [{ schema: "public", name: "users", columns: ["id", "name"] }],
    } satisfies JsonValue;
    const result = generate({ ["effect-zero:publication:default"]: previousUsersOnly }, [
      {
        sql: 'ALTER TABLE "accounts" ALTER COLUMN "name" TYPE jsonb USING "name"::jsonb;',
      },
    ]);

    expect(result.beforeStatements).toBeUndefined();
    expect(result.statements.map((statement) => statement.sql)).toEqual([
      'ALTER PUBLICATION "zero_data" ADD TABLE\n  "public"."accounts" ("id", "name", "secret");',
    ]);
  });

  it("matches lowercase generated SQL to mixed-case publication snapshots", () => {
    const first = generateMixedCase();
    const second = generateMixedCase({ ["effect-zero:publication:default"]: first.snapshot }, [
      {
        sql: 'ALTER TABLE mytable ALTER COLUMN name TYPE jsonb USING "Name"::jsonb;',
      },
    ]);

    expect(second.beforeStatements?.map((statement) => statement.sql)).toEqual([
      'ALTER PUBLICATION "zero_data" DROP TABLE\n  "public"."MyTable";',
    ]);
  });
});
