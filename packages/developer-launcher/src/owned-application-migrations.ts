import { createHash } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { OwnedApplicationError, type OwnedApplicationPlane } from "./owned-application-plane";

export const applicationArtifactBytesDigest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export interface OwnedMigrationArtifact {
  readonly id: number;
  readonly name: string;
  /** Exact immutable bytes loaded by the operator artifact loader, including its dependencies. */
  readonly bytes: Uint8Array;
  readonly apply: (verifiedBytes: Uint8Array) => Effect.Effect<void, Error, SqlClient.SqlClient>;
}
const fail = (reason: string) => Effect.fail(new OwnedApplicationError({ reason }));

interface OwnedApplicationInitialization {
  readonly plane: OwnedApplicationPlane;
  readonly generatedSchema: Uint8Array;
  readonly applyGeneratedSchema: (
    verifiedBytes: Uint8Array,
  ) => Effect.Effect<void, Error, SqlClient.SqlClient>;
  readonly migrations: readonly OwnedMigrationArtifact[];
}

const validateMigrationOwner = (plane: OwnedApplicationPlane) =>
  !/^p[a-f0-9]{32}$/.test(plane.app) ||
  plane.database !== `${plane.app}_db` ||
  plane.migrationOwner !== `${plane.app}_migrate`
    ? fail("migration-owner-identity-invalid")
    : Effect.void;

const migrationMatchesArtifact = (
  migration: OwnedMigrationArtifact,
  expected: OwnedApplicationPlane["artifacts"]["migrations"][number] | undefined,
  previousId: number,
) =>
  migration.id === expected?.id &&
  migration.name === expected?.name &&
  applicationArtifactBytesDigest(migration.bytes) === expected?.digest &&
  migration.id > previousId;

const validateMigrationArtifacts = (input: OwnedApplicationInitialization) => {
  const { plane, migrations } = input;
  const invalidMigrations = migrations.some(
    (migration, index) =>
      !migrationMatchesArtifact(
        migration,
        plane.artifacts.migrations[index],
        migrations[index - 1]?.id ?? 0,
      ),
  );
  return applicationArtifactBytesDigest(input.generatedSchema) !==
    plane.artifacts.generatedSchema ||
    migrations.length === 0 ||
    migrations.length !== plane.artifacts.migrations.length ||
    invalidMigrations
    ? fail("migration-artifact-mismatch")
    : Effect.void;
};

/**
 * Single bootstrap job, never an application/watch startup hook. Generated schema validation
 * and forward migrations share one owner/transaction. The independent digest journal does
 * not replace sheet_db_effect_sql_migrations or claim it previously recorded checksums.
 */
export const initializeOwnedApplication = (input: OwnedApplicationInitialization) =>
  Effect.gen(function* () {
    const { plane, migrations } = input;
    yield* validateMigrationOwner(plane);
    // Check every byte digest before any DDL, including journal initialization.
    yield* validateMigrationArtifacts(input);
    const sql = yield* SqlClient.SqlClient;
    const identity = yield* sql`SELECT current_database() AS database, current_user AS owner`;
    if (identity[0]?.database !== plane.database || identity[0]?.owner !== plane.migrationOwner)
      return yield* fail("migration-connection-owner-mismatch");
    const bootstrapSchema = `${plane.app}_bootstrap`;
    const journal = `"${bootstrapSchema}"."artifacts"`;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${plane.database}, 0))`;
        yield* sql.unsafe(
          `CREATE SCHEMA IF NOT EXISTS "${plane.app}_bootstrap" AUTHORIZATION "${plane.migrationOwner}"`,
        );
        yield* sql.unsafe(`REVOKE ALL ON SCHEMA "${plane.app}_bootstrap" FROM PUBLIC`);
        yield* sql.unsafe(
          `CREATE TABLE IF NOT EXISTS ${journal} (id bigint PRIMARY KEY, name text NOT NULL, digest text NOT NULL)`,
        );
        const history = yield* sql.unsafe<{ id: number; name: string; digest: string }>(
          `SELECT id, name, digest FROM ${journal} ORDER BY id`,
        );
        const expected = [
          { id: 0, name: "generated-schema", digest: plane.artifacts.generatedSchema },
          ...plane.artifacts.migrations,
        ];
        if (history.length > 0) {
          if (
            history.length !== expected.length ||
            history.some(
              (row, i) =>
                Number(row.id) !== expected[i]?.id ||
                row.name !== expected[i]?.name ||
                row.digest !== expected[i]?.digest,
            )
          )
            return yield* fail("applied-migration-digests-mismatch");
          return plane.artifacts;
        }
        // Empty is the only initial state; no snapshot, seed, down migration, or db:push path.
        // public is the fresh-database baseline; in the private bootstrap schema allow only
        // the digest journal and catalog entries PostgreSQL creates for its primary key.
        const existingObjects = yield* sql`
          WITH user_namespaces AS (
            SELECT oid, nspname
            FROM pg_catalog.pg_namespace
            WHERE nspname NOT IN ('pg_catalog', 'information_schema')
              AND nspname NOT LIKE 'pg_toast%'
          ),
          bootstrap_schema AS (
            SELECT oid, nspname FROM user_namespaces WHERE nspname=${bootstrapSchema}
          ),
          bootstrap_journal AS (
            SELECT c.oid AS relation_oid, t.oid AS row_type_oid, t.typarray AS array_type_oid
            FROM pg_catalog.pg_class c
            JOIN bootstrap_schema n ON n.oid=c.relnamespace
            LEFT JOIN pg_catalog.pg_type t ON t.typrelid=c.oid
            WHERE c.relname='artifacts' AND c.relkind='r'
          ),
          user_objects AS (
            SELECT nspname AS schema_name, 'schema'::text AS object_type, nspname AS object_name
            FROM user_namespaces
            WHERE nspname NOT IN ('public', ${bootstrapSchema})
            UNION ALL
            SELECT n.nspname, 'relation'::text, c.relname
            FROM pg_catalog.pg_class c
            JOIN user_namespaces n ON n.oid=c.relnamespace
            WHERE n.nspname IN ('public', ${bootstrapSchema})
              AND NOT (
                n.nspname=${bootstrapSchema} AND (
                  EXISTS (SELECT 1 FROM bootstrap_journal j WHERE j.relation_oid=c.oid)
                  OR (
                    c.relkind='i'
                    AND EXISTS (
                      SELECT 1
                      FROM pg_catalog.pg_index i
                      JOIN pg_catalog.pg_constraint con ON con.conindid=i.indexrelid
                      WHERE i.indexrelid=c.oid
                        AND i.indrelid=(SELECT relation_oid FROM bootstrap_journal)
                        AND con.contype='p'
                    )
                  )
                )
              )
            UNION ALL
            SELECT n.nspname, 'routine'::text, p.proname
            FROM pg_catalog.pg_proc p
            JOIN user_namespaces n ON n.oid=p.pronamespace
            WHERE n.nspname IN ('public', ${bootstrapSchema})
            UNION ALL
            SELECT n.nspname, 'type'::text, t.typname
            FROM pg_catalog.pg_type t
            JOIN user_namespaces n ON n.oid=t.typnamespace
            WHERE n.nspname IN ('public', ${bootstrapSchema})
              AND NOT EXISTS (
                SELECT 1 FROM bootstrap_journal j
                WHERE t.oid=j.row_type_oid OR t.oid=j.array_type_oid
              )
            UNION ALL
            SELECT n.nspname, 'operator'::text, o.oprname
            FROM pg_catalog.pg_operator o
            JOIN user_namespaces n ON n.oid=o.oprnamespace
            WHERE n.nspname IN ('public', ${bootstrapSchema})
            UNION ALL
            SELECT n.nspname, 'collation'::text, c.collname
            FROM pg_catalog.pg_collation c
            JOIN user_namespaces n ON n.oid=c.collnamespace
            WHERE n.nspname IN ('public', ${bootstrapSchema})
            UNION ALL
            SELECT n.nspname, 'conversion'::text, c.conname
            FROM pg_catalog.pg_conversion c
            JOIN user_namespaces n ON n.oid=c.connamespace
            WHERE n.nspname IN ('public', ${bootstrapSchema})
            UNION ALL
            SELECT n.nspname, 'operator-class'::text, o.opcname
            FROM pg_catalog.pg_opclass o
            JOIN user_namespaces n ON n.oid=o.opcnamespace
            WHERE n.nspname IN ('public', ${bootstrapSchema})
            UNION ALL
            SELECT n.nspname, 'operator-family'::text, o.opfname
            FROM pg_catalog.pg_opfamily o
            JOIN user_namespaces n ON n.oid=o.opfnamespace
            WHERE n.nspname IN ('public', ${bootstrapSchema})
            UNION ALL
            SELECT n.nspname, 'statistics'::text, s.stxname
            FROM pg_catalog.pg_statistic_ext s
            JOIN user_namespaces n ON n.oid=s.stxnamespace
            WHERE n.nspname IN ('public', ${bootstrapSchema})
            UNION ALL
            SELECT n.nspname, 'text-search-config'::text, c.cfgname
            FROM pg_catalog.pg_ts_config c
            JOIN user_namespaces n ON n.oid=c.cfgnamespace
            WHERE n.nspname IN ('public', ${bootstrapSchema})
            UNION ALL
            SELECT n.nspname, 'text-search-dictionary'::text, d.dictname
            FROM pg_catalog.pg_ts_dict d
            JOIN user_namespaces n ON n.oid=d.dictnamespace
            WHERE n.nspname IN ('public', ${bootstrapSchema})
            UNION ALL
            SELECT n.nspname, 'text-search-parser'::text, p.prsname
            FROM pg_catalog.pg_ts_parser p
            JOIN user_namespaces n ON n.oid=p.prsnamespace
            WHERE n.nspname IN ('public', ${bootstrapSchema})
            UNION ALL
            SELECT n.nspname, 'text-search-template'::text, t.tmplname
            FROM pg_catalog.pg_ts_template t
            JOIN user_namespaces n ON n.oid=t.tmplnamespace
            WHERE n.nspname IN ('public', ${bootstrapSchema})
            UNION ALL
            SELECT NULL::name, 'large-object'::text, l.oid::text
            FROM pg_catalog.pg_largeobject_metadata l
            UNION ALL
            SELECT NULL::name, 'publication'::text, p.pubname
            FROM pg_catalog.pg_publication p
            UNION ALL
            SELECT NULL::name, 'event-trigger'::text, e.evtname
            FROM pg_catalog.pg_event_trigger e
            UNION ALL
            SELECT NULL::name, 'extension'::text, e.extname
            FROM pg_catalog.pg_extension e
            WHERE e.extname <> 'plpgsql'
            UNION ALL
            SELECT NULL::name, 'language'::text, l.lanname
            FROM pg_catalog.pg_language l
            WHERE l.lanname NOT IN ('internal', 'c', 'sql', 'plpgsql')
          )
          SELECT schema_name, object_type, object_name FROM user_objects LIMIT 1
        `;
        if (existingObjects.length !== 0) return yield* fail("new-owned-database-not-empty");
        yield* input.applyGeneratedSchema(input.generatedSchema);
        yield* sql.unsafe(
          `CREATE TABLE "public"."sheet_db_effect_sql_migrations" (migration_id integer PRIMARY KEY, created_at timestamp with time zone NOT NULL DEFAULT now(), name text NOT NULL)`,
        );
        yield* sql.unsafe(`INSERT INTO ${journal}(id, name, digest) VALUES ($1, $2, $3)`, [
          0,
          "generated-schema",
          plane.artifacts.generatedSchema,
        ]);
        for (const artifact of migrations) {
          yield* artifact.apply(artifact.bytes);
          yield* sql`INSERT INTO public.sheet_db_effect_sql_migrations(migration_id, name) VALUES (${artifact.id}, ${artifact.name})`;
          yield* sql.unsafe(`INSERT INTO ${journal}(id, name, digest) VALUES ($1, $2, $3)`, [
            artifact.id,
            artifact.name,
            applicationArtifactBytesDigest(artifact.bytes),
          ]);
        }
        return plane.artifacts;
      }),
    );
  });
