import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "@effect/vitest";
import { buildPushStatementsEffect } from "./push";
import type { ResolvedConfig } from "../types";
import { emptySnapshot } from "../snapshot";

const schema = { _tag: "EffectSqlSchema", tables: {} } as never;
const live = emptySnapshot("postgresql");
const desired = emptySnapshot("postgresql");
const sql = {} as SqlClient.SqlClient;

const config = (extensions: ResolvedConfig["extensions"]): ResolvedConfig => ({
  dialect: "postgresql",
  out: "./migrations",
  prefix: "",
  migrations: {
    table: "effect_sql_migrations",
    schema: "public",
  },
  breakpoints: true,
  extensions,
});

describe("push statement builder", () => {
  it.effect("combines schema and extension statements", () =>
    Effect.gen(function* () {
      const statements = yield* buildPushStatementsEffect({
        config: config([
          {
            _tag: "EffectSqlKitMigrationExtension",
            name: "custom",
            generate: () => ({
              statements: [{ sql: "alter publication zero_data add table users" }],
              snapshot: { ok: true },
            }),
            introspect: () => ({ ok: false }),
          },
        ]),
        schema,
        live,
        desired,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));

      expect(statements).toEqual([{ sql: "alter publication zero_data add table users" }]);
    }),
  );

  it.effect("keeps unsupported extension statements in the returned statement list", () =>
    Effect.gen(function* () {
      const statements = yield* buildPushStatementsEffect({
        config: config([
          {
            _tag: "EffectSqlKitMigrationExtension",
            name: "custom",
            generate: () => ({
              statements: [
                {
                  sql: "",
                  unsupported: true,
                  reason: "unsupported extension statement",
                },
              ],
              snapshot: null,
            }),
          },
        ]),
        schema,
        live,
        desired,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));

      expect(statements).toEqual([
        {
          sql: "",
          unsupported: true,
          reason: "unsupported extension statement",
        },
      ]);
    }),
  );
});
