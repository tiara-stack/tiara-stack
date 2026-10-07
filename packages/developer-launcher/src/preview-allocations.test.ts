import { it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import path from "node:path";
import { Deferred, Duration, Effect, Fiber, FileSystem, Layer } from "effect";
import { TestClock } from "effect/testing";
import type * as SqlClientType from "effect/unstable/sql/SqlClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
import {
  DEFAULT_PREVIEW_ALLOCATION_CONFIG,
  DEFAULT_PREVIEW_RESOURCE_ADAPTER_TIMEOUT_MS,
  makeLocalFilesystemPreviewResourceAdapter,
  makePreviewAllocationController,
  parsePreviewAllocationConfig,
  previewCapacityDimensionsByGroup,
  type PreviewResourceAdapter,
} from "./preview-allocations";
import { makePreviewSessionController, type PreviewSessionControllerApi } from "./preview-sessions";

const withAllocations = <A, E>(
  run: (
    resources: Map<string, string>,
    sessions: PreviewSessionControllerApi,
    now: { value: number },
  ) => Effect.Effect<A, E, SqlClientType.SqlClient | FileSystem.FileSystem>,
) => {
  const resources = new Map<string, string>();
  const now = { value: Date.now() };
  return Effect.gen(function* () {
    const sessions = yield* makePreviewSessionController(() => now.value);
    return yield* run(resources, sessions, now);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
    ),
  );
};

const demand = [
  {
    dimension: "runner.cpu.millicores",
    amount: 1,
    provider: "test-adapter",
    identity: "disposable-cluster",
  },
] as const;
const observation = {
  provider: "test-adapter",
  identity: "disposable-cluster",
  dimension: "runner.cpu.millicores",
  observedAt: Date.now(),
  total: 1,
  inUse: 0,
  grantsVerified: true,
} as const;
const testAdapter = (overrides: Partial<PreviewResourceAdapter> = {}): PreviewResourceAdapter => ({
  planProfile: () => Effect.fail(new Error("demand not configured")),
  validateProfileAllocation: () => Effect.void,
  allocate: () => Effect.succeed("resource"),
  deleteOwned: () => Effect.void,
  proveCleanup: () => Effect.succeed(true),
  resolveUnknown: () => Effect.fail(new Error("provider resolution not configured")),
  ...overrides,
});

it.effect("blocks missing, unverified, and stale provider measurements", () =>
  withAllocations(() =>
    Effect.gen(function* () {
      let now = 10_000;
      const allocations = yield* makePreviewAllocationController(testAdapter(), () => now, {
        maximumMeasurementAgeMs: 100,
      });
      const missing = yield* Effect.result(
        allocations.reserveAndAllocate({
          sessionId: "missing",
          demands: demand,
          resources: ["resource"],
        }),
      );
      expect(missing._tag).toBe("Failure");
      yield* allocations.observeCapacity({
        ...observation,
        observedAt: now,
        grantsVerified: false,
      });
      const noGrant = yield* Effect.result(
        allocations.reserveAndAllocate({
          sessionId: "no-grant",
          demands: demand,
          resources: ["resource"],
        }),
      );
      expect(noGrant._tag).toBe("Failure");
      yield* allocations.observeCapacity({
        ...observation,
        observedAt: now,
        total: 10,
        grantsVerified: true,
      });
      now += 99;
      const freshBeforeBoundary = yield* Effect.result(
        allocations.reserveAndAllocate({
          sessionId: "fresh-before-boundary",
          demands: demand,
          resources: ["resource"],
        }),
      );
      expect(freshBeforeBoundary._tag).toBe("Success");
      now += 1;
      const freshAtBoundary = yield* Effect.result(
        allocations.reserveAndAllocate({
          sessionId: "fresh-at-boundary",
          demands: demand,
          resources: ["resource"],
        }),
      );
      expect(freshAtBoundary._tag).toBe("Success");
      now += 1;
      const stale = yield* Effect.result(
        allocations.reserveAndAllocate({
          sessionId: "stale",
          demands: demand,
          resources: ["resource"],
        }),
      );
      expect(stale._tag).toBe("Failure");
    }),
  ),
);

it.effect("uses a finite default and rejects invalid maximum measurement age configuration", () =>
  withAllocations(() =>
    Effect.gen(function* () {
      for (const maximumMeasurementAgeMs of [0, -1, 1.5, Number.NaN]) {
        const invalid = yield* Effect.result(
          makePreviewAllocationController(testAdapter(), Date.now, {
            maximumMeasurementAgeMs,
          }),
        );
        expect(invalid._tag).toBe("Failure");
      }
      expect(DEFAULT_PREVIEW_ALLOCATION_CONFIG.maximumMeasurementAgeMs).toBe(900_000);
      const configuredDefault = yield* makePreviewAllocationController(testAdapter());
      expect(configuredDefault).toBeDefined();
    }),
  ),
);

it("parses the optional maximum measurement age without coercing non-integer syntax", () => {
  expect(parsePreviewAllocationConfig(undefined)).toEqual({
    config: DEFAULT_PREVIEW_ALLOCATION_CONFIG,
  });
  expect(parsePreviewAllocationConfig("  ")).toEqual({
    config: DEFAULT_PREVIEW_ALLOCATION_CONFIG,
  });
  expect(parsePreviewAllocationConfig(" 900000 ")).toEqual({
    config: { maximumMeasurementAgeMs: 900_000 },
  });
  for (const invalid of ["0", "-1", "+1", "1.0", "1e3", "0x10", "9007199254740992"]) {
    expect(parsePreviewAllocationConfig(invalid).config).toBeUndefined();
  }
});

it.effect(
  "times out a nonresponsive provider allocation and retains its quarantine reservation",
  () =>
    Effect.gen(function* () {
      const now = Date.now();
      const allocationStarted = yield* Deferred.make<void>();
      const allocations = yield* makePreviewAllocationController(
        testAdapter({
          allocate: () =>
            Deferred.succeed(allocationStarted, undefined).pipe(Effect.andThen(Effect.never)),
        }),
        () => now,
        DEFAULT_PREVIEW_ALLOCATION_CONFIG,
        true,
        5,
      );
      yield* allocations.observeCapacity({ ...observation, observedAt: now });
      const allocation = yield* Effect.result(
        allocations.reserveAndAllocate({
          sessionId: "timeout-allocation",
          demands: demand,
          resources: ["runner"],
        }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(allocationStarted);
      yield* TestClock.adjust(Duration.millis(5));
      expect((yield* Fiber.join(allocation))._tag).toBe("Failure");
      const state = yield* allocations.inspect("timeout-allocation");
      expect(state.allocations[0]?.state).toBe("quarantined");
      expect(state.allocations[0]?.failure).toBe("allocation-failed");
      expect(state.reservations[0]?.releasedAt).toBeNull();
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteClient.layer({ filename: ":memory:" }),
          NodeServices.layer,
          TestClock.layer(),
        ),
      ),
    ),
);

it.effect("does not resolve an in-flight allocation as absent", () =>
  Effect.gen(function* () {
    const now = { value: 100_000 };
    const resources = new Map<string, string>();
    const allocationStarted = yield* Deferred.make<void>();
    let finishProviderAllocation: (() => void) | undefined;
    let operationSettled = false;
    const sessions = yield* makePreviewSessionController(() => now.value);
    const allocations = yield* makePreviewAllocationController(
      testAdapter({
        allocate: ({ sessionId, ownerToken, resource }) => {
          const providerResourceId = `${sessionId}/${resource}`;
          return Effect.gen(function* () {
            yield* Deferred.succeed(allocationStarted, undefined);
            return yield* Effect.callback<string, Error>((resume) => {
              finishProviderAllocation = () => {
                resources.set(providerResourceId, ownerToken);
                resume(Effect.succeed(providerResourceId));
              };
            });
          });
        },
        resolveUnknown: ({ sessionId, resource, ownerToken, providerIdentities }) =>
          Effect.sync(() => {
            const providerResourceId = `${sessionId}/${resource}`;
            const owned = resources.get(providerResourceId) === ownerToken;
            return {
              sessionId,
              resource,
              ownerToken,
              ...providerIdentities[0]!,
              verifiedAt: now.value,
              allocationSettled: operationSettled,
              result: owned
                ? { status: "found" as const, providerResourceId }
                : { status: "absent" as const },
            };
          }),
        deleteOwned: ({ providerResourceId, ownerToken }) =>
          Effect.sync(() => {
            if (resources.get(providerResourceId) !== ownerToken)
              throw new Error("provider owner mismatch");
            resources.delete(providerResourceId);
          }),
      }),
      () => now.value,
      DEFAULT_PREVIEW_ALLOCATION_CONFIG,
      true,
      5,
    );
    const started = yield* sessions.create({
      owner: "owner",
      checkout: "/tmp/in-flight-allocation-resolution",
      manifests: {},
      requestedRevision: "in-flight",
    });
    yield* allocations.observeCapacity({ ...observation, observedAt: now.value });
    const allocation = yield* allocations
      .reserveAndAllocate({ sessionId: started.session.id, demands: demand, resources: ["runner"] })
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(allocationStarted);
    yield* TestClock.adjust(Duration.millis(5));
    expect((yield* Fiber.join(allocation))._tag).toBe("Failure");
    yield* sessions.stop(started.session.id, started.ownerIdentity);

    const unresolved = yield* Effect.result(
      allocations.resolveUnknownAllocation({ sessionId: started.session.id, resource: "runner" }),
    );
    expect(unresolved._tag).toBe("Failure");
    expect((yield* allocations.inspect(started.session.id)).allocations[0]?.state).toBe(
      "quarantined",
    );
    expect((yield* allocations.inspect(started.session.id)).reservations[0]?.releasedAt).toBeNull();

    finishProviderAllocation?.();
    operationSettled = true;
    expect(
      yield* allocations.resolveUnknownAllocation({
        sessionId: started.session.id,
        resource: "runner",
      }),
    ).toBe("resolved-owned");
    expect(resources.has(`${started.session.id}/runner`)).toBe(true);
    expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("waiting");
    now.value += 5 * 60_000;
    expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("cleaned");
    expect(resources.has(`${started.session.id}/runner`)).toBe(false);
    expect(
      (yield* allocations.inspect(started.session.id)).reservations[0]?.releasedAt,
    ).not.toBeNull();
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SqliteClient.layer({ filename: ":memory:" }),
        NodeServices.layer,
        TestClock.layer(),
      ),
    ),
  ),
);

it.effect("bounds proof, deletion, and unknown-owner resolution adapter calls", () =>
  Effect.gen(function* () {
    const now = { value: Date.now() };
    const sessions = yield* makePreviewSessionController(() => now.value);
    const sql = yield* SqlClient.SqlClient;
    const proofStarted = yield* Deferred.make<void>();
    const deletionStarted = yield* Deferred.make<void>();
    const resolutionStarted = yield* Deferred.make<void>();
    const allocations = yield* makePreviewAllocationController(
      testAdapter({
        allocate: ({ sessionId, resource }) => Effect.succeed(`${sessionId}/${resource}`),
        proveCleanup: ({ resources }) =>
          resources.some(({ resource }) => resource === "proof-hang")
            ? Deferred.succeed(proofStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(true),
        deleteOwned: ({ resource }) =>
          resource === "delete-hang"
            ? Deferred.succeed(deletionStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
        resolveUnknown: () =>
          Deferred.succeed(resolutionStarted, undefined).pipe(Effect.andThen(Effect.never)),
      }),
      () => now.value,
      DEFAULT_PREVIEW_ALLOCATION_CONFIG,
      true,
      5,
    );
    yield* allocations.observeCapacity({ ...observation, observedAt: now.value, total: 10 });

    const proofSession = yield* sessions.create({
      owner: "owner",
      checkout: "/tmp/adapter-proof-timeout",
      manifests: {},
      requestedRevision: "timeout",
    });
    yield* allocations.reserveAndAllocate({
      sessionId: proofSession.session.id,
      demands: demand,
      resources: ["proof-hang"],
    });
    yield* sessions.stop(proofSession.session.id, proofSession.ownerIdentity);
    const proofFiber = yield* allocations
      .cleanup({ sessionId: proofSession.session.id })
      .pipe(Effect.forkChild);
    yield* Deferred.await(proofStarted);
    yield* TestClock.adjust(Duration.millis(5));
    expect(yield* Fiber.join(proofFiber)).toBe("waiting");
    expect((yield* allocations.inspect(proofSession.session.id)).reservations[0]?.releasedAt).toBe(
      null,
    );

    const deletionSession = yield* sessions.create({
      owner: "owner",
      checkout: "/tmp/adapter-delete-timeout",
      manifests: {},
      requestedRevision: "timeout",
    });
    yield* allocations.reserveAndAllocate({
      sessionId: deletionSession.session.id,
      demands: demand,
      resources: ["delete-hang"],
    });
    yield* sessions.stop(deletionSession.session.id, deletionSession.ownerIdentity);
    expect(yield* allocations.cleanup({ sessionId: deletionSession.session.id })).toBe("waiting");
    now.value += 5 * 60_000;
    const deletionFiber = yield* allocations
      .cleanup({ sessionId: deletionSession.session.id })
      .pipe(Effect.forkChild);
    yield* Deferred.await(deletionStarted);
    yield* TestClock.adjust(Duration.millis(5));
    expect(yield* Fiber.join(deletionFiber)).toBe("quarantined");
    expect(
      (yield* allocations.inspect(deletionSession.session.id)).reservations[0]?.releasedAt,
    ).toBeNull();

    const resolutionSession = yield* sessions.create({
      owner: "owner",
      checkout: "/tmp/adapter-resolution-timeout",
      manifests: {},
      requestedRevision: "timeout",
    });
    yield* allocations.reserveAndAllocate({
      sessionId: resolutionSession.session.id,
      demands: demand,
      resources: ["resolve-hang"],
    });
    yield* sessions.stop(resolutionSession.session.id, resolutionSession.ownerIdentity);
    yield* sql`UPDATE preview_allocation_ledger SET provider_resource_id=NULL, state='quarantined' WHERE session_id=${resolutionSession.session.id} AND resource='resolve-hang'`;
    const resolutionFiber = yield* Effect.result(
      allocations.resolveUnknownAllocation({
        sessionId: resolutionSession.session.id,
        resource: "resolve-hang",
      }),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(resolutionStarted);
    yield* TestClock.adjust(Duration.millis(10));
    expect((yield* Fiber.join(resolutionFiber))._tag).toBe("Failure");
    expect(
      (yield* allocations.inspect(resolutionSession.session.id)).reservations[0]?.releasedAt,
    ).toBeNull();
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SqliteClient.layer({ filename: ":memory:" }),
        NodeServices.layer,
        TestClock.layer(),
      ),
    ),
  ),
);

it.effect("matches imported profile selections independent of array order", () =>
  withAllocations(() =>
    Effect.gen(function* () {
      const allocations = yield* makePreviewAllocationController(testAdapter());
      yield* allocations.importBaseline({
        measurements: [],
        profiles: [
          {
            profile: "ordered-profile",
            selectedRoles: ["sheet-auth", "workflow"],
            ownedGroups: [],
            demands: [],
            resources: [],
          },
        ],
      });
      const plan = yield* allocations.planProfile({
        profile: "ordered-profile",
        selectedRoles: ["workflow", "sheet-auth"],
        ownedGroups: [],
      });
      expect(plan).toEqual({ demands: [], resources: [] });
    }),
  ),
);

it.effect("rejects incomplete and unsafe adapter profile demand plans", () =>
  withAllocations(() =>
    Effect.gen(function* () {
      const input = {
        profile: "adapter-profile-validation",
        selectedRoles: ["sheet-auth"],
        ownedGroups: ["auth"],
      };
      const validPlan = {
        demands: previewCapacityDimensionsByGroup.auth.map((dimension) => ({
          dimension,
          amount: 1,
          provider: "test-adapter",
          identity: "disposable-cluster",
        })),
        resources: ["auth"],
      };
      const invalidPlans = [
        {
          ...validPlan,
          demands: validPlan.demands.map((item, index) =>
            index === 0 ? { ...item, amount: 0 } : item,
          ),
        },
        {
          ...validPlan,
          demands: validPlan.demands.map((item, index) =>
            index === 0 ? { ...item, provider: "Bearer unsafe" } : item,
          ),
        },
      ];

      for (const plan of invalidPlans) {
        const allocations = yield* makePreviewAllocationController(
          testAdapter({ planProfile: () => Effect.succeed(plan) }),
        );
        const result = yield* Effect.result(allocations.planProfile(input));
        expect(result._tag).toBe("Failure");
      }
    }),
  ),
);

it.effect("serializes reservations so concurrent sessions cannot exceed measured capacity", () =>
  withAllocations(() =>
    Effect.gen(function* () {
      const allocations = yield* makePreviewAllocationController(testAdapter());
      yield* allocations.observeCapacity(observation);
      const outcomes = yield* Effect.all(
        [
          Effect.result(
            allocations.reserveAndAllocate({
              sessionId: "one",
              demands: demand,
              resources: ["runner"],
            }),
          ),
          Effect.result(
            allocations.reserveAndAllocate({
              sessionId: "two",
              demands: demand,
              resources: ["runner"],
            }),
          ),
        ],
        { concurrency: 2 },
      );
      expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome._tag === "Failure")).toHaveLength(1);
    }),
  ),
);

it.effect(
  "quarantines attempted partial allocations and records later resources as unallocated",
  () =>
    withAllocations((resources, sessions, now) =>
      Effect.gen(function* () {
        const started = yield* sessions.create({
          owner: "owner",
          checkout: "/tmp/partial-allocation",
          manifests: {},
          requestedRevision: "partial",
        });
        let reportedProvider = "test-adapter";
        let failDatabaseDeletion = false;
        const allocations = yield* makePreviewAllocationController(
          testAdapter({
            allocate: ({ sessionId, resource, ownerToken }) => {
              const allocated = Effect.sync(() => {
                const id = `${sessionId}/${resource}`;
                resources.set(id, ownerToken);
                return id;
              });
              return Effect.flatMap(allocated, (providerResourceId) =>
                resource === "index"
                  ? Effect.fail(new Error("provider response was lost"))
                  : Effect.succeed(providerResourceId),
              );
            },
            deleteOwned: ({ providerResourceId, ownerToken }) =>
              failDatabaseDeletion && providerResourceId.endsWith("/database")
                ? Effect.fail(new Error("provider deletion failed"))
                : Effect.sync(() => {
                    if (resources.get(providerResourceId) !== ownerToken)
                      throw new Error("provider owner mismatch");
                    resources.delete(providerResourceId);
                  }),
            resolveUnknown: ({ sessionId, resource, ownerToken, providerIdentities }) =>
              Effect.sync(() => {
                const providerResourceId = `${sessionId}/${resource}`;
                if (resources.get(providerResourceId) !== ownerToken)
                  throw new Error("provider did not verify exact allocation ownership");
                return {
                  sessionId,
                  resource,
                  ownerToken,
                  provider: reportedProvider,
                  identity: providerIdentities[0]!.identity,
                  verifiedAt: now.value,
                  allocationSettled: true,
                  result: { status: "found" as const, providerResourceId },
                };
              }),
          }),
          () => now.value,
        );
        yield* allocations.observeCapacity({ ...observation, observedAt: now.value });
        const result = yield* Effect.result(
          allocations.reserveAndAllocate({
            sessionId: started.session.id,
            demands: demand,
            resources: ["database", "index", "runner"],
          }),
        );
        expect(result._tag).toBe("Failure");
        const retry = yield* Effect.result(
          allocations.reserveAndAllocate({
            sessionId: started.session.id,
            demands: demand,
            resources: ["database"],
          }),
        );
        expect(retry._tag).toBe("Failure");
        yield* sessions.stop(started.session.id, started.ownerIdentity);
        const cleanup = yield* allocations.cleanup({ sessionId: started.session.id });
        expect(cleanup).toBe("quarantined");
        now.value += 5 * 60_000;
        failDatabaseDeletion = true;
        expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("quarantined");
        expect(resources.has(`${started.session.id}/database`)).toBe(true);
        expect(resources.has(`${started.session.id}/index`)).toBe(true);
        let state = yield* allocations.inspect(started.session.id);
        expect(state.allocations.map(({ state: allocationState }) => allocationState)).toEqual([
          "owned",
          "quarantined",
          "not-allocated",
        ]);
        expect(state.reservations[0]?.releasedAt).toBeNull();
        reportedProvider = "asserted-without-provider-evidence";
        const unsupportedResolution = yield* Effect.result(
          allocations.resolveUnknownAllocation({
            sessionId: started.session.id,
            resource: "index",
          }),
        );
        expect(unsupportedResolution._tag).toBe("Failure");
        expect((yield* allocations.inspect(started.session.id)).reservations[0]?.releasedAt).toBe(
          null,
        );
        reportedProvider = "test-adapter";
        expect(
          yield* allocations.resolveUnknownAllocation({
            sessionId: started.session.id,
            resource: "index",
          }),
        ).toBe("resolved-owned");
        state = yield* allocations.inspect(started.session.id);
        expect(state.allocations.find(({ resource }) => resource === "index")?.state).toBe("owned");
        expect(state.allocations.find(({ resource }) => resource === "database")?.state).toBe(
          "owned",
        );
        expect(state.cleanup).toBe("waiting");
        const sql = yield* SqlClient.SqlClient;
        const resolutionRows =
          yield* sql`SELECT * FROM preview_allocation_resolutions WHERE session_id=${started.session.id}`;
        expect(resolutionRows).toHaveLength(1);
        expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("waiting");
        expect((yield* allocations.inspect(started.session.id)).cleanup).toBe("waiting");
        now.value += 5 * 60_000;
        failDatabaseDeletion = false;
        expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("quarantined");
        expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("cleaned");
        expect(resources.has(`${started.session.id}/database`)).toBe(false);
        expect(resources.has(`${started.session.id}/index`)).toBe(false);
        expect((yield* allocations.inspect(started.session.id)).reservations[0]?.releasedAt).toBe(
          now.value,
        );
      }),
    ),
);

it.effect("deletes dependent allocation resources in reverse creation order", () =>
  withAllocations((_, sessions, now) =>
    Effect.gen(function* () {
      const deleted: string[] = [];
      const started = yield* sessions.create({
        owner: "owner",
        checkout: "/tmp/reverse-allocation-cleanup",
        manifests: {},
        requestedRevision: "reverse-cleanup",
      });
      const allocations = yield* makePreviewAllocationController(
        testAdapter({
          allocate: ({ resource }) => Effect.succeed(resource),
          deleteOwned: ({ resource }) =>
            Effect.sync(() => {
              deleted.push(resource);
            }),
        }),
        () => now.value,
      );
      yield* allocations.observeCapacity({ ...observation, observedAt: now.value });
      yield* allocations.reserveAndAllocate({
        sessionId: started.session.id,
        demands: demand,
        resources: ["relay-service", "relay-attachment"],
      });
      yield* sessions.stop(started.session.id, started.ownerIdentity);
      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("waiting");
      now.value += 5 * 60_000;
      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("cleaned");
      expect(deleted).toEqual(["relay-attachment", "relay-service"]);
    }),
  ),
);

it.effect("quarantines an unknown dependent before deleting its known dependency", () =>
  withAllocations((_, sessions, now) =>
    Effect.gen(function* () {
      const deleted: string[] = [];
      const started = yield* sessions.create({
        owner: "owner",
        checkout: "/tmp/unknown-dependent-cleanup",
        manifests: {},
        requestedRevision: "unknown-dependent-cleanup",
      });
      const allocations = yield* makePreviewAllocationController(
        testAdapter({
          allocate: ({ resource }) => Effect.succeed(resource),
          deleteOwned: ({ resource }) => Effect.sync(() => deleted.push(resource)),
        }),
        () => now.value,
      );
      yield* allocations.observeCapacity({ ...observation, observedAt: now.value });
      yield* allocations.reserveAndAllocate({
        sessionId: started.session.id,
        demands: demand,
        resources: ["relay-service", "relay-attachment"],
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE preview_allocation_ledger SET provider_resource_id=NULL WHERE session_id=${started.session.id} AND resource='relay-attachment'`;
      yield* sessions.stop(started.session.id, started.ownerIdentity);
      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("quarantined");
      now.value += 5 * 60_000;
      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("quarantined");
      expect(deleted).toEqual([]);
      const state = yield* allocations.inspect(started.session.id);
      expect(state.allocations.find(({ resource }) => resource === "relay-service")?.state).toBe(
        "owned",
      );
      expect(state.reservations[0]?.releasedAt).toBeNull();
    }),
  ),
);

it.effect("does not delete dependencies after a dependent cleanup fails", () =>
  withAllocations((_, sessions, now) =>
    Effect.gen(function* () {
      const deleteAttempts: string[] = [];
      const started = yield* sessions.create({
        owner: "owner",
        checkout: "/tmp/stop-on-dependent-cleanup-failure",
        manifests: {},
        requestedRevision: "stop-cleanup",
      });
      const allocations = yield* makePreviewAllocationController(
        testAdapter({
          allocate: ({ resource }) => Effect.succeed(resource),
          deleteOwned: ({ resource }) =>
            Effect.gen(function* () {
              deleteAttempts.push(resource);
              if (resource === "relay-attachment")
                return yield* Effect.fail(new Error("attachment detach failed"));
            }),
        }),
        () => now.value,
      );
      yield* allocations.observeCapacity({ ...observation, observedAt: now.value });
      yield* allocations.reserveAndAllocate({
        sessionId: started.session.id,
        demands: demand,
        resources: ["relay-service", "relay-attachment"],
      });
      yield* sessions.stop(started.session.id, started.ownerIdentity);
      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("waiting");
      now.value += 5 * 60_000;
      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("quarantined");
      expect(deleteAttempts).toEqual(["relay-attachment"]);
    }),
  ),
);

it.effect("starts the five-minute deletion delay after a slow successful cleanup proof", () =>
  withAllocations((resources, sessions, now) =>
    Effect.gen(function* () {
      const started = yield* sessions.create({
        owner: "owner",
        checkout: "/tmp/slow-cleanup-proof",
        manifests: {},
        requestedRevision: "slow-proof",
      });
      let proofCalls = 0;
      const allocations = yield* makePreviewAllocationController(
        testAdapter({
          allocate: ({ sessionId, ownerToken, resource }) =>
            Effect.sync(() => {
              const id = `${sessionId}/${resource}`;
              resources.set(id, ownerToken);
              return id;
            }),
          proveCleanup: () =>
            Effect.sync(() => {
              proofCalls += 1;
              if (proofCalls === 1) now.value += 5 * 60_000;
              return true;
            }),
          deleteOwned: ({ providerResourceId, ownerToken }) =>
            Effect.sync(() => {
              if (resources.get(providerResourceId) !== ownerToken)
                throw new Error("owner mismatch");
              resources.delete(providerResourceId);
            }),
        }),
        () => now.value,
      );
      yield* allocations.observeCapacity({ ...observation, observedAt: now.value });
      yield* allocations.reserveAndAllocate({
        sessionId: started.session.id,
        demands: demand,
        resources: ["runner"],
      });
      yield* sessions.stop(started.session.id, started.ownerIdentity);

      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("waiting");
      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("waiting");
      expect(resources.has(`${started.session.id}/runner`)).toBe(true);
      expect((yield* allocations.inspect(started.session.id)).reservations[0]?.releasedAt).toBe(
        null,
      );

      now.value += 5 * 60_000;
      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("cleaned");
      expect(resources.has(`${started.session.id}/runner`)).toBe(false);
    }),
  ),
);

it.effect("resets the deletion delay when a later cleanup proof is revoked", () =>
  withAllocations((resources, sessions, now) =>
    Effect.gen(function* () {
      const started = yield* sessions.create({
        owner: "owner",
        checkout: "/tmp/revoked-cleanup-proof",
        manifests: {},
        requestedRevision: "revoked-proof",
      });
      let proofSucceeds = true;
      const allocations = yield* makePreviewAllocationController(
        testAdapter({
          allocate: ({ sessionId, ownerToken, resource }) =>
            Effect.sync(() => {
              const id = `${sessionId}/${resource}`;
              resources.set(id, ownerToken);
              return id;
            }),
          proveCleanup: () => Effect.succeed(proofSucceeds),
          deleteOwned: ({ providerResourceId, ownerToken }) =>
            Effect.sync(() => {
              if (resources.get(providerResourceId) !== ownerToken)
                throw new Error("owner mismatch");
              resources.delete(providerResourceId);
            }),
        }),
        () => now.value,
      );
      yield* allocations.observeCapacity({ ...observation, observedAt: now.value });
      yield* allocations.reserveAndAllocate({
        sessionId: started.session.id,
        demands: demand,
        resources: ["runner"],
      });
      yield* sessions.stop(started.session.id, started.ownerIdentity);

      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("waiting");
      now.value += 5 * 60_000;
      proofSucceeds = false;
      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("waiting");
      proofSucceeds = true;
      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("waiting");
      expect(resources.has(`${started.session.id}/runner`)).toBe(true);
      expect((yield* allocations.inspect(started.session.id)).reservations[0]?.releasedAt).toBe(
        null,
      );

      now.value += 5 * 60_000;
      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("cleaned");
      expect(resources.has(`${started.session.id}/runner`)).toBe(false);
    }),
  ),
);

it.effect("supports concurrent first cleanup calls for a session with no allocations", () =>
  withAllocations((_, sessions, now) =>
    Effect.gen(function* () {
      const started = yield* sessions.create({
        owner: "owner",
        checkout: "/tmp/concurrent-empty-cleanup",
        manifests: {},
        requestedRevision: "concurrent-empty-cleanup",
      });
      const allocations = yield* makePreviewAllocationController(
        testAdapter({ proveCleanup: () => Effect.succeed(false) }),
        () => now.value,
      );
      yield* sessions.stop(started.session.id, started.ownerIdentity);

      const outcomes = yield* Effect.all(
        [
          allocations.cleanup({ sessionId: started.session.id }),
          allocations.cleanup({ sessionId: started.session.id }),
        ],
        { concurrency: 2 },
      );

      expect(outcomes).toEqual(["waiting", "waiting"]);
      const state = yield* allocations.inspect(started.session.id);
      expect(state.cleanup).toBe("waiting");
      expect(state.allocations).toEqual([]);
      expect(state.reservations).toEqual([]);
    }),
  ),
);

it.effect("quarantines unsettled accepted work after the bounded recovery window", () =>
  withAllocations((_, sessions, now) =>
    Effect.gen(function* () {
      const started = yield* sessions.create({
        owner: "owner",
        checkout: "/tmp/settlement-timeout",
        manifests: {},
        requestedRevision: "settlement-timeout",
      });
      const active = yield* sessions.activate(
        started.session.id,
        started.session.generation,
        started.supervisorIdentity,
        "settlement-timeout",
      );
      yield* sessions.admit(started.session.id, active.generation);
      const allocations = yield* makePreviewAllocationController(
        testAdapter({ proveCleanup: () => Effect.succeed(true) }),
        () => now.value,
      );
      yield* allocations.observeCapacity({ ...observation, observedAt: now.value });
      yield* allocations.reserveAndAllocate({
        sessionId: started.session.id,
        demands: demand,
        resources: ["runner"],
      });
      yield* sessions.stop(started.session.id, started.ownerIdentity);

      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("waiting");
      now.value += 10 * 60_000;
      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("quarantined");
      const state = yield* allocations.inspect(started.session.id);
      expect(state.cleanup).toBe("quarantined");
      expect(state.reservations).toHaveLength(1);
      expect(state.reservations[0]?.releasedAt).toBe(null);
      expect(state.allocations[0]?.state).toBe("owned");
    }),
  ),
);

it.effect("clears only settlement quarantine after accepted work settles", () =>
  withAllocations((_, sessions, now) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const started = yield* sessions.create({
        owner: "owner",
        checkout: "/tmp/settlement-quarantine-recovery",
        manifests: {},
        requestedRevision: "settlement-quarantine-recovery",
      });
      const active = yield* sessions.activate(
        started.session.id,
        started.session.generation,
        started.supervisorIdentity,
        "settlement-quarantine-recovery",
      );
      yield* sessions.admit(started.session.id, active.generation);
      const allocations = yield* makePreviewAllocationController(testAdapter(), () => now.value);
      yield* allocations.observeCapacity({ ...observation, observedAt: now.value });
      yield* allocations.reserveAndAllocate({
        sessionId: started.session.id,
        demands: demand,
        resources: ["runner"],
      });
      yield* sessions.stop(started.session.id, started.ownerIdentity);

      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("waiting");
      now.value += 10 * 60_000;
      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("quarantined");
      let cleanupRows =
        yield* sql`SELECT quarantine_reason FROM preview_cleanup_state WHERE session_id=${started.session.id}`;
      expect((cleanupRows[0] as Record<string, unknown>).quarantine_reason).toBe(
        "accepted-work-settlement-unproven",
      );

      yield* sessions.settle(started.session.id, active.generation);
      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("waiting");
      cleanupRows =
        yield* sql`SELECT quarantine_reason FROM preview_cleanup_state WHERE session_id=${started.session.id}`;
      expect((cleanupRows[0] as Record<string, unknown>).quarantine_reason).toBe(null);

      yield* sql`UPDATE preview_cleanup_state SET quarantine_reason='deletion-failed' WHERE session_id=${started.session.id}`;
      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("waiting");
      cleanupRows =
        yield* sql`SELECT quarantine_reason FROM preview_cleanup_state WHERE session_id=${started.session.id}`;
      expect((cleanupRows[0] as Record<string, unknown>).quarantine_reason).toBe("deletion-failed");
      expect((yield* allocations.inspect(started.session.id)).reservations[0]?.releasedAt).toBe(
        null,
      );
    }),
  ),
);

it.effect("serializes concurrent deletion claims and retains reservations until confirmation", () =>
  withAllocations((resources, sessions, now) =>
    Effect.gen(function* () {
      const started = yield* sessions.create({
        owner: "owner",
        checkout: "/tmp/concurrent-cleanup",
        manifests: {},
        requestedRevision: "concurrent-cleanup",
      });
      const deleteStarted = yield* Deferred.make<void>();
      const permitDelete = yield* Deferred.make<void>();
      let deleteCalls = 0;
      const allocations = yield* makePreviewAllocationController(
        testAdapter({
          allocate: ({ sessionId, ownerToken, resource }) =>
            Effect.sync(() => {
              const id = `${sessionId}/${resource}`;
              resources.set(id, ownerToken);
              return id;
            }),
          deleteOwned: ({ providerResourceId, ownerToken }) =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                deleteCalls += 1;
              });
              yield* Deferred.succeed(deleteStarted, undefined);
              yield* Deferred.await(permitDelete);
              if (resources.get(providerResourceId) !== ownerToken)
                return yield* Effect.fail(new Error("owner mismatch"));
              yield* Effect.sync(() => resources.delete(providerResourceId));
            }),
        }),
        () => now.value,
      );
      yield* allocations.observeCapacity({ ...observation, observedAt: now.value });
      yield* allocations.reserveAndAllocate({
        sessionId: started.session.id,
        demands: demand,
        resources: ["runner"],
      });
      yield* sessions.stop(started.session.id, started.ownerIdentity);
      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("waiting");
      now.value += 5 * 60_000;

      const firstCleanup = yield* allocations
        .cleanup({ sessionId: started.session.id })
        .pipe(Effect.forkChild);
      yield* Deferred.await(deleteStarted);
      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("waiting");
      expect(deleteCalls).toBe(1);
      expect((yield* allocations.inspect(started.session.id)).reservations[0]?.releasedAt).toBe(
        null,
      );

      yield* Deferred.succeed(permitDelete, undefined);
      expect(yield* Fiber.join(firstCleanup)).toBe("cleaned");
      expect(resources.has(`${started.session.id}/runner`)).toBe(false);
      expect((yield* allocations.inspect(started.session.id)).reservations[0]?.releasedAt).toBe(
        now.value,
      );
    }),
  ),
);

it.effect(
  "waits for ended settlement and the proof delay, then deletes only exact owned resources idempotently",
  () =>
    withAllocations((resources, sessions, now) =>
      Effect.gen(function* () {
        const started = yield* sessions.create({
          owner: "owner",
          checkout: "/tmp/owned",
          manifests: {},
          requestedRevision: "revision",
        });
        const allocations = yield* makePreviewAllocationController(
          testAdapter({
            allocate: ({ sessionId, ownerToken, resource }) =>
              Effect.sync(() => {
                const id = `${sessionId}/${resource}`;
                resources.set(id, ownerToken);
                return id;
              }),
            deleteOwned: ({ providerResourceId, ownerToken }) =>
              Effect.sync(() => {
                if (resources.get(providerResourceId) !== ownerToken)
                  throw new Error("owner mismatch");
                resources.delete(providerResourceId);
              }),
          }),
          () => now.value,
        );
        yield* allocations.observeCapacity(observation);
        yield* allocations.reserveAndAllocate({
          sessionId: started.session.id,
          demands: demand,
          resources: ["db"],
        });
        resources.set("other-session/db", "other-owner");
        const active = yield* sessions.activate(
          started.session.id,
          started.session.generation,
          started.supervisorIdentity,
          "revision",
        );
        yield* sessions.admit(started.session.id, active.generation);
        const live = yield* Effect.result(
          allocations.cleanup({
            sessionId: started.session.id,
          }),
        );
        expect(live._tag).toBe("Failure");
        yield* sessions.stop(started.session.id, started.ownerIdentity);
        expect(
          yield* allocations.cleanup({
            sessionId: started.session.id,
          }),
        ).toBe("waiting");
        yield* sessions.settle(started.session.id, active.generation);
        expect(
          yield* allocations.cleanup({
            sessionId: started.session.id,
          }),
        ).toBe("waiting");
        expect((yield* allocations.inspect(started.session.id)).cleanup).toBe("waiting");
        now.value += 5 * 60_000;
        expect(
          yield* allocations.cleanup({
            sessionId: started.session.id,
          }),
        ).toBe("cleaned");
        expect(resources.has(`${started.session.id}/db`)).toBe(false);
        expect(resources.get("other-session/db")).toBe("other-owner");
        expect(
          yield* allocations.cleanup({
            sessionId: started.session.id,
          }),
        ).toBe("cleaned");
      }),
    ),
);

it.effect("quarantines failed deletions and does not release their capacity", () =>
  withAllocations((_, sessions, now) =>
    Effect.gen(function* () {
      const started = yield* sessions.create({
        owner: "owner",
        checkout: "/tmp/quarantine",
        manifests: {},
        requestedRevision: "revision",
      });
      const allocations = yield* makePreviewAllocationController(
        testAdapter({
          allocate: () => Effect.succeed("provider-id"),
          deleteOwned: () => Effect.fail(new Error("not found ambiguously")),
        }),
        () => now.value,
      );
      yield* allocations.observeCapacity(observation);
      yield* allocations.reserveAndAllocate({
        sessionId: started.session.id,
        demands: demand,
        resources: ["index"],
      });
      yield* sessions.stop(started.session.id, started.ownerIdentity);
      expect(
        yield* allocations.cleanup({
          sessionId: started.session.id,
        }),
      ).toBe("waiting");
      now.value += 5 * 60_000;
      expect(
        yield* allocations.cleanup({
          sessionId: started.session.id,
        }),
      ).toBe("quarantined");
      const blocked = yield* Effect.result(
        allocations.reserveAndAllocate({
          sessionId: "next",
          demands: demand,
          resources: ["next"],
        }),
      );
      expect(blocked._tag).toBe("Failure");
    }),
  ),
);

it.effect("quarantines when the deletion phase expires between owned resources", () =>
  withAllocations((resources, sessions, now) =>
    Effect.gen(function* () {
      const started = yield* sessions.create({
        owner: "owner",
        checkout: "/tmp/deletion-deadline",
        manifests: {},
        requestedRevision: "deletion-deadline",
      });
      let deleteCalls = 0;
      const allocations = yield* makePreviewAllocationController(
        testAdapter({
          allocate: ({ sessionId, ownerToken, resource }) =>
            Effect.sync(() => {
              const id = `${sessionId}/${resource}`;
              resources.set(id, ownerToken);
              return id;
            }),
          deleteOwned: ({ providerResourceId, ownerToken }) =>
            Effect.sync(() => {
              deleteCalls += 1;
              if (resources.get(providerResourceId) !== ownerToken)
                throw new Error("owner mismatch");
              resources.delete(providerResourceId);
              now.value += 5 * 60_000 + 1;
            }),
        }),
        () => now.value,
      );
      yield* allocations.observeCapacity({ ...observation, observedAt: now.value });
      yield* allocations.reserveAndAllocate({
        sessionId: started.session.id,
        demands: demand,
        resources: ["first", "second"],
      });
      yield* sessions.stop(started.session.id, started.ownerIdentity);

      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("waiting");
      now.value += 5 * 60_000;
      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("quarantined");

      const state = yield* allocations.inspect(started.session.id);
      expect(deleteCalls).toBe(1);
      expect(state.cleanup).toBe("quarantined");
      expect(
        state.allocations.filter(({ state: allocationState }) => allocationState === "deleted"),
      ).toHaveLength(1);
      const remaining = state.allocations.find(
        ({ state: allocationState }) => allocationState === "owned",
      );
      expect(remaining).toBeDefined();
      expect(state.reservations[0]?.releasedAt).toBe(null);
      expect(resources.has(`${started.session.id}/${remaining?.resource}`)).toBe(true);
    }),
  ),
);

it.effect("does not release capacity when the final deletion ends after its phase deadline", () =>
  withAllocations((resources, sessions, now) =>
    Effect.gen(function* () {
      const started = yield* sessions.create({
        owner: "owner",
        checkout: "/tmp/final-deletion-deadline",
        manifests: {},
        requestedRevision: "final-deletion-deadline",
      });
      const allocations = yield* makePreviewAllocationController(
        testAdapter({
          allocate: ({ sessionId, ownerToken, resource }) =>
            Effect.sync(() => {
              const id = `${sessionId}/${resource}`;
              resources.set(id, ownerToken);
              return id;
            }),
          deleteOwned: ({ providerResourceId, ownerToken }) =>
            Effect.sync(() => {
              if (resources.get(providerResourceId) !== ownerToken)
                throw new Error("owner mismatch");
              resources.delete(providerResourceId);
              now.value += 5 * 60_000 + 1;
            }),
        }),
        () => now.value,
      );
      yield* allocations.observeCapacity({ ...observation, observedAt: now.value });
      yield* allocations.reserveAndAllocate({
        sessionId: started.session.id,
        demands: demand,
        resources: ["runner"],
      });
      yield* sessions.stop(started.session.id, started.ownerIdentity);

      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("waiting");
      now.value += 5 * 60_000;
      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("quarantined");
      const quarantined = yield* allocations.inspect(started.session.id);
      expect(quarantined.allocations[0]?.state).toBe("deleted");
      expect(quarantined.reservations[0]?.releasedAt).toBe(null);

      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("cleaned");
      expect((yield* allocations.inspect(started.session.id)).reservations[0]?.releasedAt).toBe(
        now.value,
      );
    }),
  ),
);

it.effect("quarantines unledgered legacy resources and retains reservations", () =>
  withAllocations((_, sessions) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const started = yield* sessions.create({
        owner: "owner",
        checkout: "/tmp/legacy-resource",
        manifests: {},
        requestedRevision: "revision",
      });
      const allocations = yield* makePreviewAllocationController(testAdapter());
      yield* allocations.observeCapacity(observation);
      yield* allocations.reserveAndAllocate({
        sessionId: started.session.id,
        demands: demand,
        resources: ["runner"],
      });
      yield* sessions.stop(started.session.id, started.ownerIdentity);
      yield* sql`UPDATE preview_sessions SET resource_ids=${JSON.stringify({ legacy: "unknown-id" })} WHERE id=${started.session.id}`;
      expect(yield* allocations.cleanup({ sessionId: started.session.id })).toBe("quarantined");
      const state = yield* allocations.inspect(started.session.id);
      expect(state.cleanup).toBe("quarantined");
      expect(state.reservations[0]?.releasedAt).toBeNull();
    }),
  ),
);

it.live("recovers a stale deletion claim after a controller restart", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "preview-deletion-claim-restart-",
    });
    const database = path.join(directory, "authority.sqlite");
    const resourceRoot = path.join(directory, "resources");
    const now = { value: Date.now() };
    const started = yield* Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* makePreviewSessionController(() => now.value);
        const allocations = yield* makePreviewAllocationController(
          makeLocalFilesystemPreviewResourceAdapter(resourceRoot),
          () => now.value,
        );
        const session = yield* sessions.create({
          owner: "owner",
          checkout: directory,
          manifests: {},
          requestedRevision: "deletion-claim-restart",
        });
        yield* allocations.observeCapacity({ ...observation, observedAt: now.value });
        const resource = yield* allocations.reserveAndAllocate({
          sessionId: session.session.id,
          demands: demand,
          resources: ["runner"],
        });
        const stopped = yield* sessions.stop(session.session.id, session.ownerIdentity);
        expect(yield* allocations.cleanup({ sessionId: session.session.id })).toBe("waiting");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE preview_allocation_ledger SET state='deleting', updated_at=${now.value - DEFAULT_PREVIEW_RESOURCE_ADAPTER_TIMEOUT_MS - 1} WHERE session_id=${session.session.id} AND resource='runner'`;
        return {
          id: session.session.id,
          endedAt: stopped.endedAt!,
          resourcePath: resource.runner!,
        };
      }).pipe(
        Effect.provide(
          Layer.mergeAll(SqliteClient.layer({ filename: database }), NodeServices.layer),
        ),
      ),
    );

    now.value = started.endedAt + 1;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const allocations = yield* makePreviewAllocationController(
          makeLocalFilesystemPreviewResourceAdapter(resourceRoot),
          () => now.value,
        );
        expect(yield* allocations.cleanup({ sessionId: started.id })).toBe("waiting");
        const recovered = yield* allocations.inspect(started.id);
        expect(recovered.allocations[0]?.state).toBe("deleting");
        expect(recovered.reservations[0]?.releasedAt).toBeNull();
        expect(yield* fileSystem.exists(started.resourcePath)).toBe(true);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(SqliteClient.layer({ filename: database }), NodeServices.layer),
        ),
      ),
    );

    now.value = started.endedAt + 5 * 60_000 + 1;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const allocations = yield* makePreviewAllocationController(
          makeLocalFilesystemPreviewResourceAdapter(resourceRoot),
          () => now.value,
        );
        expect(yield* allocations.cleanup({ sessionId: started.id })).toBe("cleaned");
        const recovered = yield* allocations.inspect(started.id);
        expect(recovered.allocations[0]?.state).toBe("deleted");
        expect(recovered.reservations[0]?.releasedAt).toBe(now.value);
        expect(yield* fileSystem.exists(started.resourcePath)).toBe(false);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(SqliteClient.layer({ filename: database }), NodeServices.layer),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "recovers the durable owner ledger after controller restart and releases only after deletion",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "preview-allocation-restart-",
      });
      const database = path.join(directory, "authority.sqlite");
      const resourceRoot = path.join(directory, "resources");
      const now = { value: Date.now() };
      const started = yield* Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* makePreviewSessionController(() => now.value);
          const allocations = yield* makePreviewAllocationController(
            makeLocalFilesystemPreviewResourceAdapter(resourceRoot),
            () => now.value,
          );
          const session = yield* sessions.create({
            owner: "owner",
            checkout: directory,
            manifests: {},
            requestedRevision: "restart-test",
          });
          yield* allocations.observeCapacity({
            ...observation,
            observedAt: now.value,
          });
          const resource = yield* allocations.reserveAndAllocate({
            sessionId: session.session.id,
            demands: demand,
            resources: ["runner"],
          });
          const stopped = yield* sessions.stop(session.session.id, session.ownerIdentity);
          return {
            id: session.session.id,
            endedAt: stopped.endedAt!,
            resourcePath: resource.runner!,
          };
        }).pipe(
          Effect.provide(
            Layer.mergeAll(SqliteClient.layer({ filename: database }), NodeServices.layer),
          ),
        ),
      );

      now.value = started.endedAt + 1;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const allocations = yield* makePreviewAllocationController(
            makeLocalFilesystemPreviewResourceAdapter(resourceRoot),
            () => now.value,
          );
          expect(yield* allocations.cleanup({ sessionId: started.id })).toBe("waiting");
          const recovered = yield* allocations.inspect(started.id);
          expect(recovered.allocations[0]?.state).toBe("owned");
          expect(recovered.reservations[0]?.releasedAt).toBeNull();
        }).pipe(
          Effect.provide(
            Layer.mergeAll(SqliteClient.layer({ filename: database }), NodeServices.layer),
          ),
        ),
      );

      now.value += 5 * 60_000;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const allocations = yield* makePreviewAllocationController(
            makeLocalFilesystemPreviewResourceAdapter(resourceRoot),
            () => now.value,
          );
          expect(yield* allocations.cleanup({ sessionId: started.id })).toBe("cleaned");
          const recovered = yield* allocations.inspect(started.id);
          expect(recovered.allocations[0]?.state).toBe("deleted");
          expect(recovered.reservations[0]?.releasedAt).toBe(now.value);
          expect(yield* fileSystem.exists(started.resourcePath)).toBe(false);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(SqliteClient.layer({ filename: database }), NodeServices.layer),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
