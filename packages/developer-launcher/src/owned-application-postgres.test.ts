import { expect, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Redacted, Stream } from "effect";
import { TestClock } from "effect/testing";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient, SqlError, Statement } from "effect/unstable/sql";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { applicationPlaneIdentity } from "./owned-application-plane";
import { makeOwnedApplicationPostgres } from "./owned-application-postgres";

const plane = applicationPlaneIdentity({
  sessionId: "one",
  ownerToken: "owner",
  server: "test",
  generation: 1,
  callbackOrigin: "https://one-db.test",
  cacheOrigin: "https://one-cache.test",
  artifacts: {
    generatedSchema: "1".repeat(64),
    callbacks: "2".repeat(64),
    authorization: "3".repeat(64),
    client: "4".repeat(64),
    deployment: "5".repeat(64),
    zeroVersion: "1.5.0",
    migrations: [{ id: 1, name: "initial", digest: "6".repeat(64) }],
  },
});
const marker = JSON.stringify({
  session: plane.sessionId,
  owner: plane.ownerToken,
  app: plane.app,
  server: plane.server,
});
const fixture = (
  read: (query: string, parameters: readonly unknown[]) => readonly Record<string, unknown>[],
  transaction: {
    readonly afterStatement?: (query: string) => Effect.Effect<void, SqlError.SqlError>;
    readonly release?: Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const commands: { query: string; parameters: readonly unknown[] }[] = [];
    const execute: Connection["execute"] = (query, parameters) =>
      Effect.sync(() => {
        commands.push({ query, parameters });
        return read(query, parameters);
      });
    const connection: Connection = {
      execute,
      executeRaw: (query, parameters) => execute(query, parameters, undefined),
      executeUnprepared: (query, parameters, transform) =>
        execute(query, parameters, transform).pipe(
          Effect.tap(() => transaction.afterStatement?.(query) ?? Effect.void),
        ),
      executeValues: () => Effect.succeed([]),
      executeStream: () => Stream.empty,
    };
    const sql = yield* SqlClient.make({
      acquirer: Effect.succeed(connection),
      transactionAcquirer: Effect.acquireRelease(
        Effect.succeed(connection),
        () => transaction.release ?? Effect.void,
      ),
      compiler: Statement.makeCompilerSqlite(),
      spanAttributes: [],
    }).pipe(Effect.provide(Reactivity.layer));
    const pg = makeOwnedApplicationPostgres({
      server: "test",
      control: sql,
      database: () => Effect.succeed(sql),
      passwordVerifiers: () =>
        Effect.succeed({
          runtime: Redacted.make("SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVk:c2VydmVy"),
          migration: Redacted.make("SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVk:c2VydmVy"),
          replication: Redacted.make("SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVk:c2VydmVy"),
        }),
    });
    return { pg, commands, sql };
  });
const database = { oid: 123, owner: plane.migrationOwner, marker };

it.effect("rolls back role creation when its ownership marker cannot be written", () =>
  Effect.gen(function* () {
    const f = yield* fixture((query) => {
      if (query.includes("rolsuper"))
        return [{ rolsuper: true, rolcreatedb: true, rolcreaterole: true, rolreplication: true }];
      if (query.includes("current_setting")) return [{ wal_level: "logical" }];
      if (query.startsWith("COMMENT ON ROLE")) throw new Error("comment rejected");
      return [];
    });
    const result = yield* Effect.exit(f.pg.provision(plane));
    expect(result._tag).toBe("Failure");
    const roleCommands = f.commands
      .map(({ query }) => query)
      .filter((query) =>
        ["BEGIN", "CREATE ROLE", "COMMENT ON ROLE", "ROLLBACK", "COMMIT"].some((prefix) =>
          query.startsWith(prefix),
        ),
      );
    expect(roleCommands).toHaveLength(4);
    expect(roleCommands[0]).toBe("BEGIN");
    expect(roleCommands[1]).toMatch(/^CREATE ROLE /);
    expect(roleCommands[2]).toMatch(/^COMMENT ON ROLE /);
    expect(roleCommands[3]).toBe("ROLLBACK");
  }),
);

it.effect(
  "drops only the exact inactive owned slot and accepts an already absent legacy slot",
  () =>
    Effect.gen(function* () {
      let present = true;
      const slot = `${plane.app}_0_1234567890123`;
      const f = yield* fixture((query, params) => {
        if (query.includes("pg_drop_replication_slot")) {
          present = false;
          return [];
        }
        if (query.includes("pg_replication_slots"))
          return present && params[0] === slot ? [{ database: plane.database, active: false }] : [];
        if (query.includes("FROM pg_database")) return [database];
        return [];
      });
      yield* f.pg.dropSlot(plane, slot);
      yield* f.pg.dropSlot(plane, `${plane.app}_0`);
      const drops = f.commands.filter((c) => c.query.includes("pg_drop_replication_slot"));
      expect(drops).toHaveLength(1);
      expect(drops[0]!.parameters).toEqual([slot, plane.database]);
      expect(drops[0]!.query).toContain("AND NOT active");
      expect(f.commands.every((c) => !c.query.includes("LIKE"))).toBe(true);
    }),
);

for (const foreign of [true, false])
  it.effect(`refuses ${foreign ? "foreign" : "active"} slot deletion`, () =>
    Effect.gen(function* () {
      const f = yield* fixture(() => [
        { database: foreign ? "shared" : plane.database, active: !foreign },
      ]);
      expect((yield* Effect.exit(f.pg.dropSlot(plane, `${plane.app}_0_123`)))._tag).toBe("Failure");
      expect(f.commands.some((c) => c.query.includes("pg_drop_replication_slot"))).toBe(false);
    }),
  );

it.effect(
  "drops an owned database without slots, covering its leftover schema/publication/trigger objects",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture((query) => (query.includes("shobj_description") ? [database] : []));
      yield* f.pg.dropDatabase(plane);
      expect(f.commands.at(-1)?.query).toBe(`DROP DATABASE "${plane.database}"`);
      expect(f.commands.some((c) => c.query.includes("FORCE"))).toBe(false);
    }),
);

it.effect("never terminates a foreign backend and fences only recorded scoped logins", () =>
  Effect.gen(function* () {
    const f = yield* fixture((query) => {
      if (query.includes("FROM pg_roles")) return [{ marker }];
      if (query.includes("shobj_description")) return [database];
      if (query.includes("pg_stat_activity")) return [{ pid: 42, usename: "shared-role" }];
      return [];
    });
    expect((yield* Effect.exit(f.pg.fenceDatabase(plane)))._tag).toBe("Failure");
    expect(f.commands.some((c) => c.query.includes("pg_terminate_backend"))).toBe(false);
    expect(f.commands.filter((c) => c.query.startsWith("ALTER ROLE")).map((c) => c.query)).toEqual(
      [plane.role, plane.replicationRole, plane.migrationOwner].map(
        (role) => `ALTER ROLE "${role}" NOLOGIN`,
      ),
    );
  }),
);

for (const existingRoles of [
  [],
  [plane.migrationOwner],
  [plane.role, plane.replicationRole, plane.migrationOwner],
])
  it.effect(`fences ${existingRoles.length} existing owned roles when the database is absent`, () =>
    Effect.gen(function* () {
      const f = yield* fixture((query, parameters) =>
        query.includes("FROM pg_roles") && existingRoles.includes(String(parameters[0]))
          ? [{ marker }]
          : [],
      );
      yield* f.pg.fenceDatabase(plane);
      expect(
        f.commands.filter((c) => c.query.includes("FROM pg_roles")).map((c) => c.parameters),
      ).toEqual([plane.role, plane.replicationRole, plane.migrationOwner].map((role) => [role]));
      expect(
        f.commands.filter((c) => c.query.startsWith("ALTER ROLE")).map((c) => c.query),
      ).toEqual(existingRoles.map((role) => `ALTER ROLE "${role}" NOLOGIN`));
      expect(
        f.commands.some((c) =>
          /ALTER DATABASE|pg_stat_activity|pg_terminate_backend/.test(c.query),
        ),
      ).toBe(false);
    }),
  );

it.effect("refuses foreign role ownership even when the database is absent", () =>
  Effect.gen(function* () {
    const f = yield* fixture((query) =>
      query.includes("FROM pg_roles") ? [{ marker: "foreign" }] : [],
    );
    expect(yield* Effect.result(f.pg.fenceDatabase(plane))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "OwnedApplicationError", reason: "postgres-role-ownership-unproved" },
    });
    expect(f.commands.some((c) => /ALTER |pg_terminate_backend/.test(c.query))).toBe(false);
  }),
);

it.effect("rechecks PID, exact database and role before backend termination", () =>
  Effect.gen(function* () {
    let alive = true;
    const f = yield* fixture((query) => {
      if (query.includes("to_regprocedure")) return [{ supports_timeout: false }];
      if (query.includes("FROM pg_roles")) return [{ marker }];
      if (query.includes("shobj_description")) return [database];
      if (query.includes("pg_terminate_backend")) {
        alive = false;
        return [{ terminated: true }];
      }
      if (query.includes("pg_stat_activity"))
        return alive ? [{ pid: 42, usename: plane.replicationRole }] : [];
      return [];
    });
    yield* f.pg.fenceDatabase(plane);
    expect(
      f.commands.find((c) => c.query.includes("pg_terminate_backend(a.pid"))?.parameters,
    ).toEqual([42, plane.replicationRole, plane.database]);
  }),
);

it.effect("excludes autovacuum workers but keeps client and walsender backends fenced", () =>
  Effect.gen(function* () {
    const liveBackends = new Map([
      [42, { pid: 42, usename: plane.role, backend_type: "client backend" }],
      [43, { pid: 43, usename: plane.replicationRole, backend_type: "walsender" }],
      [44, { pid: 44, usename: "postgres", backend_type: "autovacuum worker" }],
    ]);
    const f = yield* fixture((query, parameters) =>
      readAutovacuumFixture(query, parameters, liveBackends),
    );

    yield* f.pg.fenceDatabase(plane);
    yield* f.pg.dropDatabase(plane);

    const terminations = f.commands.filter((command) =>
      command.query.includes("pg_terminate_backend(a.pid"),
    );
    expect(terminations.map((command) => command.parameters[1])).toEqual([42, 43]);
    const activityInventories = f.commands.filter((command) =>
      command.query.startsWith("SELECT a.pid, a.usename FROM pg_stat_activity"),
    );
    expect(activityInventories).toHaveLength(3);
    expect(
      activityInventories.every((command) =>
        command.query.includes("a.backend_type IS DISTINCT FROM 'autovacuum worker'"),
      ),
    ).toBe(true);
    expect(f.commands.at(-1)?.query).toBe(`DROP DATABASE "${plane.database}"`);
  }),
);

it.effect("rejects database ownership changes before destructive SQL", () =>
  Effect.gen(function* () {
    const f = yield* fixture(() => [{ ...database, marker: "someone-else" }]);
    expect((yield* Effect.exit(f.pg.dropDatabase(plane)))._tag).toBe("Failure");
    expect(f.commands.some((c) => c.query.startsWith("DROP"))).toBe(false);
  }),
);

interface TerminationFixtureInput {
  readonly supportsTimeout: boolean;
  readonly exitAfterPolls: number;
  readonly signalResult?: boolean;
}

interface TerminationFixtureState {
  signaled: boolean;
  polls: number;
}

const terminationCapability = (query: string, input: TerminationFixtureInput) =>
  query.includes("to_regprocedure") ? [{ supports_timeout: input.supportsTimeout }] : undefined;

const terminationRoleMarker = (query: string) =>
  query.includes("FROM pg_roles") ? [{ marker }] : undefined;

const terminationDatabaseMarker = (query: string) =>
  query.includes("shobj_description") ? [database] : undefined;

const signalFixtureBackend = (
  query: string,
  input: TerminationFixtureInput,
  state: TerminationFixtureState,
) => {
  if (!query.includes("pg_terminate_backend(a.pid")) return undefined;
  state.signaled = true;
  return [{ terminated: input.signalResult ?? true }];
};

const fixtureBackendActivity = (
  query: string,
  input: TerminationFixtureInput,
  state: TerminationFixtureState,
  backend: { readonly pid: number; readonly usename: string },
) => {
  if (!query.includes("pg_stat_activity")) return undefined;
  if (!state.signaled) return [backend];
  if (query.includes("WHERE a.pid=")) state.polls++;
  return state.polls <= input.exitAfterPolls ? [backend] : [];
};

const readTerminationFixture = (
  query: string,
  input: TerminationFixtureInput,
  state: TerminationFixtureState,
  backend: { readonly pid: number; readonly usename: string },
) =>
  terminationCapability(query, input) ??
  terminationRoleMarker(query) ??
  terminationDatabaseMarker(query) ??
  signalFixtureBackend(query, input, state) ??
  fixtureBackendActivity(query, input, state, backend) ??
  [];

const terminationFixture = (input: TerminationFixtureInput) =>
  Effect.gen(function* () {
    const state = { signaled: false, polls: 0 };
    const backend = { pid: 42, usename: plane.replicationRole };
    const f = yield* fixture((query) => readTerminationFixture(query, input, state, backend));
    return f;
  });

type ActivityFixture = Map<number, Record<string, unknown>>;
const backendTypeCapabilityResult = (query: string) =>
  query.includes("pg_attribute") ? [{ supported: true }] : undefined;
const backendOwnershipResult = (query: string) =>
  query.includes("FROM pg_roles")
    ? [{ marker }]
    : query.includes("shobj_description")
      ? [database]
      : undefined;
const backendTerminationResult = (
  query: string,
  parameters: readonly unknown[],
  liveBackends: ActivityFixture,
) => {
  if (query.includes("to_regprocedure")) return [{ supports_timeout: true }];
  if (query.includes("pg_replication_slots")) return [];
  if (query.includes("pg_terminate_backend")) {
    liveBackends.delete(Number(parameters[1]));
    return [{ terminated: true }];
  }
  return undefined;
};
const backendActivityResult = (
  query: string,
  parameters: readonly unknown[],
  liveBackends: ActivityFixture,
) => {
  if (!query.includes("pg_stat_activity")) return undefined;
  if (query.includes("WHERE a.pid=")) {
    const backend = liveBackends.get(Number(parameters[0]));
    return backend ? [backend] : [];
  }
  if (!query.includes("a.backend_type IS DISTINCT FROM 'autovacuum worker'"))
    return [...liveBackends.values()];
  return [...liveBackends.values()].filter(
    (backend) => backend.backend_type !== "autovacuum worker",
  );
};
const readAutovacuumFixture = (
  query: string,
  parameters: readonly unknown[],
  liveBackends: ActivityFixture,
) =>
  backendTypeCapabilityResult(query) ??
  backendOwnershipResult(query) ??
  backendTerminationResult(query, parameters, liveBackends) ??
  backendActivityResult(query, parameters, liveBackends) ??
  [];

it.effect("waits for a delayed backend exit after signal delivery on older PostgreSQL", () =>
  Effect.gen(function* () {
    const f = yield* terminationFixture({ supportsTimeout: false, exitAfterPolls: 2 });
    const fiber = yield* f.pg.fenceDatabase(plane).pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.millis(200));
    yield* Fiber.join(fiber);
    const polls = f.commands.filter(
      (command) =>
        command.query.startsWith("SELECT a.pid FROM pg_stat_activity") &&
        command.query.includes("WHERE a.pid="),
    );
    expect(polls).toHaveLength(3);
    expect(
      polls.every(
        (command) =>
          JSON.stringify(command.parameters) ===
          JSON.stringify([42, plane.replicationRole, plane.database]),
      ),
    ).toBe(true);
    const signals = f.commands.filter((command) =>
      command.query.includes("pg_terminate_backend(a.pid"),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.parameters).toEqual([42, plane.replicationRole, plane.database]);
  }),
);

it.effect("fails closed after a bounded wait when a signaled backend remains alive", () =>
  Effect.gen(function* () {
    const f = yield* terminationFixture({ supportsTimeout: false, exitAfterPolls: Infinity });
    let completed = false;
    const fiber = yield* f.pg.fenceDatabase(plane).pipe(
      Effect.result,
      Effect.tap(() =>
        Effect.sync(() => {
          completed = true;
        }),
      ),
      Effect.forkChild,
    );
    yield* TestClock.adjust(Duration.millis(4_900));
    expect(completed).toBe(false);
    yield* TestClock.adjust(Duration.millis(100));
    expect(yield* Fiber.join(fiber)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "backend-termination-unproved" },
    });
    expect(f.commands.some((command) => command.query.startsWith("DROP"))).toBe(false);
  }),
);

it.effect(
  "uses the timeout overload when available and still confirms the exact target exited",
  () =>
    Effect.gen(function* () {
      const f = yield* terminationFixture({ supportsTimeout: true, exitAfterPolls: 0 });
      yield* f.pg.fenceDatabase(plane);
      const signal = f.commands.find((command) =>
        command.query.includes("pg_terminate_backend(a.pid"),
      );
      expect(signal?.parameters).toEqual([5_000, 42, plane.replicationRole, plane.database]);
      const poll = f.commands.find(
        (command) =>
          command.query.startsWith("SELECT a.pid FROM pg_stat_activity") &&
          command.query.includes("WHERE a.pid="),
      );
      expect(poll?.parameters).toEqual([42, plane.replicationRole, plane.database]);
    }),
);

it.effect("keeps a server-side termination timeout unavailable", () =>
  Effect.gen(function* () {
    const f = yield* terminationFixture({
      supportsTimeout: true,
      exitAfterPolls: Infinity,
      signalResult: false,
    });
    expect(yield* Effect.result(f.pg.fenceDatabase(plane))).toMatchObject({
      _tag: "Failure",
      failure: { reason: "backend-termination-unproved" },
    });
    expect(f.commands.some((command) => command.query.startsWith("DROP"))).toBe(false);
  }),
);

const transactionFixture = (
  input: {
    readonly blockedStatement?: string;
    readonly failStatement?: string;
    readonly failRollback?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const statementStarted = yield* Deferred.make<void>();
    const deliverResponse = yield* Deferred.make<void>();
    const events: string[] = [];
    let inTransaction = false;
    const statementFailure = () =>
      Effect.fail(
        new SqlError.SqlError({
          reason: new SqlError.UnknownError({ cause: new Error("simulated transport failure") }),
        }),
      );
    const f = yield* fixture(
      (query) => {
        if (query.includes("rolsuper")) return [{ rolsuper: true }];
        if (query.includes("current_setting")) return [{ wal_level: "logical" }];
        if (query === "BEGIN") inTransaction = true;
        if (query === "ROLLBACK" && !input.failRollback) inTransaction = false;
        if (query === "COMMIT" && input.failStatement !== "COMMIT") inTransaction = false;
        if (query === "SELECT next_request") return [{ safe: !inTransaction }];
        events.push(query);
        return [];
      },
      {
        afterStatement: (query) =>
          Effect.gen(function* () {
            if (input.blockedStatement !== undefined && query.startsWith(input.blockedStatement)) {
              yield* Deferred.succeed(statementStarted, undefined);
              yield* Deferred.await(deliverResponse);
            }
            if (query === input.failStatement || (query === "ROLLBACK" && input.failRollback))
              return yield* statementFailure();
          }),
        release: Effect.sync(() => {
          events.push(inTransaction ? "release:open" : "release:idle");
        }),
      },
    );
    return { ...f, events, statementStarted, deliverResponse };
  });

for (const blockedStatement of ["BEGIN", "CREATE ROLE"] as const)
  it.effect(
    `rolls back cancellation during ${blockedStatement} before returning the connection to the pool`,
    () =>
      Effect.gen(function* () {
        const f = yield* transactionFixture({ blockedStatement });
        const provisioning = yield* f.pg.provision(plane).pipe(Effect.forkChild);
        yield* Deferred.await(f.statementStarted);
        const interruption = yield* Fiber.interrupt(provisioning).pipe(Effect.forkChild);
        // Drain the runnable fibers so the interrupt is requested before the server reply arrives.
        yield* TestClock.adjust(Duration.zero);
        yield* Deferred.succeed(f.deliverResponse, undefined);
        yield* Fiber.join(interruption);
        const statements = f.events.map((event) =>
          event.startsWith("CREATE ROLE ") ? "CREATE ROLE" : event,
        );
        const created = blockedStatement === "CREATE ROLE" ? ["CREATE ROLE"] : [];
        expect(statements).toEqual(["BEGIN", ...created, "ROLLBACK", "release:idle"]);
        expect(yield* f.sql.unsafe("SELECT next_request")).toEqual([{ safe: true }]);
      }),
  );

for (const failStatement of ["BEGIN", "COMMIT"] as const)
  it.effect(`rolls back a failed ${failStatement} response before pool release`, () =>
    Effect.gen(function* () {
      const f = yield* transactionFixture({ failStatement });
      expect(yield* Effect.result(f.pg.provision(plane))).toMatchObject({
        _tag: "Failure",
        failure: { reason: "scoped-role-provisioning-failed" },
      });
      expect(f.events.slice(-2)).toEqual(["ROLLBACK", "release:idle"]);
      expect(yield* f.sql.unsafe("SELECT next_request")).toEqual([{ safe: true }]);
    }),
  );

it.effect("preserves rollback-unproved failure when rollback cannot be confirmed", () =>
  Effect.gen(function* () {
    const f = yield* transactionFixture({ failStatement: "COMMIT", failRollback: true });
    expect(yield* Effect.result(f.pg.provision(plane))).toMatchObject({
      _tag: "Failure",
      failure: { reason: "scoped-role-rollback-unproved" },
    });
  }),
);
