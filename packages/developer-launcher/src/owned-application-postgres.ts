import { Duration, Effect, Option, Redacted } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { OwnedApplicationError, type OwnedApplicationPlane } from "./owned-application-plane";

const fail = (reason: string) => Effect.fail(new OwnedApplicationError({ reason }));
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
const ownerMarker = (plane: OwnedApplicationPlane) =>
  JSON.stringify({
    session: plane.sessionId,
    owner: plane.ownerToken,
    app: plane.app,
    server: plane.server,
  });
const backendTerminationTimeoutMs = 5_000;
const backendTerminationPollIntervalMs = 50;

/** Operator-provided, TLS-verified connections only. Never constructed from ambient env. */
export interface OwnedPostgresConnections {
  readonly server: string;
  readonly control: SqlClient;
  readonly database: (plane: OwnedApplicationPlane) => Effect.Effect<SqlClient, Error>;
  /** Verifiers for fresh scoped logins, stored and delivered outside logs/ledger/configuration. */
  readonly passwordVerifiers: (plane: OwnedApplicationPlane) => Effect.Effect<
    {
      readonly runtime: Redacted.Redacted<string>;
      readonly replication: Redacted.Redacted<string>;
      readonly migration: Redacted.Redacted<string>;
    },
    Error
  >;
}

/**
 * PostgreSQL primitives for the operator provider. The application-plane journal serializes
 * lifecycle calls; the operator must also fence cache/writer processes before remove/fence.
 * This is deliberately not wired to a live launcher profile.
 */
export const makeOwnedApplicationPostgres = (connections: OwnedPostgresConnections) => {
  const control = connections.control;
  const scopedRoleStatement = (connection: Connection, statement: string) =>
    connection
      .executeUnprepared(statement, [], undefined)
      .pipe(
        Effect.mapError(
          () => new OwnedApplicationError({ reason: "scoped-role-provisioning-failed" }),
        ),
      );
  const provisionScopedRole = (
    connection: Connection,
    plane: OwnedApplicationPlane,
    role: string,
    verifier: Redacted.Redacted<string>,
    replication: boolean,
  ) =>
    Effect.gen(function* () {
      const value = Redacted.value(verifier);
      if (!/^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(value))
        return yield* fail("scram-verifier-required");
      const createAndMarkRole = Effect.gen(function* () {
        yield* scopedRoleStatement(
          connection,
          `CREATE ROLE ${identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT ${replication ? "REPLICATION" : "NOREPLICATION"} PASSWORD ${literal(value)}`,
        );
        yield* scopedRoleStatement(
          connection,
          `COMMENT ON ROLE ${identifier(role)} IS ${literal(ownerMarker(plane))}`,
        );
      });
      // Install rollback protection before BEGIN. Resolve the transaction before
      // returning this reserved connection, even if cancellation arrives mid-query.
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* scopedRoleStatement(connection, "BEGIN");
          yield* restore(createAndMarkRole);
          yield* scopedRoleStatement(connection, "COMMIT");
        }).pipe(
          Effect.onExit((exit) =>
            exit._tag === "Failure"
              ? connection.executeUnprepared("ROLLBACK", [], undefined).pipe(
                  Effect.mapError(
                    () => new OwnedApplicationError({ reason: "scoped-role-rollback-unproved" }),
                  ),
                  Effect.asVoid,
                )
              : Effect.void,
          ),
        ),
      );
    });
  const checked = (plane: OwnedApplicationPlane) =>
    Effect.gen(function* () {
      if (
        connections.server !== plane.server ||
        !/^p[a-f0-9]{32}$/.test(plane.app) ||
        plane.database !== `${plane.app}_db` ||
        plane.role !== `${plane.app}_runtime` ||
        plane.replicationRole !== `${plane.app}_replication` ||
        plane.migrationOwner !== `${plane.app}_migrate`
      )
        return yield* fail("postgres-identity-mismatch");
    });
  const ownedDatabase = (plane: OwnedApplicationPlane, allowAbsent = false) =>
    Effect.gen(function* () {
      yield* checked(plane);
      const rows =
        yield* control`SELECT oid, pg_get_userbyid(datdba) AS owner, shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname=${plane.database}`;
      if (rows.length === 0 && allowAbsent) return false;
      if (
        rows.length !== 1 ||
        rows[0]!.owner !== plane.migrationOwner ||
        rows[0]!.marker !== ownerMarker(plane)
      )
        return yield* fail("postgres-database-ownership-unproved");
      return true;
    });
  const ownedRole = (plane: OwnedApplicationPlane, role: string, allowAbsent = false) =>
    Effect.gen(function* () {
      if (![plane.role, plane.replicationRole, plane.migrationOwner].includes(role))
        return yield* fail("unreserved-role");
      const rows =
        yield* control`SELECT shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname=${role}`;
      if (rows.length === 0 && allowAbsent) return false;
      if (rows.length !== 1 || rows[0]!.marker !== ownerMarker(plane))
        return yield* fail("postgres-role-ownership-unproved");
      return true;
    });
  const databaseClient = (plane: OwnedApplicationPlane) =>
    Effect.gen(function* () {
      yield* ownedDatabase(plane);
      const sql = yield* connections.database(plane);
      const rows = yield* sql`SELECT current_database() AS database`;
      if (rows[0]?.database !== plane.database)
        return yield* fail("postgres-connection-target-mismatch");
      return sql;
    });
  const verifyAllocatorGrants = Effect.gen(function* () {
    const roles =
      yield* control`SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname=current_user`;
    const settings = yield* control`SELECT current_setting('wal_level') AS wal_level`;
    if (roles[0]?.rolsuper !== true || settings[0]?.wal_level !== "logical")
      return yield* fail("postgres-allocator-grants-unverified");
  });
  const preventRoleLogins = (plane: OwnedApplicationPlane) =>
    Effect.gen(function* () {
      for (const role of [plane.role, plane.replicationRole, plane.migrationOwner]) {
        if (yield* ownedRole(plane, role, true))
          yield* control.unsafe(`ALTER ROLE ${identifier(role)} NOLOGIN`);
      }
    });
  const activityBackendTypeSupported = () =>
    control`SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='pg_catalog.pg_stat_activity'::regclass AND attname='backend_type' AND NOT attisdropped) AS supported`;
  /** Omit only internal autovacuum workers; client and walsender rows still require exact role proof. */
  const databaseBackends = (plane: OwnedApplicationPlane, backendTypeSupported: boolean) =>
    backendTypeSupported
      ? control`SELECT a.pid, a.usename FROM pg_stat_activity a JOIN pg_database d ON a.datid=d.oid WHERE d.datname=${plane.database} AND a.backend_type IS DISTINCT FROM 'autovacuum worker'`
      : control`SELECT a.pid, a.usename FROM pg_stat_activity a JOIN pg_database d ON a.datid=d.oid WHERE d.datname=${plane.database}`;
  const hasForeignBackend = (
    plane: OwnedApplicationPlane,
    backends: readonly Record<string, unknown>[],
  ) =>
    backends.some(
      (backend) =>
        ![plane.role, plane.replicationRole, plane.migrationOwner].includes(
          String(backend.usename),
        ),
    );
  const backendTerminationTimeoutSupported = () =>
    control`SELECT to_regprocedure('pg_catalog.pg_terminate_backend(integer,bigint)') IS NOT NULL AS supports_timeout`;
  const terminateBackend = (
    plane: OwnedApplicationPlane,
    backend: Record<string, unknown>,
    useServerTimeout: boolean,
  ) =>
    Effect.gen(function* () {
      const result = useServerTimeout
        ? yield* control`SELECT pg_terminate_backend(a.pid, ${backendTerminationTimeoutMs}) AS terminated FROM pg_stat_activity a JOIN pg_database d ON a.datid=d.oid WHERE a.pid=${backend.pid} AND a.usename=${backend.usename} AND d.datname=${plane.database}`
        : yield* control`SELECT pg_terminate_backend(a.pid) AS terminated FROM pg_stat_activity a JOIN pg_database d ON a.datid=d.oid WHERE a.pid=${backend.pid} AND a.usename=${backend.usename} AND d.datname=${plane.database}`;
      if (result.some((row) => row.terminated !== true))
        return yield* fail("backend-termination-unproved");
      if (useServerTimeout) {
        const remaining =
          yield* control`SELECT a.pid FROM pg_stat_activity a JOIN pg_database d ON a.datid=d.oid WHERE a.pid=${backend.pid} AND a.usename=${backend.usename} AND d.datname=${plane.database}`;
        if (remaining.length !== 0) return yield* fail("backend-termination-unproved");
        return;
      }
      const exited = yield* Effect.gen(function* () {
        while (true) {
          const remaining =
            yield* control`SELECT a.pid FROM pg_stat_activity a JOIN pg_database d ON a.datid=d.oid WHERE a.pid=${backend.pid} AND a.usename=${backend.usename} AND d.datname=${plane.database}`;
          if (remaining.length === 0) return;
          yield* Effect.sleep(Duration.millis(backendTerminationPollIntervalMs));
        }
      }).pipe(Effect.timeoutOption(Duration.millis(backendTerminationTimeoutMs)));
      if (Option.isNone(exited)) return yield* fail("backend-termination-unproved");
    });
  const confirmNoDatabaseBackends = (plane: OwnedApplicationPlane, backendTypeSupported: boolean) =>
    Effect.gen(function* () {
      const remaining = yield* databaseBackends(plane, backendTypeSupported);
      if (remaining.length !== 0) return yield* fail("backend-termination-unproved");
    });
  return {
    verifyAllocatorGrants,
    provision: (plane: OwnedApplicationPlane) =>
      Effect.gen(function* () {
        yield* checked(plane);
        yield* verifyAllocatorGrants;
        const credentials = yield* connections.passwordVerifiers(plane);
        const roles = [
          [plane.migrationOwner, credentials.migration, false],
          [plane.role, credentials.runtime, false],
          [plane.replicationRole, credentials.replication, true],
        ] as const;
        // Use the low-level connection so secret-bearing CREATE ROLE text is never a traced SQL span.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* control.reserve;
            for (const [role, verifier, replication] of roles) {
              yield* provisionScopedRole(connection, plane, role, verifier, replication);
            }
          }),
        );
        yield* control.unsafe(
          `CREATE DATABASE ${identifier(plane.database)} OWNER ${identifier(plane.migrationOwner)} TEMPLATE template0`,
        );
        yield* control.unsafe(
          `COMMENT ON DATABASE ${identifier(plane.database)} IS ${literal(ownerMarker(plane))}`,
        );
        yield* control.unsafe(`REVOKE ALL ON DATABASE ${identifier(plane.database)} FROM PUBLIC`);
        yield* control.unsafe(
          `GRANT CONNECT ON DATABASE ${identifier(plane.database)} TO ${identifier(plane.role)}, ${identifier(plane.replicationRole)}`,
        );
        yield* control.unsafe(
          `GRANT CREATE ON DATABASE ${identifier(plane.database)} TO ${identifier(plane.replicationRole)}`,
        );
        const sql = yield* databaseClient(plane);
        yield* sql.unsafe("REVOKE ALL ON SCHEMA public FROM PUBLIC");
        yield* sql.unsafe(
          `GRANT USAGE, CREATE ON SCHEMA public TO ${identifier(plane.migrationOwner)}`,
        );
        yield* sql.unsafe(
          `GRANT USAGE ON SCHEMA public TO ${identifier(plane.role)}, ${identifier(plane.replicationRole)}`,
        );
      }),
    /** Run after the single migration owner, before either application or cache starts. */
    grantRuntime: (plane: OwnedApplicationPlane) =>
      Effect.gen(function* () {
        const sql = yield* databaseClient(plane);
        yield* ownedRole(plane, plane.role);
        yield* ownedRole(plane, plane.replicationRole);
        yield* sql.unsafe(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${identifier(plane.role)}`,
        );
        yield* sql.unsafe(
          `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${identifier(plane.role)}`,
        );
        yield* sql.unsafe(
          `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${identifier(plane.replicationRole)}`,
        );
        yield* sql.unsafe(
          `REVOKE INSERT, UPDATE, DELETE ON public.sheet_db_effect_sql_migrations FROM ${identifier(plane.role)}`,
        );
      }),
    /** Cache setup creates these schemas before callback traffic can be admitted. */
    grantZeroRuntime: (plane: OwnedApplicationPlane) =>
      Effect.gen(function* () {
        const sql = yield* databaseClient(plane);
        for (const schema of [plane.app, `${plane.app}_0`]) {
          const owners =
            yield* sql`SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=${schema}`;
          if (owners.length !== 1 || owners[0]!.owner !== plane.replicationRole)
            return yield* fail("zero-schema-owner-mismatch");
          yield* sql.unsafe(
            `GRANT USAGE ON SCHEMA ${identifier(schema)} TO ${identifier(plane.role)}`,
          );
          const privileges = schema === plane.app ? "SELECT" : "SELECT, INSERT, UPDATE, DELETE";
          yield* sql.unsafe(
            `GRANT ${privileges} ON ALL TABLES IN SCHEMA ${identifier(schema)} TO ${identifier(plane.role)}`,
          );
          yield* sql.unsafe(
            `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${identifier(schema)} TO ${identifier(plane.role)}`,
          );
        }
      }),
    /** Only this database and its exact scoped roles can have backends terminated. */
    fenceDatabase: (plane: OwnedApplicationPlane) =>
      Effect.gen(function* () {
        const databaseExists = yield* ownedDatabase(plane, true);
        // Partial provisioning may have created scoped logins before database creation failed.
        yield* preventRoleLogins(plane);
        if (!databaseExists) return;
        yield* control.unsafe(
          `ALTER DATABASE ${identifier(plane.database)} ALLOW_CONNECTIONS false`,
        );
        const backendTypeRows = yield* activityBackendTypeSupported();
        const backendTypeSupported = backendTypeRows[0]?.supported === true;
        const backends = yield* databaseBackends(plane, backendTypeSupported);
        if (hasForeignBackend(plane, backends))
          return yield* fail("foreign-backend-in-owned-database");
        const timeoutSupport = yield* backendTerminationTimeoutSupported();
        const useServerTimeout = timeoutSupport[0]?.supports_timeout === true;
        for (const backend of backends) yield* terminateBackend(plane, backend, useServerTimeout);
        yield* confirmNoDatabaseBackends(plane, backendTypeSupported);
      }),
    /** Absence is successful only for this exact reserved slot; no prefix SQL or zero-out. */
    dropSlot: (plane: OwnedApplicationPlane, name: string) =>
      Effect.gen(function* () {
        yield* checked(plane);
        if (
          !/^[a-z0-9_]{1,63}$/.test(name) ||
          !plane.resources.some(
            (r) =>
              (r.kind === "slot" && r.name === name) ||
              (r.kind === "slot-prefix" && name.startsWith(r.name)),
          )
        )
          return yield* fail("unreserved-slot");
        const slots =
          yield* control`SELECT database, active FROM pg_replication_slots WHERE slot_name=${name}`;
        if (slots.length === 0) return;
        if (
          slots.length !== 1 ||
          slots[0]!.database !== plane.database ||
          slots[0]!.active !== false
        )
          return yield* fail("slot-ownership-or-termination-unproved");
        yield* ownedDatabase(plane);
        yield* control`SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name=${name} AND database=${plane.database} AND NOT active`;
        if (
          (yield* control`SELECT slot_name FROM pg_replication_slots WHERE slot_name=${name}`)
            .length !== 0
        )
          return yield* fail("slot-release-unproved");
      }),
    /** Database deletion removes its schemas/publications/triggers even when no slots exist. */
    dropDatabase: (plane: OwnedApplicationPlane) =>
      Effect.gen(function* () {
        if (!(yield* ownedDatabase(plane, true))) return;
        const slots =
          yield* control`SELECT slot_name FROM pg_replication_slots WHERE database=${plane.database}`;
        const backendTypeRows = yield* activityBackendTypeSupported();
        const backendTypeSupported = backendTypeRows[0]?.supported === true;
        const backends = yield* databaseBackends(plane, backendTypeSupported);
        if (slots.length !== 0 || backends.length !== 0)
          return yield* fail("database-still-in-use");
        yield* control.unsafe(`DROP DATABASE ${identifier(plane.database)}`);
      }),
    dropRole: (plane: OwnedApplicationPlane, role: string) =>
      Effect.gen(function* () {
        yield* checked(plane);
        if (!(yield* ownedRole(plane, role, true))) return;
        // REASSIGN OWNED / DROP OWNED could touch unrelated databases and are deliberately absent.
        yield* control.unsafe(`DROP ROLE ${identifier(role)}`);
      }),
  };
};
