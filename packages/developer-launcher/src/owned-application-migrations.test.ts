import { expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient, Statement } from "effect/unstable/sql";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { applicationPlaneIdentity } from "./owned-application-plane";
import {
  applicationArtifactBytesDigest,
  initializeOwnedApplication,
  type OwnedMigrationArtifact,
} from "./owned-application-migrations";

const bytes = new TextEncoder().encode("immutable schema artifact");
const hash = applicationArtifactBytesDigest(bytes);
const plane = applicationPlaneIdentity({
  sessionId: "one",
  ownerToken: "owner",
  server: "test",
  generation: 1,
  callbackOrigin: "https://db.test",
  cacheOrigin: "https://cache.test",
  artifacts: {
    generatedSchema: hash,
    callbacks: hash,
    authorization: hash,
    client: hash,
    deployment: hash,
    zeroVersion: "1.5.0",
    migrations: [{ id: 1, name: "initial", digest: hash }],
  },
});
const expectedUserObjects = (
  parameters: readonly unknown[],
  options: {
    readonly nonempty?: boolean;
    readonly nonemptyCustomSchema?: boolean;
    readonly nonemptyObject?: "view" | "sequence" | "function" | "large-object";
  },
) => {
  const bootstrapSchema = `${plane.app}_bootstrap`;
  if (!parameters.includes(bootstrapSchema))
    return [{ object_type: "schema", schema_name: bootstrapSchema }];
  if (options.nonempty) {
    return [{ object_type: "relation", schema_name: "public", object_name: "shared_rows" }];
  }
  if (options.nonemptyCustomSchema)
    return [{ object_type: "schema", schema_name: "custom_state", object_name: "custom_state" }];
  if (options.nonemptyObject !== undefined) {
    return [
      {
        object_type: options.nonemptyObject,
        schema_name: "public",
        object_name: `preexisting_${options.nonemptyObject}`,
      },
    ];
  }
  return [];
};
const initialUserObjects = (
  query: string,
  parameters: readonly unknown[],
  options: Parameters<typeof expectedUserObjects>[1],
) =>
  query.includes("WITH user_namespaces AS (")
    ? expectedUserObjects(parameters, options)
    : undefined;
const fixture = (
  options: {
    wrongOwner?: boolean;
    oldDigest?: boolean;
    migrationFailure?: boolean;
    nonempty?: boolean;
    nonemptyCustomSchema?: boolean;
    nonemptyObject?: "view" | "sequence" | "function" | "large-object";
  } = {},
) =>
  Effect.gen(function* () {
    const events: string[] = [];
    const history: { id: number; name: string; digest: string }[] = options.oldDigest
      ? [{ id: 0, name: "generated-schema", digest: "old" }]
      : [];
    const execute: Connection["execute"] = (query, parameters) =>
      Effect.sync(() => {
        events.push(query);
        if (query.includes("current_database"))
          return [
            {
              database: plane.database,
              owner: options.wrongOwner ? "shared-owner" : plane.migrationOwner,
            },
          ];
        if (query.startsWith("SELECT id, name, digest")) return history;
        const userObjects = initialUserObjects(query, parameters, options);
        if (userObjects !== undefined) return userObjects;
        if (query.startsWith("INSERT INTO") && query.includes("artifacts"))
          history.push({
            id: Number(parameters[0]),
            name: String(parameters[1]),
            digest: String(parameters[2]),
          });
        return [];
      });
    const connection: Connection = {
      execute,
      executeRaw: (query, parameters) => execute(query, parameters, undefined),
      executeUnprepared: execute,
      executeValues: () => Effect.succeed([]),
      executeStream: () => Stream.empty,
    };
    const sql = yield* SqlClient.make({
      acquirer: Effect.succeed(connection),
      compiler: Statement.makeCompilerSqlite(),
      spanAttributes: [],
    }).pipe(Effect.provide(Reactivity.layer));
    const program = (
      schema = bytes,
      overrides: {
        readonly migrations?: readonly OwnedMigrationArtifact[];
        readonly plane?: typeof plane;
      } = {},
    ) =>
      initializeOwnedApplication({
        plane,
        generatedSchema: schema,
        applyGeneratedSchema: (artifactBytes) =>
          Effect.sync(() => {
            expect(artifactBytes).toEqual(schema);
            events.push("generated");
          }),
        migrations: [
          {
            id: 1,
            name: "initial",
            bytes,
            apply: (artifactBytes) =>
              options.migrationFailure
                ? Effect.fail(new Error("migration-failed"))
                : Effect.sync(() => {
                    expect(artifactBytes).toEqual(bytes);
                    events.push("migration");
                  }),
          },
        ],
        ...overrides,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    return { events, history, program };
  });

it.effect("checks immutable bytes before SQL and applies schema then migrations only once", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    expect((yield* Effect.exit(f.program(new TextEncoder().encode("modified"))))._tag).toBe(
      "Failure",
    );
    expect(f.events).toEqual([]);
    yield* f.program();
    expect(f.events.indexOf("generated")).toBeLessThan(f.events.indexOf("migration"));
    expect(f.events.some((e) => e.includes("pg_advisory_xact_lock"))).toBe(true);
    yield* f.program();
    expect(f.events.filter((e) => e === "migration")).toHaveLength(1);
    expect(f.history.map((entry) => entry.digest)).toEqual([hash, hash]);
  }),
);
for (const condition of ["wrongOwner", "oldDigest", "nonempty", "migrationFailure"] as const)
  it.effect(`blocks bootstrap on ${condition}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture({ [condition]: true });
      expect((yield* Effect.exit(f.program()))._tag).toBe("Failure");
      expect(f.events).not.toContain("migration");
      if (condition !== "wrongOwner") expect(f.events.at(-1)).toBe("ROLLBACK");
      else expect(f.events.some((e) => e.startsWith("CREATE"))).toBe(false);
    }),
  );
it.effect("rejects a non-public schema before generated schema or migration work", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ nonemptyCustomSchema: true });
    expect((yield* Effect.exit(f.program()))._tag).toBe("Failure");
    expect(f.events).not.toContain("generated");
    expect(f.events).not.toContain("migration");
    expect(f.events.some((event) => event.includes("FROM pg_catalog.pg_namespace"))).toBe(true);
  }),
);

for (const objectType of ["view", "sequence", "function", "large-object"] as const)
  it.effect(`rejects a preexisting ${objectType} before generated schema or migration work`, () =>
    Effect.gen(function* () {
      const f = yield* fixture({ nonemptyObject: objectType });
      expect((yield* Effect.exit(f.program()))._tag).toBe("Failure");
      expect(f.events).not.toContain("generated");
      expect(f.events).not.toContain("migration");
      expect(f.events.some((event) => event.includes("pg_catalog.pg_namespace"))).toBe(true);
      const catalogByObject = {
        view: "pg_catalog.pg_class",
        sequence: "pg_catalog.pg_class",
        function: "pg_catalog.pg_proc",
        "large-object": "pg_catalog.pg_largeobject_metadata",
      } as const;
      const catalog = catalogByObject[objectType];
      expect(f.events.some((event) => event.includes(catalog))).toBe(true);
    }),
  );

const invalidMigrations: readonly {
  readonly name: string;
  readonly migrations: readonly OwnedMigrationArtifact[];
}[] = [
  { name: "missing migration", migrations: [] },
  {
    name: "wrong identifier",
    migrations: [{ id: 2, name: "initial", bytes, apply: () => Effect.die("must not apply") }],
  },
  {
    name: "renamed artifact",
    migrations: [{ id: 1, name: "renamed", bytes, apply: () => Effect.die("must not apply") }],
  },
  {
    name: "changed bytes",
    migrations: [
      {
        id: 1,
        name: "initial",
        bytes: new TextEncoder().encode("changed"),
        apply: () => Effect.die("must not apply"),
      },
    ],
  },
];
for (const testCase of invalidMigrations)
  it.effect(`rejects ${testCase.name} before SQL`, () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect((yield* Effect.exit(f.program(bytes, { migrations: testCase.migrations })))._tag).toBe(
        "Failure",
      );
      expect(f.events).toEqual([]);
    }),
  );
it.effect("rejects a forged migration-owner identity before SQL", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(
      (yield* Effect.exit(f.program(bytes, { plane: { ...plane, migrationOwner: "shared" } })))
        ._tag,
    ).toBe("Failure");
    expect(f.events).toEqual([]);
  }),
);
