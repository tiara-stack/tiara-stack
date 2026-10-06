import { expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  applicationPlaneDigest,
  applicationPlaneIdentity,
  applicationRuntimeConfiguration,
  makeOwnedApplicationResourceAdapter,
  ownedApplicationResource,
  requiredApplicationGrants,
  type ApplicationArtifacts,
  type ApplicationInventory,
  type OwnedApplicationPlane,
  type OwnedApplicationProvider,
  type ApplicationAdmission,
} from "./owned-application-plane";
import {
  makeSyntheticDevelopmentSeed,
  type SyntheticDevelopmentSeed,
} from "./synthetic-development-seed";
import {
  makePreviewAllocationController,
  previewCapacityDimensionsByGroup,
  type CapacityDemand,
  type PreviewResourceAdapter,
} from "./preview-allocations";
import { makePreviewSessionController, type SessionCredentials } from "./preview-sessions";

const artifacts: ApplicationArtifacts = {
  generatedSchema: "1".repeat(64),
  callbacks: "2".repeat(64),
  authorization: "3".repeat(64),
  client: "4".repeat(64),
  deployment: "5".repeat(64),
  zeroVersion: "1.5.0",
  migrations: [{ id: 1, name: "initial", digest: "6".repeat(64) }],
};
const manifests = {
  "application-zero": applicationPlaneDigest(artifacts),
  "deployed-manifest": artifacts.deployment,
};
const demands = previewCapacityDimensionsByGroup["application-zero"].map((dimension) => ({
  dimension,
  amount: dimension === "postgres.roles.count" ? 3 : 1,
  provider: "disposable-test",
  identity: "test-pg",
}));
const base: PreviewResourceAdapter = {
  planProfile: () => Effect.fail(new Error("unavailable")),
  validateProfileAllocation: () => Effect.fail(new Error("unavailable")),
  allocate: () => Effect.fail(new Error("unexpected resource")),
  deleteOwned: () => Effect.fail(new Error("unexpected resource")),
  proveCleanup: () => Effect.succeed(true),
};
const destinations = (sessionId: string) => ({
  callbackOrigin: `https://${sessionId}-db.test`,
  cacheOrigin: `https://${sessionId}-cache.test`,
});
const withTest = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(
    Effect.provide(
      Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
    ),
  );
interface ProviderBarrier {
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}
const makeProviderBarrier = Effect.gen(function* () {
  return { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
});
const waitForProviderReply = (barrier: ProviderBarrier | undefined) =>
  barrier === undefined
    ? Effect.void
    : Effect.gen(function* () {
        yield* Deferred.succeed(barrier.entered, undefined);
        yield* Deferred.await(barrier.release);
      });

const fixture = (
  options: {
    migrationFailure?: boolean;
    partialFailure?: boolean;
    admission?: (value: ApplicationAdmission) => ApplicationAdmission;
    admissionBarrier?: ProviderBarrier;
    demands?: readonly CapacityDemand[];
    fenceBarrier?: ProviderBarrier;
    allocationBarrier?: ProviderBarrier & { readonly stage: "provision" | "migrate" };
    removeBarrier?: ProviderBarrier;
    removeFailure?: boolean;
    seedBindingsMissing?: boolean;
    seedProviderUnavailable?: boolean;
    seedBindingsBarrier?: ProviderBarrier;
  } = {},
) =>
  Effect.gen(function* () {
    let time = Date.now();
    const now = () => time;
    const sql = yield* SqlClient.SqlClient;
    const sessions = yield* makePreviewSessionController(now);
    const planes = new Map<string, OwnedApplicationPlane>();
    const inventory = new Map<string, ApplicationInventory["objects"][number][]>();
    const rows = new Map<string, Map<string, string>>();
    const running = new Set<string>();
    const events: string[] = [];
    const seedRows = new Map<string, SyntheticDevelopmentSeed>();
    const shared = new Map([["shared", "unchanged"]]);
    let terminationProved = true;
    const matchesCallbackIdentity = (
      plane: OwnedApplicationPlane,
      headers: Readonly<Record<string, string | undefined>>,
    ) => headers["x-app"] === plane.app && headers["x-database"] === plane.database;
    const applyMutation = (
      state: Map<string, string>,
      headers: Readonly<Record<string, string | undefined>>,
    ) => state.set(headers["x-mutation"] ?? "", headers["x-value"] ?? "");
    const seedFixtureResponse = (
      sessionId: string,
      headers: Readonly<Record<string, string | undefined>>,
    ) => {
      const seed = seedRows.get(sessionId);
      const authorized =
        seed !== undefined &&
        headers["x-principal-issuer"] === seed.bindings.userPrincipal.issuer &&
        headers["x-principal-subject"] === seed.bindings.userPrincipal.subject &&
        headers["x-discord-account"] === seed.bindings.discordAccount.userId;
      return authorized
        ? HttpServerResponse.json(seed.rows)
        : HttpServerResponse.json({ unavailable: true }, { status: 403 });
    };
    const endpoint = yield* HttpRouter.toHttpEffect(
      HttpRouter.add(
        "POST",
        "/zero/:operation",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const sessionId = request.headers["x-session"] ?? "";
          if (sessionId === "shared") return yield* HttpServerResponse.json([...shared]);
          const plane = planes.get(sessionId);
          const status = yield* sessions.status(sessionId);
          if (
            !plane ||
            !running.has(sessionId) ||
            status.endedAt !== null ||
            !matchesCallbackIdentity(plane, request.headers)
          )
            return yield* HttpServerResponse.json({ unavailable: true }, { status: 503 });
          const state = rows.get(sessionId)!;
          if (request.url === "/zero/fixture")
            return yield* seedFixtureResponse(sessionId, request.headers);
          if (request.url === "/zero/mutate") applyMutation(state, request.headers);
          return yield* HttpServerResponse.json([...state]);
        }),
      ).pipe(Layer.provide(HttpRouter.layer)),
    );
    const request = (
      plane: OwnedApplicationPlane,
      operation: "query" | "mutate" | "fixture",
      mutation = "",
      value = "",
      app = plane.app,
      principalSubject = "developer-1",
    ) =>
      endpoint.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`${plane.callbackOrigin}/zero/${operation}`, {
              method: "POST",
              headers: {
                "x-session": plane.sessionId,
                "x-app": app,
                "x-database": plane.database,
                "x-mutation": mutation,
                "x-value": value,
                "x-principal-issuer": "https://auth.development.test",
                "x-principal-subject": principalSubject,
                "x-discord-account": "discord-account-1",
              },
            }),
          ),
        ),
        Effect.scoped,
      );
    const provider: OwnedApplicationProvider = {
      provider: "disposable-test",
      server: "test-pg",
      demands: options.demands ?? demands,
      inspectAdmission: (plane) =>
        Effect.sync(() => {
          const value: ApplicationAdmission = {
            server: "test-pg",
            observedAt: now(),
            development: true,
            grants: requiredApplicationGrants,
            artifacts,
            sharedDatabases: ["shared"],
            namesAvailable: true,
            scopedCredentials: true,
            planeDigest: applicationPlaneDigest(plane),
          };
          return options.admission?.(value) ?? value;
        }).pipe(Effect.tap(() => waitForProviderReply(options.admissionBarrier))),
      provision: (plane) =>
        Effect.gen(function* () {
          events.push("provision");
          planes.set(plane.sessionId, plane);
          rows.set(plane.sessionId, new Map());
          const objects = plane.resources.flatMap((r) =>
            r.kind === "slot-prefix" || r.kind === "slot"
              ? []
              : [
                  {
                    kind: r.kind,
                    name: r.name,
                    ownerToken: plane.ownerToken,
                    database: plane.database,
                    active: false,
                  },
                ],
          );
          inventory.set(plane.sessionId, options.partialFailure ? objects.slice(0, 2) : objects);
          // The provider effect is terminal; only delivery of its reply is delayed.
          if (options.allocationBarrier?.stage === "provision")
            yield* waitForProviderReply(options.allocationBarrier);
          if (options.partialFailure) return yield* Effect.fail(new Error("partial-provision"));
        }),
      migrate: () =>
        Effect.gen(function* () {
          events.push("migrate");
          if (options.allocationBarrier?.stage === "migrate")
            yield* waitForProviderReply(options.allocationBarrier);
          if (options.migrationFailure) return yield* Effect.fail(new Error("migration-failed"));
          return artifacts;
        }),
      ...(options.seedProviderUnavailable
        ? {}
        : {
            resolveSeedBindings: (_plane: OwnedApplicationPlane, _seedId: string) =>
              options.seedBindingsMissing
                ? Effect.fail(new Error("development-seed-bindings-unavailable"))
                : Effect.succeed({
                    userPrincipal: {
                      issuer: "https://auth.development.test",
                      subject: "developer-1",
                    },
                    discordAccount: { platform: "discord" as const, userId: "discord-account-1" },
                    target: { guildId: "development-guild", channelId: "development-channel" },
                  }).pipe(Effect.tap(() => waitForProviderReply(options.seedBindingsBarrier))),
            applySeed: (plane: OwnedApplicationPlane, seed: SyntheticDevelopmentSeed) =>
              Effect.sync(() => {
                events.push(`seed:${seed.id}`);
                const existing = seedRows.get(plane.sessionId);
                if (existing !== undefined && existing.identity !== seed.identity)
                  throw new Error("synthetic-seed-identity-conflict");
                if (existing === undefined) seedRows.set(plane.sessionId, seed);
                return { identity: seed.identity, inserted: existing === undefined };
              }),
          }),
      start: (plane, configuration) =>
        Effect.sync(() => {
          events.push("start");
          expect(configuration).toEqual(applicationRuntimeConfiguration(plane));
          expect(configuration.seed).toBe(false);
          expect(configuration.zero.queryURL).toBe(`${plane.callbackOrigin}/zero/query`);
          running.add(plane.sessionId);
        }),
      ready: (plane) =>
        Effect.gen(function* () {
          events.push("endpoint-ready");
          expect((yield* request(plane, "query")).status).toBe(200);
          return {
            sessionId: plane.sessionId,
            generation: plane.generation,
            database: plane.database,
            app: plane.app,
            callbackOrigin: plane.callbackOrigin,
            cacheOrigin: plane.cacheOrigin,
            storageKey: plane.storageKey,
            artifacts,
          };
        }),
      fence: (plane) =>
        Effect.gen(function* () {
          running.delete(plane.sessionId);
          events.push("fence");
          yield* waitForProviderReply(options.fenceBarrier);
        }),
      inventory: (plane) =>
        Effect.sync(() => ({
          server: plane.server,
          database: plane.database,
          app: plane.app,
          ownerToken: plane.ownerToken,
          operationsTerminal: terminationProved,
          writersTerminated: terminationProved,
          objects: inventory.get(plane.sessionId) ?? [],
        })),
      remove: (plane, object) =>
        Effect.gen(function* () {
          yield* waitForProviderReply(options.removeBarrier);
          if (options.removeFailure) return yield* Effect.fail(new Error("removal-failed"));
          events.push(`remove:${object.kind}:${object.name}`);
          inventory.set(
            plane.sessionId,
            inventory.get(plane.sessionId)!.filter((entry) => entry !== object),
          );
        }),
    };
    const adapter = yield* makeOwnedApplicationResourceAdapter(base, provider, {
      profile: "owned-test",
      artifacts,
      destinations,
      now,
    });
    const allocations = yield* makePreviewAllocationController(adapter, now);
    for (const demand of demands)
      yield* allocations.observeCapacity({
        ...demand,
        total: 10,
        inUse: 0,
        grantsVerified: true,
        observedAt: now(),
      });
    const supervisors: SessionCredentials[] = [];
    const create = (selectedManifests = manifests) =>
      sessions
        .create({
          owner: "test",
          checkout: "/test",
          requestedRevision: "revision",
          manifests: selectedManifests,
        })
        .pipe(
          Effect.tap((credentials) =>
            Effect.sync(() => {
              supervisors.push(credentials);
            }),
          ),
        );
    const start = (sessionId: string, seedId?: string) =>
      allocations.reserveAndAllocate({
        sessionId,
        demands,
        resources: ["application-zero"],
        ...(seedId === undefined ? {} : { resourceMetadata: { "application-zero": { seedId } } }),
      });
    const cleanup = (input: { sessionId: string }) =>
      Effect.gen(function* () {
        const first = yield* allocations.cleanup(input);
        if (first !== "waiting") return first;
        for (let i = 0; i < 10; i++) {
          time += 30_000;
          for (const supervisor of supervisors) {
            if (supervisor.session.id !== input.sessionId)
              yield* Effect.result(
                sessions.heartbeat(supervisor.session.id, supervisor.supervisorIdentity, 1),
              );
          }
        }
        return yield* allocations.cleanup(input);
      });
    return {
      sessions,
      allocations,
      cleanup,
      adapter,
      create,
      start,
      simulateProcessCrash: (sessionId: string, phase: "provisioning" | "migrating" | "starting") =>
        Effect.gen(function* () {
          const plane = planes.get(sessionId);
          if (plane === undefined) return yield* Effect.die("missing owned plane test fixture");
          const phaseRows =
            yield* sql`UPDATE preview_application_planes SET phase=${phase} WHERE session_id=${sessionId} AND owner_token=${plane.ownerToken} RETURNING session_id`;
          const allocationRows =
            yield* sql`UPDATE preview_allocation_ledger SET provider_resource_id=NULL, state='allocating', failure=NULL WHERE session_id=${sessionId} AND resource=${ownedApplicationResource} AND owner_token=${plane.ownerToken} RETURNING resource`;
          if (phaseRows.length !== 1 || allocationRows.length !== 1)
            return yield* Effect.die("could not simulate crashed allocation");
        }),
      planes,
      inventory,
      rows,
      shared,
      events,
      seedRows,
      request,
      setTermination: (value: boolean) => {
        terminationProved = value;
      },
      makeAdapter: () =>
        makeOwnedApplicationResourceAdapter(base, provider, {
          profile: "owned-test",
          artifacts,
          destinations,
          now,
        }),
    };
  });

it.effect(
  "uses two empty owned groups through session endpoints and preserves shared control",
  () =>
    withTest(
      Effect.gen(function* () {
        const f = yield* fixture();
        const a = yield* f.create();
        const b = yield* f.create();
        yield* f.start(a.session.id);
        yield* f.start(b.session.id);
        const first = f.planes.get(a.session.id)!;
        const second = f.planes.get(b.session.id)!;
        const control = { ...first, sessionId: "shared", callbackOrigin: "https://shared.test" };
        const read = (target: OwnedApplicationPlane) =>
          Effect.gen(function* () {
            const response = yield* f.request(target, "query");
            expect(response.status).toBe(200);
            return yield* Effect.promise(() => HttpServerResponse.toWeb(response).json());
          });
        expect(yield* read(control)).toEqual([["shared", "unchanged"]]);
        expect(first.database).not.toBe(second.database);
        expect(first.app).not.toBe(second.app);
        expect(first.storageKey).not.toBe(second.storageKey);
        expect([...f.rows.get(a.session.id)!]).toEqual([]);
        expect((yield* f.request(first, "mutate", "m1", "a")).status).toBe(200);
        expect((yield* f.request(second, "mutate", "m1", "b")).status).toBe(200);
        expect((yield* f.request(first, "query", "", "", second.app)).status).toBe(503);
        expect([...f.rows.get(a.session.id)!]).toEqual([["m1", "a"]]);
        expect([...f.rows.get(b.session.id)!]).toEqual([["m1", "b"]]);
        expect(yield* read(first)).toEqual([["m1", "a"]]);
        expect(yield* read(second)).toEqual([["m1", "b"]]);
        expect([...f.shared]).toEqual([["shared", "unchanged"]]);
        expect(f.events.slice(0, 4)).toEqual(["provision", "migrate", "start", "endpoint-ready"]);
        yield* f.sessions.stop(a.session.id, a.ownerIdentity);
        expect((yield* f.request(first, "mutate", "m2", "late")).status).toBe(503);
        expect(yield* f.cleanup({ sessionId: a.session.id })).toBe("cleaned");
        expect(f.inventory.get(a.session.id)).toEqual([]);
        expect((yield* f.request(second, "query")).status).toBe(200);
        expect(f.inventory.get(b.session.id)!.length).toBeGreaterThan(0);
        expect(yield* read(control)).toEqual([["shared", "unchanged"]]);
        expect([...f.shared]).toEqual([["shared", "unchanged"]]);
        expect(yield* f.cleanup({ sessionId: a.session.id })).toBe("cleaned");
      }),
    ),
);

it.effect(
  "seeds a newly migrated owned plane once before startup with deterministic bindings",
  () =>
    withTest(
      Effect.gen(function* () {
        const f = yield* fixture();
        const session = yield* f.create();
        yield* f.start(session.session.id, "synthetic-development-v1");
        expect(f.events.slice(0, 5)).toEqual([
          "provision",
          "migrate",
          "seed:synthetic-development-v1",
          "start",
          "endpoint-ready",
        ]);
        expect(f.seedRows.get(session.session.id)).toEqual({
          id: "synthetic-development-v1",
          identity: expect.any(String),
          bindings: {
            userPrincipal: { issuer: "https://auth.development.test", subject: "developer-1" },
            discordAccount: { platform: "discord", userId: "discord-account-1" },
            target: { guildId: "development-guild", channelId: "development-channel" },
          },
          rows: {
            configUserPlatform: [
              {
                platform: "discord",
                userId: "discord-account-1",
                defaultClientId: null,
                checkinDmEnabled: false,
                monitorDmEnabled: false,
                createdAt: 1_700_000_000_000,
                updatedAt: 1_700_000_000_000,
                deletedAt: null,
              },
            ],
            configWorkspace: [
              {
                workspaceId: "development-guild",
                sheetId: null,
                autoCheckin: false,
                monitorConversationId: null,
                announcementConversationId: null,
                createdAt: 1_700_000_000_000,
                updatedAt: 1_700_000_000_000,
                deletedAt: null,
              },
            ],
            configWorkspaceConversation: [
              {
                workspaceId: "development-guild",
                conversationId: "development-channel",
                name: "Synthetic development fixture",
                running: false,
                roleId: null,
                checkinConversationId: null,
                createdAt: 1_700_000_000_000,
                updatedAt: 1_700_000_000_000,
                deletedAt: null,
              },
            ],
          },
        });
        const seeded = f.seedRows.get(session.session.id)!;
        const repeated = yield* makeSyntheticDevelopmentSeed(seeded.id, seeded.bindings);
        expect(repeated).toEqual(seeded);
        const output = yield* f.allocations.inspect(session.session.id);
        expect(output.allocations[0]?.providerResourceId).toContain(
          "seed=synthetic-development-v1;status=complete",
        );
        const plane = f.planes.get(session.session.id)!;
        const recoveredAdapter = yield* f.makeAdapter();
        const proveCleanup = recoveredAdapter.proveCleanup;
        if (proveCleanup === undefined)
          return yield* Effect.die("missing owned application cleanup proof");
        const cleanupInput = {
          sessionId: session.session.id,
          resources: [
            {
              resource: ownedApplicationResource,
              ownerToken: plane.ownerToken,
              providerResourceId: output.allocations[0]!.providerResourceId,
            },
          ],
        };
        expect(yield* proveCleanup(cleanupInput)).toBe(true);
        expect(
          yield* proveCleanup({
            ...cleanupInput,
            resources: [
              {
                ...cleanupInput.resources[0]!,
                providerResourceId: `owned-application:${session.session.id}:seed=other;status=complete`,
              },
            ],
          }),
        ).toBe(false);
        expect(
          yield* proveCleanup({
            ...cleanupInput,
            resources: [
              {
                ...cleanupInput.resources[0]!,
                providerResourceId: `owned-application:${session.session.id}`,
              },
            ],
          }),
        ).toBe(true);
        expect(f.events.filter((event) => event.startsWith("seed:"))).toHaveLength(1);
        expect((yield* Effect.exit(f.start(session.session.id)))._tag).toBe("Failure");
        expect(f.events.filter((event) => event.startsWith("seed:"))).toHaveLength(1);
        const fixtureResponse = yield* f.request(f.planes.get(session.session.id)!, "fixture");
        expect(fixtureResponse.status).toBe(200);
        expect(
          yield* Effect.promise(() => HttpServerResponse.toWeb(fixtureResponse).json()),
        ).toEqual(f.seedRows.get(session.session.id)?.rows);
        const wrongPrincipal = yield* f.request(
          f.planes.get(session.session.id)!,
          "fixture",
          "",
          "",
          f.planes.get(session.session.id)!.app,
          "different-principal",
        );
        expect(wrongPrincipal.status).toBe(403);
      }),
    ),
);

it.effect("blocks selected seeding when trusted development bindings are unavailable", () =>
  withTest(
    Effect.gen(function* () {
      const f = yield* fixture({ seedBindingsMissing: true });
      const session = yield* f.create();
      expect(
        (yield* Effect.exit(f.start(session.session.id, "synthetic-development-v1")))._tag,
      ).toBe("Failure");
      expect(f.events).not.toContain("start");
      expect(f.events).not.toContain("seed:synthetic-development-v1");
      expect(f.seedRows.size).toBe(0);
    }),
  ),
);

it.effect(
  "rejects a selected seed before provider effects when seed operations are unavailable",
  () =>
    withTest(
      Effect.gen(function* () {
        const f = yield* fixture({ seedProviderUnavailable: true });
        const session = yield* f.create();
        const result = yield* Effect.result(
          f.start(session.session.id, "synthetic-development-v1"),
        );
        expect(result).toMatchObject({ _tag: "Failure" });
        expect(f.events).toEqual([]);
      }),
    ),
);

it.effect("does not apply seed rows when the session stops during binding resolution", () =>
  withTest(
    Effect.gen(function* () {
      const seedBindings = yield* makeProviderBarrier;
      const f = yield* fixture({
        seedBindingsBarrier: seedBindings,
      });
      const session = yield* f.create();
      const allocation = yield* f
        .start(session.session.id, "synthetic-development-v1")
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(seedBindings.entered);
      yield* f.sessions.stop(session.session.id, session.ownerIdentity);
      yield* Deferred.succeed(seedBindings.release, undefined);
      expect((yield* Fiber.join(allocation))._tag).toBe("Failure");
      expect(f.events).not.toContain("seed:synthetic-development-v1");
      expect(f.events).not.toContain("start");
      expect(f.seedRows.size).toBe(0);
    }),
  ),
);

it.effect("does not seed or start when an owned-plane migration fails", () =>
  withTest(
    Effect.gen(function* () {
      const f = yield* fixture({
        migrationFailure: true,
      });
      const session = yield* f.create();
      expect(
        (yield* Effect.exit(f.start(session.session.id, "synthetic-development-v1")))._tag,
      ).toBe("Failure");
      expect(f.events).toEqual(["provision", "migrate"]);
      expect(f.seedRows.size).toBe(0);
    }),
  ),
);

it.effect("preserves session rejection inside reservation without writing owned state", () =>
  withTest(
    Effect.gen(function* () {
      const admission = yield* makeProviderBarrier;
      const f = yield* fixture({ admissionBarrier: admission });
      let allocationFailure: Error | undefined;
      const allocations = yield* makePreviewAllocationController({
        ...f.adapter,
        allocate: (input) =>
          f.adapter.allocate(input).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                allocationFailure = error;
              }),
            ),
          ),
      });
      const session = yield* f.create();
      const allocation = yield* allocations
        .reserveAndAllocate({
          sessionId: session.session.id,
          demands,
          resources: [ownedApplicationResource],
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(admission.entered);
      yield* f.sessions.stop(session.session.id, session.ownerIdentity);
      yield* Deferred.succeed(admission.release, undefined);
      expect((yield* Fiber.join(allocation))._tag).toBe("Failure");
      expect(allocationFailure).toMatchObject({
        _tag: "OwnedApplicationError",
        reason: "session-not-pending",
      });
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT * FROM preview_application_planes`).toEqual([]);
      expect(yield* sql`SELECT * FROM preview_application_names`).toEqual([]);
      expect(f.events).not.toContain("provision");
    }),
  ),
);

it.effect("requires one database capacity unit before provisioning", () =>
  withTest(
    Effect.gen(function* () {
      const underReservedDemands = demands.map((demand) =>
        demand.dimension === "postgres.databases.count" ? { ...demand, amount: 0.5 } : demand,
      );
      const f = yield* fixture({ demands: underReservedDemands });
      const session = yield* f.create();
      expect((yield* Effect.exit(f.start(session.session.id)))._tag).toBe("Failure");
      expect(f.events).not.toContain("provision");
    }),
  ),
);

for (const failure of ["migrationFailure", "partialFailure"] as const) {
  it.effect(`${failure} blocks endpoints and resolves exact partial cleanup without any slot`, () =>
    withTest(
      Effect.gen(function* () {
        const f = yield* fixture({ [failure]: true });
        const a = yield* f.create();
        expect((yield* Effect.exit(f.start(a.session.id)))._tag).toBe("Failure");
        expect(f.events).not.toContain("start");
        expect((yield* f.request(f.planes.get(a.session.id)!, "query")).status).toBe(503);
        yield* f.sessions.stop(a.session.id, a.ownerIdentity);
        expect(yield* f.cleanup({ sessionId: a.session.id })).toBe("quarantined");
        expect(
          (yield* f.allocations.inspect(a.session.id)).reservations.every(
            (r) => r.releasedAt === null,
          ),
        ).toBe(true);
        yield* f.allocations.resolveUnknownAllocation({
          sessionId: a.session.id,
          resource: "application-zero",
        });
        expect(yield* f.cleanup({ sessionId: a.session.id })).toBe("cleaned");
        expect(f.inventory.get(a.session.id)).toEqual([]);
        expect([...f.shared]).toEqual([["shared", "unchanged"]]);
      }),
    ),
  );
}

for (const phase of ["provisioning", "migrating", "starting"] as const) {
  it.effect(`recovers a process crash left in ${phase} after terminal provider proof`, () =>
    withTest(
      Effect.gen(function* () {
        const f = yield* fixture();
        const session = yield* f.create();
        yield* f.start(session.session.id);
        yield* f.simulateProcessCrash(session.session.id, phase);
        const plane = f.planes.get(session.session.id);
        if (plane === undefined) return yield* Effect.die("missing owned plane test fixture");
        const resolution = {
          sessionId: session.session.id,
          resource: ownedApplicationResource,
          ownerToken: plane.ownerToken,
          providerIdentities: [{ provider: "disposable-test", identity: "test-pg" }],
        };
        const resolveUnknown = f.adapter.resolveUnknown;
        if (resolveUnknown === undefined)
          return yield* Effect.die("missing owned plane resolution adapter");
        if (phase === "provisioning") {
          expect((yield* Effect.exit(resolveUnknown(resolution)))._tag).toBe("Failure");
          expect(f.events.filter((event) => event === "fence")).toHaveLength(0);
        }
        yield* f.sessions.stop(session.session.id, session.ownerIdentity);

        expect(yield* f.allocations.resolveUnknownAllocation(resolution)).toBe("resolved-owned");
        expect(f.events.filter((event) => event === "fence")).toHaveLength(1);
        expect(
          (yield* f.allocations.inspect(session.session.id)).reservations.every(
            (reservation) => reservation.releasedAt === null,
          ),
        ).toBe(true);
        expect(yield* f.cleanup({ sessionId: session.session.id })).toBe("cleaned");
        expect(f.inventory.get(session.session.id)).toEqual([]);
      }),
    ),
  );
}

it.effect("keeps crash-left reservations until provider operations are proved terminal", () =>
  withTest(
    Effect.gen(function* () {
      const f = yield* fixture();
      const session = yield* f.create();
      yield* f.start(session.session.id);
      yield* f.simulateProcessCrash(session.session.id, "migrating");
      yield* f.sessions.stop(session.session.id, session.ownerIdentity);
      f.setTermination(false);

      expect(
        (yield* Effect.exit(
          f.allocations.resolveUnknownAllocation({
            sessionId: session.session.id,
            resource: ownedApplicationResource,
          }),
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* f.allocations.inspect(session.session.id)).reservations.every(
          (reservation) => reservation.releasedAt === null,
        ),
      ).toBe(true);

      f.setTermination(true);
      expect(
        yield* f.allocations.resolveUnknownAllocation({
          sessionId: session.session.id,
          resource: ownedApplicationResource,
        }),
      ).toBe("resolved-owned");
      expect(yield* f.cleanup({ sessionId: session.session.id })).toBe("cleaned");
    }),
  ),
);

it.effect("serializes unknown plane resolution and refuses released owner records", () =>
  withTest(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const f = yield* fixture({
        partialFailure: true,
        fenceBarrier: { entered, release },
      });
      const session = yield* f.create();
      expect((yield* Effect.exit(f.start(session.session.id)))._tag).toBe("Failure");
      yield* f.sessions.stop(session.session.id, session.ownerIdentity);
      const plane = f.planes.get(session.session.id);
      if (plane === undefined) return yield* Effect.die("missing owned plane test fixture");
      const resolution = {
        sessionId: session.session.id,
        resource: ownedApplicationResource,
        ownerToken: plane.ownerToken,
        providerIdentities: [{ provider: "disposable-test", identity: "test-pg" }],
      };

      const first = yield* f.allocations
        .resolveUnknownAllocation(resolution)
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      expect((yield* Effect.exit(f.allocations.resolveUnknownAllocation(resolution)))._tag).toBe(
        "Failure",
      );
      expect(f.events.filter((event) => event === "fence")).toHaveLength(1);

      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(first)).toBe("resolved-owned");
      expect(yield* f.cleanup({ sessionId: session.session.id })).toBe("cleaned");
      expect(f.events.filter((event) => event === "fence")).toHaveLength(2);

      const resolveUnknown = f.adapter.resolveUnknown;
      if (resolveUnknown === undefined)
        return yield* Effect.die("missing owned plane resolution adapter");
      expect((yield* Effect.exit(resolveUnknown(resolution)))._tag).toBe("Failure");
      expect(f.events.filter((event) => event === "fence")).toHaveLength(2);
    }),
  ),
);

it.effect("quarantines active backends and foreign ownership, retaining all reservations", () =>
  withTest(
    Effect.gen(function* () {
      const f = yield* fixture();
      const a = yield* f.create();
      yield* f.start(a.session.id);
      yield* f.sessions.stop(a.session.id, a.ownerIdentity);
      f.setTermination(false);
      expect(yield* f.cleanup({ sessionId: a.session.id })).toBe("quarantined");
      expect(f.events.some((e) => e.startsWith("remove:"))).toBe(false);
      f.setTermination(true);
      const objects = f.inventory.get(a.session.id)!;
      const foreign = {
        kind: "slot" as const,
        name: "another_app_0_slot",
        database: "shared",
        ownerToken: "someone-else",
        active: true,
      };
      objects.push(foreign);
      expect(yield* f.cleanup({ sessionId: a.session.id })).toBe("quarantined");
      expect(f.events.some((e) => e.startsWith("remove:"))).toBe(false);
      expect(
        (yield* f.allocations.inspect(a.session.id)).reservations.every(
          (r) => r.releasedAt === null,
        ),
      ).toBe(true);
      const sql = yield* SqlClient.SqlClient;
      expect(
        (yield* sql`SELECT name FROM preview_application_names WHERE session_id=${a.session.id}`)
          .length,
      ).toBeGreaterThan(0);
      objects.pop();
      expect(yield* f.cleanup({ sessionId: a.session.id })).toBe("cleaned");
    }),
  ),
);

const slotCases: readonly {
  readonly name: string;
  readonly slot: (plane: OwnedApplicationPlane) => Partial<ApplicationInventory["objects"][number]>;
  readonly expected: "cleaned" | "quarantined";
}[] = [
  { name: "exact legacy slot", slot: (plane) => ({ name: `${plane.app}_0` }), expected: "cleaned" },
  {
    name: "reserved dynamic slot",
    slot: (plane) => ({ name: `${plane.app}_0_1234567890123` }),
    expected: "cleaned",
  },
  {
    name: "legacy namespace slot",
    slot: (plane) => ({ name: `zero_${plane.app}` }),
    expected: "cleaned",
  },
  {
    name: "prefix lookalike",
    slot: (plane) => ({ name: `${plane.app}_01_123` }),
    expected: "quarantined",
  },
  {
    name: "invalid slot characters",
    slot: (plane) => ({ name: `${plane.app}_0_UPPER` }),
    expected: "quarantined",
  },
  { name: "foreign slot owner", slot: () => ({ ownerToken: "foreign" }), expected: "quarantined" },
  { name: "foreign slot database", slot: () => ({ database: "shared" }), expected: "quarantined" },
  { name: "active owned slot", slot: () => ({ active: true }), expected: "quarantined" },
];
for (const testCase of slotCases)
  it.effect(`checks ${testCase.name} independently before removal`, () =>
    withTest(
      Effect.gen(function* () {
        const f = yield* fixture();
        const session = yield* f.create();
        yield* f.start(session.session.id);
        const plane = f.planes.get(session.session.id)!;
        f.inventory.get(plane.sessionId)!.push({
          kind: "slot",
          name: `${plane.app}_0_123`,
          ownerToken: plane.ownerToken,
          database: plane.database,
          active: false,
          ...testCase.slot(plane),
        });
        yield* f.sessions.stop(plane.sessionId, session.ownerIdentity);
        expect(yield* f.cleanup({ sessionId: plane.sessionId })).toBe(testCase.expected);
        if (testCase.expected === "quarantined") {
          expect(f.events.some((event) => event.startsWith("remove:"))).toBe(false);
          expect(
            (yield* f.allocations.inspect(plane.sessionId)).reservations.every(
              (reservation) => reservation.releasedAt === null,
            ),
          ).toBe(true);
        } else expect(f.inventory.get(plane.sessionId)).toEqual([]);
      }),
    ),
  );

for (const reason of ["grants", "digest", "identity", "collision", "shared", "stale"] as const) {
  it.effect(`rejects ${reason} before provisioning`, () =>
    withTest(
      Effect.gen(function* () {
        const f = yield* fixture({
          admission: (value) => ({
            ...value,
            ...(reason === "grants" ? { grants: [] } : {}),
            ...(reason === "digest"
              ? { artifacts: { ...artifacts, callbacks: "7".repeat(64) } }
              : {}),
            ...(reason === "identity" ? { planeDigest: "wrong" } : {}),
            ...(reason === "collision" ? { namesAvailable: false } : {}),
            ...(reason === "shared" ? { development: false } : {}),
            ...(reason === "stale" ? { observedAt: 0 } : {}),
          }),
        });
        const a = yield* f.create();
        expect((yield* Effect.exit(f.start(a.session.id)))._tag).toBe("Failure");
        expect(f.events).toEqual([]);
        yield* f.sessions.stop(a.session.id, a.ownerIdentity);
        yield* f.allocations.resolveUnknownAllocation({
          sessionId: a.session.id,
          resource: "application-zero",
        });
        expect(yield* f.cleanup({ sessionId: a.session.id })).toBe("cleaned");
      }),
    ),
  );
}

it("bounds generated and legacy PostgreSQL identifiers independently of branch/session length", () => {
  const plane = applicationPlaneIdentity({
    sessionId: "a".repeat(1000),
    ownerToken: "owner",
    server: "server",
    generation: 1,
    ...destinations("test"),
    artifacts,
  });
  expect(
    plane.resources
      .filter((r) => !["file", "grant"].includes(r.kind))
      .every((r) => Buffer.byteLength(r.name) <= 63),
  ).toBe(true);
  expect(plane.resources).toContainEqual({ kind: "schema", name: `zero_${plane.app}` });
});

it("uses locale-independent code-point ordering for nested canonical digests", () => {
  const value = {
    "😀": 10,
    "\uE000": 9,
    ä: 8,
    a: [{ z: 5, A: 6 }, 7],
    _: 4,
    Z: 3,
    A: { a: 1, Z: 2 },
  };
  const expected = "092aab62b0e71a8e4f6fa36dae6665f99f0c79239241dde8706187f26cbd96bd";
  expect(applicationPlaneDigest(value)).toBe(expected);
  expect(applicationPlaneDigest(Object.fromEntries(Object.entries(value).reverse()))).toBe(
    expected,
  );
});

type PlaneFixture = Effect.Success<ReturnType<typeof fixture>>;
for (const scenario of [
  {
    name: "unknown owner",
    reason: "unknown-plane-owner",
    mutation: "DELETE FROM preview_application_planes",
  },
  {
    name: "malformed JSON",
    reason: "invalid-plane-journal-record",
    mutation: "UPDATE preview_application_planes SET plane='{'",
  },
  {
    name: "invalid plane schema",
    reason: "invalid-plane-journal-record",
    mutation: "UPDATE preview_application_planes SET plane='{}'",
  },
  {
    name: "invalid lifecycle phase",
    reason: "invalid-plane-journal-record",
    mutation: "UPDATE preview_application_planes SET phase='unexpected-phase'",
  },
  {
    name: "SQL failure",
    reason: "plane-journal-unavailable",
    mutation: "DROP TABLE preview_application_planes",
  },
])
  it.effect(`preserves the load error for ${scenario.name}`, () =>
    withTest(
      Effect.gen(function* () {
        const f = yield* fixture();
        const session = yield* f.create();
        yield* f.start(session.session.id);
        const plane = f.planes.get(session.session.id)!;
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(scenario.mutation);
        const result = yield* Effect.result(
          f.adapter.deleteOwned({
            sessionId: plane.sessionId,
            resource: ownedApplicationResource,
            ownerToken: plane.ownerToken,
            providerResourceId: `owned-application:${plane.sessionId}`,
          }),
        );
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "OwnedApplicationError", reason: scenario.reason },
        });
        expect(f.events).not.toContain("fence");
        expectSingleRemoval(f, 0);
      }),
    ),
  );

const expectPlaneState = (f: PlaneFixture, sessionId: string, phase: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const released = phase === "deleted";
    expect(
      yield* sql`SELECT phase, released FROM preview_application_planes WHERE session_id=${sessionId}`,
    ).toEqual([{ phase, released: released ? 1 : 0 }]);
    expect(
      (yield* f.allocations.inspect(sessionId)).reservations.every(
        (reservation) => (reservation.releasedAt !== null) === released,
      ),
    ).toBe(true);
    const names =
      yield* sql`SELECT name FROM preview_application_names WHERE session_id=${sessionId}`;
    expect(names.length > 0).toBe(!released);
  });
const expectSingleRemoval = (f: PlaneFixture, count: number) => {
  const removals = f.events.filter((event) => event.startsWith("remove:"));
  expect(removals).toHaveLength(count);
  expect(new Set(removals).size).toBe(count);
};
const pendingAllocation = (
  stage: "provision" | "migrate",
  options: Parameters<typeof fixture>[0] = {},
) =>
  Effect.gen(function* () {
    const reply = yield* makeProviderBarrier;
    const f = yield* fixture({ ...options, allocationBarrier: { ...reply, stage } });
    const session = yield* f.create();
    const allocation = yield* f.start(session.session.id).pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(reply.entered);
    yield* f.sessions.stop(session.session.id, session.ownerIdentity);
    const plane = f.planes.get(session.session.id);
    if (plane === undefined) return yield* Effect.die("missing delayed plane fixture");
    const target = { sessionId: plane.sessionId, resource: ownedApplicationResource };
    return {
      f,
      reply,
      allocation,
      plane,
      target,
      objectCount: f.inventory.get(plane.sessionId)!.length,
    };
  });

it.effect(
  "does not overwrite an unknown-resolution claim when an allocation reply arrives late",
  () =>
    withTest(
      Effect.gen(function* () {
        const fence = yield* makeProviderBarrier;
        const pending = yield* pendingAllocation("provision", { fenceBarrier: fence });
        const { f, target } = pending;
        const resolution = yield* f.allocations
          .resolveUnknownAllocation(target)
          .pipe(Effect.forkChild);
        yield* Deferred.await(fence.entered);
        yield* expectPlaneState(f, target.sessionId, "resolving");
        yield* Deferred.succeed(pending.reply.release, undefined);
        expect((yield* Fiber.join(pending.allocation))._tag).toBe("Failure");
        yield* expectPlaneState(f, target.sessionId, "resolving");
        yield* Deferred.succeed(fence.release, undefined);
        expect(yield* Fiber.join(resolution)).toBe("resolved-owned");
        expect(yield* f.cleanup(target)).toBe("cleaned");
        yield* expectPlaneState(f, target.sessionId, "deleted");
        expectSingleRemoval(f, pending.objectCount);
      }),
    ),
);

for (const stage of ["provision", "migrate"] as const)
  it.effect(`preserves a fenced plane after a late ${stage} reply`, () =>
    withTest(
      Effect.gen(function* () {
        const pending = yield* pendingAllocation(stage);
        const { f, target } = pending;
        expect(yield* f.allocations.resolveUnknownAllocation(target)).toBe("resolved-owned");
        yield* Deferred.succeed(pending.reply.release, undefined);
        expect((yield* Fiber.join(pending.allocation))._tag).toBe("Failure");
        yield* expectPlaneState(f, target.sessionId, "fenced");
        expectSingleRemoval(f, 0);
        expect(yield* f.cleanup(target)).toBe("cleaned");
        yield* expectPlaneState(f, target.sessionId, "deleted");
        expectSingleRemoval(f, pending.objectCount);
      }),
    ),
  );

it.effect(
  "retains the deletion claim and refuses duplicate removal after a late allocation reply",
  () =>
    withTest(
      Effect.gen(function* () {
        const removal = yield* makeProviderBarrier;
        const pending = yield* pendingAllocation("provision", { removeBarrier: removal });
        const { f, target, plane } = pending;
        expect(yield* f.allocations.resolveUnknownAllocation(target)).toBe("resolved-owned");
        const cleanup = yield* f.cleanup(target).pipe(Effect.forkChild);
        yield* Deferred.await(removal.entered);
        yield* expectPlaneState(f, target.sessionId, "deleting");
        yield* Deferred.succeed(pending.reply.release, undefined);
        expect((yield* Fiber.join(pending.allocation))._tag).toBe("Failure");
        yield* expectPlaneState(f, target.sessionId, "deleting");
        expect(
          (yield* Effect.exit(
            f.adapter.deleteOwned({
              ...target,
              ownerToken: plane.ownerToken,
              providerResourceId: `owned-application:${plane.sessionId}`,
            }),
          ))._tag,
        ).toBe("Failure");
        expectSingleRemoval(f, 0);
        yield* Deferred.succeed(removal.release, undefined);
        expect(yield* Fiber.join(cleanup)).toBe("cleaned");
        yield* expectPlaneState(f, target.sessionId, "deleted");
        expect(yield* f.cleanup(target)).toBe("cleaned");
        expectSingleRemoval(f, pending.objectCount);
      }),
    ),
);

for (const partialFailure of [false, true])
  it.effect(
    `preserves released state after a late allocation ${partialFailure ? "failure" : "success"}`,
    () =>
      withTest(
        Effect.gen(function* () {
          const pending = yield* pendingAllocation("provision", { partialFailure });
          const { f, target } = pending;
          expect(yield* f.allocations.resolveUnknownAllocation(target)).toBe("resolved-owned");
          expect(yield* f.cleanup(target)).toBe("cleaned");
          yield* expectPlaneState(f, target.sessionId, "deleted");
          yield* Deferred.succeed(pending.reply.release, undefined);
          expect((yield* Fiber.join(pending.allocation))._tag).toBe("Failure");
          yield* expectPlaneState(f, target.sessionId, "deleted");
          expect(yield* f.cleanup(target)).toBe("cleaned");
          expectSingleRemoval(f, pending.objectCount);
        }),
      ),
  );

it.effect("does not release a replacement claim when an old cleanup succeeds", () =>
  withTest(
    Effect.gen(function* () {
      const removal = yield* makeProviderBarrier;
      const f = yield* fixture({ removeBarrier: removal });
      const session = yield* f.create();
      yield* f.start(session.session.id);
      yield* f.sessions.stop(session.session.id, session.ownerIdentity);
      const plane = f.planes.get(session.session.id)!;
      const target = { sessionId: plane.sessionId, resource: ownedApplicationResource };
      const objectCount = f.inventory.get(plane.sessionId)!.length;
      const cleanup = yield* f.adapter
        .deleteOwned({
          ...target,
          ownerToken: plane.ownerToken,
          providerResourceId: `owned-application:${plane.sessionId}`,
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(removal.entered);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE preview_application_planes SET phase='fenced' WHERE session_id=${plane.sessionId} AND phase='deleting'`;
      yield* Deferred.succeed(removal.release, undefined);
      expect(yield* Fiber.join(cleanup)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "OwnedApplicationError", reason: "plane-resolution-raced" },
      });
      yield* expectPlaneState(f, plane.sessionId, "fenced");
      expectSingleRemoval(f, objectCount);
      expect(yield* f.cleanup(target)).toBe("cleaned");
      yield* expectPlaneState(f, plane.sessionId, "deleted");
      expectSingleRemoval(f, objectCount);
    }),
  ),
);

it.effect("does not quarantine a replacement claim when an old cleanup fails", () =>
  withTest(
    Effect.gen(function* () {
      const removal = yield* makeProviderBarrier;
      const f = yield* fixture({ removeBarrier: removal, removeFailure: true });
      const session = yield* f.create();
      yield* f.start(session.session.id);
      yield* f.sessions.stop(session.session.id, session.ownerIdentity);
      const plane = f.planes.get(session.session.id)!;
      const cleanup = yield* f.adapter
        .deleteOwned({
          sessionId: plane.sessionId,
          resource: ownedApplicationResource,
          ownerToken: plane.ownerToken,
          providerResourceId: `owned-application:${plane.sessionId}`,
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(removal.entered);
      const sql = yield* SqlClient.SqlClient;
      // Model an operator-proved takeover while delivery of the old failure is delayed.
      yield* sql`UPDATE preview_application_planes SET phase='fenced' WHERE session_id=${plane.sessionId} AND phase='deleting'`;
      yield* Deferred.succeed(removal.release, undefined);
      expect((yield* Fiber.join(cleanup))._tag).toBe("Failure");
      yield* expectPlaneState(f, plane.sessionId, "fenced");
      expectSingleRemoval(f, 0);
    }),
  ),
);
