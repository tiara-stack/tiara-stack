import { Effect, Exit } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "@effect/vitest";
import { introspectMigrationExtensionsEffect, runMigrationExtensionsEffect } from "./extensions";
import type { ResolvedConfig } from "../types";
import { emptySnapshot } from "../snapshot";

const schema = { _tag: "EffectSqlSchema", tables: {} } as never;
const previous = emptySnapshot("postgresql");
const current = emptySnapshot("postgresql");
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

describe("migration extension helpers", () => {
  it.effect("rejects duplicate extension names", () =>
    Effect.gen(function* () {
      const extension = {
        _tag: "EffectSqlKitMigrationExtension" as const,
        name: "duplicate",
        generate: () => ({ statements: [], snapshot: null }),
      };

      const exit = yield* Effect.exit(
        runMigrationExtensionsEffect({
          config: config([extension, extension]),
          schema,
          previous,
          current,
          previousExtensions: {},
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(Exit.isFailure(exit) ? String(exit.cause) : "").toContain(
        "effect-sql-kit: duplicate migration extension name(s): duplicate",
      );
    }),
  );

  it.effect("runs extension generation and decodes snapshots", () =>
    Effect.gen(function* () {
      const result = yield* runMigrationExtensionsEffect({
        config: config([
          {
            _tag: "EffectSqlKitMigrationExtension",
            name: "custom",
            generate: () => ({ statements: [{ sql: "select 1" }], snapshot: { ok: true } }),
          },
        ]),
        schema,
        previous,
        current,
        previousExtensions: {},
      });

      expect(result).toEqual([
        {
          name: "custom",
          statements: [{ sql: "select 1" }],
          snapshot: { ok: true },
        },
      ]);
    }),
  );

  it.effect("rejects invalid extension generation results", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runMigrationExtensionsEffect({
          config: config([
            {
              _tag: "EffectSqlKitMigrationExtension",
              name: "invalid",
              generate: () => ({ statements: [], snapshot: undefined }) as never,
            },
          ]),
          schema,
          previous,
          current,
          previousExtensions: {},
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(Exit.isFailure(exit) ? String(exit.cause) : "").toContain(
        "effect-sql-kit: invalid migration extension result from invalid",
      );
    }),
  );

  it.effect("introspects only extensions with an introspection hook", () =>
    Effect.gen(function* () {
      const snapshots = yield* introspectMigrationExtensionsEffect({
        config: config([
          {
            _tag: "EffectSqlKitMigrationExtension",
            name: "missing",
            generate: () => ({ statements: [], snapshot: null }),
          },
          {
            _tag: "EffectSqlKitMigrationExtension",
            name: "present",
            generate: () => ({ statements: [], snapshot: null }),
            introspect: () => ({ ok: true }),
          },
        ]),
        schema,
        previous,
        current,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));

      expect(snapshots).toEqual({ present: { ok: true } });
    }),
  );

  it.effect("rejects invalid introspection snapshots", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        introspectMigrationExtensionsEffect({
          config: config([
            {
              _tag: "EffectSqlKitMigrationExtension",
              name: "invalid",
              generate: () => ({ statements: [], snapshot: null }),
              introspect: () => undefined,
            },
            {
              _tag: "EffectSqlKitMigrationExtension",
              name: "also-invalid",
              generate: () => ({ statements: [], snapshot: null }),
              introspect: () => ({ value: undefined }) as never,
            },
          ]),
          schema,
          previous,
          current,
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(Exit.isFailure(exit) ? String(exit.cause) : "").toContain(
        "effect-sql-kit: invalid migration extension snapshot from also-invalid",
      );
    }),
  );
});
