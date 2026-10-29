import { it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Deferred, Duration, Effect, Fiber, FileSystem, Layer, Path } from "effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import type * as SqlClientType from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
import {
  makePreviewSessionController,
  makePreviewSessionAuthority,
  dispatchPreviewSessionProtocol,
  PreviewSessionController,
  type PreviewSessionControllerApi,
  previewSessionHeartbeatMs,
  previewSessionHeartbeatFailureLimit,
  previewSessionLeaseMs,
  previewSupervisorLeaseMs,
  PreviewSessionError,
  supervisePreviewSessionLease,
  timeoutPreviewSessionHeartbeat,
} from "./preview-sessions";

const withController = <A, E>(
  run: (now: { value: number }) => Effect.Effect<A, E, SqlClientType.SqlClient>,
) => {
  const now = { value: 1_000_000 };
  return run(now).pipe(
    Effect.provide(
      Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
    ),
  );
};

it.live("returns malformed persisted session rows as typed protocol failures", () =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const controller = yield* makePreviewSessionController(() => value);
      const created = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests: {},
        requestedRevision: "rev-a",
      });
      expect((yield* controller.status(created.session.id)).id).toBe(created.session.id);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE preview_sessions SET resource_ids='{' WHERE id=${created.session.id}`;

      const result = yield* Effect.exit(
        Effect.result(
          dispatchPreviewSessionProtocol(controller, {
            _tag: "Status",
            id: created.session.id,
          }),
        ),
      );

      expect(Exit.isSuccess(result)).toBe(true);
      if (Exit.isFailure(result)) return;
      expect(result.value._tag).toBe("Failure");
      if (result.value._tag === "Failure") {
        expect(result.value.failure).toBeInstanceOf(PreviewSessionError);
        expect(result.value.failure.reason).toBe("invalid-session-row");
      }
    }),
  ),
);

it.live("returns malformed existing workload identities as typed controller failures", () =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const controller = yield* makePreviewSessionController(() => value);
      const manifests = { "sheet-workflows-runner": "sha256:runner" };
      const validSession = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests,
        requestedRevision: "rev-a",
      });
      const validReservation = yield* controller.authorizeCredentialIssue(
        validSession.session.id,
        validSession.session.generation,
        "sheet-workflows-runner",
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO preview_session_workload_identities (session_id, generation, role, credential_name, service_account, oauth_client_id, credential_file) VALUES (${validSession.session.id}, ${validSession.session.generation}, ${"sheet-workflows-runner"}, ${"workload-identity"}, ${"tiara-stack-dev/preview-session-runner"}, ${"preview-session-runner-client"}, ${"/managed/session/runner/token"})`;
      const validExistingResult = yield* Effect.result(
        controller.registerCredentialIdentity({
          id: validSession.session.id,
          generation: validSession.session.generation,
          role: "sheet-workflows-runner",
          reservationId: validReservation.reservationId,
          credentialName: "workload-identity",
          serviceAccount: "tiara-stack-dev/preview-session-runner",
          oauthClientId: "preview-session-runner-client",
          credentialFile: "/managed/session/runner/token",
        }),
      );
      expect(validExistingResult._tag).toBe("Success");
      expect((yield* controller.status(validSession.session.id)).phase).toBe("pending");

      const malformedSession = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests,
        requestedRevision: "rev-a",
      });
      const malformedReservation = yield* controller.authorizeCredentialIssue(
        malformedSession.session.id,
        malformedSession.session.generation,
        "sheet-workflows-runner",
      );
      yield* sql`INSERT INTO preview_session_workload_identities (session_id, generation, role, credential_name, service_account, oauth_client_id, credential_file) VALUES (${malformedSession.session.id}, ${malformedSession.session.generation}, ${"sheet-workflows-runner"}, CAST(X'01' AS BLOB), ${"tiara-stack-dev/preview-session-runner"}, ${"preview-session-runner-client"}, ${"/managed/session/runner/token"})`;

      const malformedResult = yield* Effect.exit(
        Effect.result(
          controller.registerCredentialIdentity({
            id: malformedSession.session.id,
            generation: malformedSession.session.generation,
            role: "sheet-workflows-runner",
            reservationId: malformedReservation.reservationId,
            credentialName: "workload-identity",
            serviceAccount: "tiara-stack-dev/preview-session-runner",
            oauthClientId: "preview-session-runner-client",
            credentialFile: "/managed/session/runner/token",
          }),
        ),
      );

      expect(Exit.isSuccess(malformedResult)).toBe(true);
      if (Exit.isFailure(malformedResult)) return;
      expect(malformedResult.value._tag).toBe("Failure");
      if (malformedResult.value._tag === "Failure") {
        expect(malformedResult.value.failure).toBeInstanceOf(PreviewSessionError);
        expect(malformedResult.value.failure.reason).toBe("invalid-workload-identity-row");
      }
      expect((yield* controller.status(malformedSession.session.id)).phase).toBe("pending");
    }),
  ),
);

it.live("persists pending sessions and fences writes after restart and resume", () =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const firstController = yield* makePreviewSessionController(() => value);
      const created = yield* firstController.create({
        owner: "developer@example.test",
        checkout: "/worktrees/change",
        manifests: { "sheet-auth": "sha256:manifest" },
        requestedRevision: "rev-a",
      });
      expect(created.session.phase).toBe("pending");
      expect(created.session.generation).toBe(1);
      expect(created.session.leaseDeadline).toBe(value + previewSessionLeaseMs);

      const restartedController = yield* makePreviewSessionController(() => value);
      const beforeResume = yield* restartedController.status(created.session.id);
      expect(beforeResume.lastRenewedAt).toBe(value);
      value += previewSupervisorLeaseMs;
      const resumed = yield* restartedController.resume(created.session.id, created.ownerIdentity);
      expect(resumed.session.generation).toBe(2);
      expect(resumed.session.leaseDeadline).toBe(created.session.leaseDeadline);
      expect(resumed.session.lastRenewedAt).toBe(created.session.lastRenewedAt);
      const concurrentResume = yield* Effect.exit(
        restartedController.resume(created.session.id, created.ownerIdentity),
      );
      expect(concurrentResume._tag).toBe("Failure");
      const staleWrite = yield* Effect.exit(
        restartedController.heartbeat(created.session.id, created.supervisorIdentity, 1),
      );
      expect(staleWrite._tag).toBe("Failure");
      const active = yield* restartedController.activate(
        created.session.id,
        2,
        resumed.supervisorIdentity,
        "rev-a",
      );
      expect(active.phase).toBe("active");
      const admitted = yield* restartedController.admit(created.session.id, 2);
      expect(admitted.activeRevision).toBe("rev-a");
      expect(admitted.unsettled).toBe(1);
      value += 30_000;
      const recovered = yield* restartedController.resume(
        created.session.id,
        created.ownerIdentity,
      );
      expect(recovered.session.phase).toBe("pending");
      expect(recovered.session.generation).toBe(3);
      expect(recovered.session.leaseDeadline).toBe(created.session.leaseDeadline);
      expect(recovered.session.lastRenewedAt).toBe(created.session.lastRenewedAt);
      const oldSupervisor = yield* Effect.exit(
        restartedController.heartbeat(created.session.id, resumed.supervisorIdentity, 3),
      );
      expect(oldSupervisor._tag).toBe("Failure");
      const ownerCannotRenew = yield* Effect.exit(
        restartedController.heartbeat(created.session.id, created.ownerIdentity, 3),
      );
      expect(ownerCannotRenew._tag).toBe("Failure");
      yield* restartedController.settle(created.session.id, 2);
      expect((yield* restartedController.status(created.session.id)).unsettled).toBe(0);
      const staleSettlement = yield* Effect.exit(restartedController.settle(created.session.id, 2));
      expect(staleSettlement._tag).toBe("Failure");
    }),
  ),
);

it.live("preserves a compatible sheet-web session generation on resume", () =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const controller = yield* makePreviewSessionController(() => value);
      const created = yield* controller.create({
        owner: "developer@example.test",
        checkout: "/worktrees/web",
        manifests: { "sheet-web": "sha256:manifest" },
        requestedRevision: "rev-a",
      });
      yield* controller.activate(
        created.session.id,
        created.session.generation,
        created.supervisorIdentity,
        "rev-a",
      );
      const staleNoOp = yield* Effect.exit(
        controller.requestRevision(
          created.session.id,
          created.session.generation,
          created.ownerIdentity,
          "rev-a",
        ),
      );
      expect(staleNoOp._tag).toBe("Failure");
      value += previewSupervisorLeaseMs;
      const resumed = yield* controller.resume(
        created.session.id,
        created.ownerIdentity,
        created.supervisorIdentity,
      );
      expect(resumed.session.phase).toBe("pending");
      expect(resumed.session.generation).toBe(created.session.generation);
      expect(resumed.supervisorIdentity).not.toBe(created.supervisorIdentity);
      const oldHeartbeat = yield* Effect.exit(
        controller.heartbeat(
          created.session.id,
          created.supervisorIdentity,
          created.session.generation,
        ),
      );
      expect(oldHeartbeat._tag).toBe("Failure");
      const oldRevision = yield* Effect.exit(
        controller.requestRevision(
          created.session.id,
          created.session.generation,
          created.supervisorIdentity,
          "rev-b",
        ),
      );
      expect(oldRevision._tag).toBe("Failure");
      const staleStop = yield* Effect.exit(
        controller.stopSupervised(
          created.session.id,
          created.supervisorIdentity,
          created.session.generation,
        ),
      );
      expect(staleStop._tag).toBe("Failure");
      expect((yield* controller.status(created.session.id)).phase).toBe("pending");
      const activated = yield* controller.activate(
        created.session.id,
        resumed.session.generation,
        resumed.supervisorIdentity,
        resumed.session.requestedRevision,
      );
      expect(activated.generation).toBe(created.session.generation);
      const noOpRevision = yield* controller.requestRevision(
        created.session.id,
        resumed.session.generation,
        resumed.supervisorIdentity,
        "rev-a",
      );
      expect(noOpRevision.phase).toBe("active");
      expect(noOpRevision.activeRevision).toBe("rev-a");
      const staleNoOpAfterResume = yield* Effect.exit(
        controller.requestRevision(
          created.session.id,
          resumed.session.generation,
          created.supervisorIdentity,
          "rev-a",
        ),
      );
      expect(staleNoOpAfterResume._tag).toBe("Failure");
      const currentStop = yield* controller.stopSupervised(
        created.session.id,
        resumed.supervisorIdentity,
        resumed.session.generation,
      );
      expect(currentStop.phase).toBe("ended");
    }),
  ),
);

it.effect("renews on the test clock and cancels with its owning supervisor fiber", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const now = () => testClock.currentTimeMillisUnsafe();
    const controller = yield* makePreviewSessionController(now);
    const created = yield* controller.create({
      owner: "owner",
      checkout: "/checkout",
      manifests: {},
      requestedRevision: "rev-a",
    });
    const fiber = yield* supervisePreviewSessionLease(
      created.session.id,
      created.supervisorIdentity,
      1,
    ).pipe(Effect.provideService(PreviewSessionController, controller), Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
    const renewed = yield* controller.status(created.session.id);
    expect(renewed.lastRenewedAt).toBe(previewSessionHeartbeatMs);
    yield* Fiber.interrupt(fiber);
    const renewedAtInterrupt = renewed.lastRenewedAt;
    yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
    const after = yield* controller.status(created.session.id);
    expect(after.lastRenewedAt).toBe(renewedAtInterrupt);
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

it.effect("retries a transient lease heartbeat and exits once the session is ended", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const controller = yield* makePreviewSessionController(() =>
      testClock.currentTimeMillisUnsafe(),
    );
    const created = yield* controller.create({
      owner: "owner",
      checkout: "/checkout",
      manifests: {},
      requestedRevision: "rev-a",
    });
    yield* controller.activate(
      created.session.id,
      created.session.generation,
      created.supervisorIdentity,
      "rev-a",
    );
    let failuresRemaining = 1;
    let heartbeatCalls = 0;
    const flakyController = {
      ...controller,
      heartbeat: (id: string, supervisorIdentity: string, generation: number) => {
        heartbeatCalls += 1;
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          return Effect.fail(new PreviewSessionError({ reason: "transient-heartbeat" }));
        }
        return controller.heartbeat(id, supervisorIdentity, generation);
      },
    } satisfies PreviewSessionControllerApi;
    const fiber = yield* supervisePreviewSessionLease(
      created.session.id,
      created.supervisorIdentity,
      created.session.generation,
    ).pipe(Effect.provideService(PreviewSessionController, flakyController), Effect.forkChild);
    yield* Effect.yieldNow;
    expect(heartbeatCalls).toBe(1);
    yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
    yield* Effect.yieldNow;
    expect(heartbeatCalls).toBe(2);
    expect((yield* controller.status(created.session.id)).phase).toBe("active");
    expect((yield* controller.status(created.session.id)).lastRenewedAt).toBe(
      previewSessionHeartbeatMs,
    );

    yield* controller.stopSupervised(
      created.session.id,
      created.supervisorIdentity,
      created.session.generation,
    );
    yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
    yield* Effect.yieldNow;
    const endedExit = yield* Effect.exit(Fiber.join(fiber));
    expect(Exit.isSuccess(endedExit)).toBe(true);
    expect((yield* controller.status(created.session.id)).phase).toBe("ended");
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

it.effect("ends a fenced supervisor without retrying or ending the live session", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const controller = yield* makePreviewSessionController(() =>
      testClock.currentTimeMillisUnsafe(),
    );
    const fencedReasons = [
      "stale-supervisor",
      "identity-mismatch",
      "lease-expired-or-fenced",
    ] as const;

    for (const reason of fencedReasons) {
      const created = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests: {},
        requestedRevision: "rev-a",
      });
      yield* controller.activate(
        created.session.id,
        created.session.generation,
        created.supervisorIdentity,
        "rev-a",
      );
      let heartbeatCalls = 0;
      const fencedController = {
        ...controller,
        heartbeat: () => {
          heartbeatCalls += 1;
          return Effect.fail(new PreviewSessionError({ reason }));
        },
      } satisfies PreviewSessionControllerApi;
      const fiber = yield* supervisePreviewSessionLease(
        created.session.id,
        created.supervisorIdentity,
        created.session.generation,
      ).pipe(Effect.provideService(PreviewSessionController, fencedController), Effect.forkChild);

      yield* Effect.yieldNow;
      const supervisorExit = yield* Effect.exit(Fiber.join(fiber));
      expect(Exit.isSuccess(supervisorExit)).toBe(true);
      expect(heartbeatCalls).toBe(1);
      const current = yield* controller.status(created.session.id);
      expect(current.phase).toBe("active");
      expect(current.endedAt).toBeNull();
      yield* controller.stop(created.session.id, created.ownerIdentity);
    }
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

it.effect("ends a rotated same-generation supervisor while its resumed session stays live", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const controller = yield* makePreviewSessionController(() =>
      testClock.currentTimeMillisUnsafe(),
    );
    const created = yield* controller.create({
      owner: "owner",
      checkout: "/checkout",
      manifests: { "sheet-web": "sha256:manifest" },
      requestedRevision: "rev-a",
    });
    yield* TestClock.adjust(Duration.millis(previewSupervisorLeaseMs));
    const resumed = yield* controller.resume(
      created.session.id,
      created.ownerIdentity,
      created.supervisorIdentity,
    );
    expect(resumed.session.generation).toBe(created.session.generation);
    expect(resumed.supervisorIdentity).not.toBe(created.supervisorIdentity);

    let heartbeatCalls = 0;
    const countingController = {
      ...controller,
      heartbeat: (id: string, supervisorIdentity: string, generation: number) => {
        heartbeatCalls += 1;
        return controller.heartbeat(id, supervisorIdentity, generation);
      },
    } satisfies PreviewSessionControllerApi;
    const oldSupervisor = yield* supervisePreviewSessionLease(
      created.session.id,
      created.supervisorIdentity,
      created.session.generation,
    ).pipe(Effect.provideService(PreviewSessionController, countingController), Effect.forkChild);

    yield* Effect.yieldNow;
    const supervisorExit = yield* Effect.exit(Fiber.join(oldSupervisor));
    expect(Exit.isSuccess(supervisorExit)).toBe(true);
    expect(heartbeatCalls).toBe(1);
    const current = yield* controller.status(created.session.id);
    expect(current.phase).toBe("pending");
    expect(current.generation).toBe(created.session.generation);
    expect(current.endedAt).toBeNull();
    yield* controller.stop(created.session.id, created.ownerIdentity);
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

it.effect("surfaces a lease supervisor after bounded unresponsive heartbeat effects", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const controller = yield* makePreviewSessionController(() =>
      testClock.currentTimeMillisUnsafe(),
    );
    const created = yield* controller.create({
      owner: "owner",
      checkout: "/checkout",
      manifests: {},
      requestedRevision: "rev-a",
    });
    yield* controller.activate(
      created.session.id,
      created.session.generation,
      created.supervisorIdentity,
      "rev-a",
    );
    let heartbeatCalls = 0;
    let statusCalls = 0;
    const unavailableController = {
      ...controller,
      heartbeat: () => {
        heartbeatCalls += 1;
        return timeoutPreviewSessionHeartbeat(Effect.never);
      },
      status: (id: string) => {
        statusCalls += 1;
        return controller.status(id);
      },
    } satisfies PreviewSessionControllerApi;
    const fiber = yield* supervisePreviewSessionLease(
      created.session.id,
      created.supervisorIdentity,
      created.session.generation,
    ).pipe(
      Effect.provideService(PreviewSessionController, unavailableController),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    for (let failure = 1; failure <= previewSessionHeartbeatFailureLimit; failure += 1) {
      yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
      yield* Effect.yieldNow;
      if (failure < previewSessionHeartbeatFailureLimit) {
        yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
        yield* Effect.yieldNow;
      }
    }

    const terminal = yield* Effect.forkChild(
      Effect.timeoutOption(Fiber.await(fiber), Duration.millis(1)),
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(1));
    const terminalExit = yield* Fiber.join(terminal);
    if (Option.isNone(terminalExit)) yield* Fiber.interrupt(fiber);
    expect(Option.isSome(terminalExit)).toBe(true);
    const current = yield* controller.status(created.session.id);
    expect(current.phase).toBe("active");
    yield* controller.stop(created.session.id, created.ownerIdentity);
    if (Option.isNone(terminalExit)) return;

    expect(heartbeatCalls).toBe(previewSessionHeartbeatFailureLimit);
    expect(statusCalls).toBe(previewSessionHeartbeatFailureLimit);
    const supervisorExit = terminalExit.value;
    expect(Exit.isFailure(supervisorExit)).toBe(true);
    if (Exit.isFailure(supervisorExit))
      expect(Option.getOrUndefined(Cause.findErrorOption(supervisorExit.cause))).toMatchObject({
        reason: "lease-heartbeat-unconfirmed",
      });
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

it.effect("bounds the status read after heartbeat failures", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const controller = yield* makePreviewSessionController(() =>
      testClock.currentTimeMillisUnsafe(),
    );
    const created = yield* controller.create({
      owner: "owner",
      checkout: "/checkout",
      manifests: {},
      requestedRevision: "rev-a",
    });
    yield* controller.activate(
      created.session.id,
      created.session.generation,
      created.supervisorIdentity,
      "rev-a",
    );
    let heartbeatCalls = 0;
    let statusCalls = 0;
    const unavailableController = {
      ...controller,
      heartbeat: () => {
        heartbeatCalls += 1;
        return Effect.fail(new PreviewSessionError({ reason: "transient-heartbeat" }));
      },
      status: () => {
        statusCalls += 1;
        return Effect.never;
      },
    } satisfies PreviewSessionControllerApi;
    const fiber = yield* supervisePreviewSessionLease(
      created.session.id,
      created.supervisorIdentity,
      created.session.generation,
    ).pipe(
      Effect.provideService(PreviewSessionController, unavailableController),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;

    for (let failure = 1; failure <= previewSessionHeartbeatFailureLimit; failure += 1) {
      yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
      yield* Effect.yieldNow;
      if (failure < previewSessionHeartbeatFailureLimit) {
        yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
        yield* Effect.yieldNow;
      }
    }

    expect(heartbeatCalls).toBe(previewSessionHeartbeatFailureLimit);
    expect(statusCalls).toBe(previewSessionHeartbeatFailureLimit);
    const terminalObservation = yield* Effect.forkChild(
      Effect.timeoutOption(Fiber.await(fiber), Duration.millis(1)),
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(1));
    const terminal = yield* Fiber.join(terminalObservation);
    if (Option.isNone(terminal)) yield* Fiber.interrupt(fiber);
    expect(Option.isSome(terminal)).toBe(true);
    if (Option.isNone(terminal)) return;
    const terminalExit = terminal.value;
    expect(Exit.isFailure(terminalExit)).toBe(true);
    if (Exit.isFailure(terminalExit))
      expect(Option.getOrUndefined(Cause.findErrorOption(terminalExit.cause))).toMatchObject({
        reason: "lease-heartbeat-unconfirmed",
      });
    const current = yield* controller.status(created.session.id);
    expect(current.phase).toBe("active");
    expect(current.endedAt).toBeNull();
    yield* controller.stop(created.session.id, created.ownerIdentity);
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

it.live("recovers a session after closing and reopening the durable SQLite store", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "preview-controller-" });
    const filename = pathService.join(directory, "sessions.sqlite");
    const now = { value: 2_000_000 };
    const created = yield* Effect.scoped(
      Effect.gen(function* () {
        const controller = yield* makePreviewSessionController(() => now.value);
        return yield* controller.create({
          owner: "developer@example.test",
          checkout: "/checkout/worktree",
          manifests: { "sheet-auth": "sha256:manifest" },
          requestedRevision: "rev-pending",
        });
      }).pipe(Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename }), NodeServices.layer))),
    );
    now.value += previewSupervisorLeaseMs;
    const resumed = yield* Effect.scoped(
      Effect.gen(function* () {
        const controller = yield* makePreviewSessionController(() => now.value);
        const persisted = yield* controller.status(created.session.id);
        expect(persisted.owner).toBe("developer@example.test");
        expect(persisted.requestedRevision).toBe("rev-pending");
        expect(persisted.phase).toBe("pending");
        return yield* controller.resume(created.session.id, created.ownerIdentity);
      }).pipe(Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename }), NodeServices.layer))),
    );
    expect(resumed.session.generation).toBe(2);
    expect(resumed.session.leaseDeadline).toBe(created.session.leaseDeadline);
    expect(resumed.session.lastRenewedAt).toBe(created.session.lastRenewedAt);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("does not let status renew a lease and closes admission at the deadline", () =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const controller = yield* makePreviewSessionController(() => value);
      const created = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests: { "sheet-web": "sha256:web" },
        requestedRevision: "rev-a",
      });
      expect(
        (yield* controller.authorizeCredential(created.session.id, 1, "sheet-web")).phase,
      ).toBe("pending");
      const wrongRole = yield* Effect.exit(
        controller.authorizeCredential(created.session.id, 1, "sheet-bot"),
      );
      expect(wrongRole._tag).toBe("Failure");
      yield* controller.activate(created.session.id, 1, created.supervisorIdentity, "rev-a");
      const deadline = value + previewSessionLeaseMs;
      value = deadline - 1;
      const before = yield* controller.status(created.session.id);
      expect(before.leaseDeadline).toBe(deadline);
      value = deadline;
      const status = yield* controller.status(created.session.id);
      expect(status.phase).toBe("expired");
      const denied = yield* Effect.exit(controller.admit(created.session.id, 1));
      expect(denied._tag).toBe("Failure");
    }),
  ),
);

it.live("makes stop idempotent and permanently closes admission", () =>
  withController(({ value }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const controller = yield* makePreviewSessionController(() => value);
        const created = yield* controller.create({
          owner: "owner",
          checkout: "/checkout",
          manifests: {},
          requestedRevision: "rev-a",
        });
        yield* controller.activate(
          created.session.id,
          created.session.generation,
          created.supervisorIdentity,
          "rev-a",
        );
        const fenceStarted = yield* Deferred.make<void>();
        const finishFence = yield* Deferred.make<void>();
        const fenceFinished = yield* Deferred.make<void>();
        yield* controller.watchFences(
          created.session.id,
          Effect.gen(function* () {
            yield* Deferred.succeed(fenceStarted, undefined);
            yield* Deferred.await(finishFence);
            yield* Deferred.succeed(fenceFinished, undefined);
          }),
        );
        const stopped = yield* controller.stop(created.session.id, created.ownerIdentity);
        yield* Deferred.await(fenceStarted);
        expect(yield* Deferred.isDone(fenceFinished)).toBe(false);
        yield* Deferred.succeed(finishFence, undefined);
        yield* Deferred.await(fenceFinished);
        const stoppedAgain = yield* controller.stop(created.session.id, created.ownerIdentity);
        expect(stoppedAgain.endedAt).toBe(stopped.endedAt);
        const admission = yield* Effect.exit(controller.admit(created.session.id, 1));
        expect(admission._tag).toBe("Failure");
        const credentialRenewal = yield* Effect.exit(
          controller.authorizeCredential(created.session.id, 1, "sheet-web"),
        );
        expect(credentialRenewal._tag).toBe("Failure");
      }),
    ),
  ),
);

it.live("does not stop a resumed generation with an earlier generation-bound stop", () =>
  withController((clock) =>
    Effect.gen(function* () {
      const controller = yield* makePreviewSessionController(() => clock.value);
      const created = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests: {},
        requestedRevision: "rev-a",
      });
      yield* controller.activate(
        created.session.id,
        created.session.generation,
        created.supervisorIdentity,
        "rev-a",
      );

      clock.value += previewSupervisorLeaseMs + 1;
      const resumed = yield* controller.resume(created.session.id, created.ownerIdentity);
      expect(resumed.session.generation).toBe(created.session.generation + 1);
      expect(resumed.session.phase).toBe("pending");

      const staleStop = yield* Effect.exit(
        controller.stop(created.session.id, created.ownerIdentity, created.session.generation),
      );
      expect(Exit.isFailure(staleStop)).toBe(true);
      const current = yield* controller.status(created.session.id);
      expect(current.generation).toBe(resumed.session.generation);
      expect(current.phase).toBe("pending");
      expect(current.endedAt).toBeNull();
    }),
  ),
);

it.live(
  "binds auth exchange and resource checks to the recorded role client and live generation",
  () =>
    withController((clock) =>
      Effect.gen(function* () {
        const controller = yield* makePreviewSessionController(() => clock.value);
        const created = yield* controller.create({
          owner: "owner",
          checkout: "/checkout",
          manifests: { "sheet-workflows-runner": "sha256:runner" },
          requestedRevision: "rev-a",
        });
        const credentialIssue = yield* controller.authorizeCredentialIssue(
          created.session.id,
          created.session.generation,
          "sheet-workflows-runner",
        );
        yield* controller.registerCredentialIdentity({
          id: created.session.id,
          generation: 1,
          role: "sheet-workflows-runner",
          reservationId: credentialIssue.reservationId,
          credentialName: "workload-identity",
          serviceAccount: "tiara-stack-dev/preview-session-runner",
          oauthClientId: "preview-session-runner-client",
          credentialFile: "/managed/session/runner/token",
        });
        const authority = makePreviewSessionAuthority(controller);
        expect(
          yield* Effect.promise(() => authority.requiresBinding("preview-session-runner-client")),
        ).toBe(true);
        expect(yield* Effect.promise(() => authority.requiresBinding("unrelated-client"))).toBe(
          false,
        );
        const binding = {
          sessionId: created.session.id,
          generation: 1,
          role: "sheet-workflows-runner",
        };
        expect(
          yield* Effect.promise(() =>
            authority.authorize({ binding, clientId: "preview-session-runner-client" }),
          ),
        ).toBe(false);

        yield* controller.activate(created.session.id, 1, created.supervisorIdentity, "rev-a");
        expect(
          yield* Effect.promise(() =>
            authority.authorize({ binding, clientId: "preview-session-runner-client" }),
          ),
        ).toBe(true);
        expect(
          yield* Effect.promise(() => authority.authorize({ binding, clientId: "other-client" })),
        ).toBe(false);

        const prematureRemoval = yield* Effect.exit(
          controller.authorizeCredentialRemoval({
            id: created.session.id,
            generation: 1,
            role: "sheet-workflows-runner",
            oauthClientId: "preview-session-runner-client",
            serviceAccount: "tiara-stack-dev/preview-session-runner",
          }),
        );
        expect(prematureRemoval._tag).toBe("Failure");

        clock.value += previewSupervisorLeaseMs;
        const resumed = yield* controller.resume(created.session.id, created.ownerIdentity);
        expect(resumed.session.generation).toBe(2);
        expect(
          yield* Effect.promise(() =>
            authority.authorize({ binding, clientId: "preview-session-runner-client" }),
          ),
        ).toBe(false);

        yield* controller.stop(created.session.id, created.ownerIdentity);
        expect(
          yield* Effect.promise(() =>
            authority.authorize({ binding, clientId: "preview-session-runner-client" }),
          ),
        ).toBe(false);
        yield* controller.authorizeCredentialRemoval({
          id: created.session.id,
          generation: 1,
          role: "sheet-workflows-runner",
          oauthClientId: "preview-session-runner-client",
          serviceAccount: "tiara-stack-dev/preview-session-runner",
        });
        yield* controller.removeCredentialIdentity({
          id: created.session.id,
          generation: 1,
          role: "sheet-workflows-runner",
          oauthClientId: "preview-session-runner-client",
          serviceAccount: "tiara-stack-dev/preview-session-runner",
        });
        const afterRemoval = yield* Effect.promise(() =>
          authority.authorize({ binding, clientId: "preview-session-runner-client" }),
        );
        expect(afterRemoval).toBe(false);
      }),
    ),
);

it.live("settles only the original work admission after the session ends", () =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const controller = yield* makePreviewSessionController(() => value);
      const created = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests: { "sheet-workflows-runner": "sha256:runner" },
        requestedRevision: "rev-a",
        groups: ["workflow-execution"],
        endpoints: ["workflow-endpoint-a"],
        targets: ["development-target-a"],
      });
      const credentialIssue = yield* controller.authorizeCredentialIssue(
        created.session.id,
        created.session.generation,
        "sheet-workflows-runner",
      );
      yield* controller.registerCredentialIdentity({
        id: created.session.id,
        generation: 1,
        role: "sheet-workflows-runner",
        reservationId: credentialIssue.reservationId,
        credentialName: "workload-identity",
        serviceAccount: "tiara-stack-dev/preview-session-runner",
        oauthClientId: "preview-session-runner-client",
        credentialFile: "/private/session-a/runner/token",
      });
      yield* controller.activate(created.session.id, 1, created.supervisorIdentity, "rev-a");
      const admission = yield* controller.admitWorkload({
        sessionId: created.session.id,
        generation: 1,
        role: "sheet-workflows-runner",
        oauthClientId: "preview-session-runner-client",
        groupId: "workflow-execution",
        invocationId: "invocation-a",
        continuationId: null,
        endpoint: "workflow-endpoint-a",
        target: "development-target-a",
      });
      expect((yield* controller.status(created.session.id)).unsettled).toBe(1);
      yield* controller.stop(created.session.id, created.ownerIdentity);

      const tampered = yield* Effect.exit(
        controller.settleWorkload({ ...admission, target: "another-target" }),
      );
      expect(tampered._tag).toBe("Failure");
      yield* controller.settleWorkload(admission);
      expect((yield* controller.status(created.session.id)).unsettled).toBe(0);
      const replay = yield* Effect.exit(controller.settleWorkload(admission));
      expect(replay._tag).toBe("Failure");
    }),
  ),
);

it.live("persists overlapping target declarations once and refuses credential reissue", () =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const controller = yield* makePreviewSessionController(() => value);
      const created = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests: { "sheet-workflows-runner": "sha256:runner" },
        requestedRevision: "rev-a",
        groups: ["workflow-execution", "workflow-execution"],
        endpoints: ["workflow-endpoint-a", "workflow-endpoint-a"],
        targets: ["development-target-a", "development-target-a"],
      });
      const firstReservation = yield* controller.authorizeCredentialIssue(
        created.session.id,
        created.session.generation,
        "sheet-workflows-runner",
      );
      const concurrentIssue = yield* Effect.exit(
        controller.authorizeCredentialIssue(
          created.session.id,
          created.session.generation,
          "sheet-workflows-runner",
        ),
      );
      expect(concurrentIssue._tag).toBe("Failure");
      yield* controller.releaseCredentialIssue({
        id: created.session.id,
        generation: created.session.generation,
        role: "sheet-workflows-runner",
        reservationId: firstReservation.reservationId,
      });
      const reservation = yield* controller.authorizeCredentialIssue(
        created.session.id,
        created.session.generation,
        "sheet-workflows-runner",
      );
      yield* controller.releaseCredentialIssue({
        id: created.session.id,
        generation: created.session.generation,
        role: "sheet-workflows-runner",
        reservationId: firstReservation.reservationId,
      });
      const stillReserved = yield* Effect.exit(
        controller.authorizeCredentialIssue(
          created.session.id,
          created.session.generation,
          "sheet-workflows-runner",
        ),
      );
      expect(stillReserved._tag).toBe("Failure");
      yield* controller.registerCredentialIdentity({
        id: created.session.id,
        generation: created.session.generation,
        role: "sheet-workflows-runner",
        reservationId: reservation.reservationId,
        credentialName: "workload-identity",
        serviceAccount: "tiara-stack-dev/preview-session-runner",
        oauthClientId: "preview-session-runner-client",
        credentialFile: "/private/session-a/runner/token",
      });
      const reissue = yield* Effect.exit(
        controller.authorizeCredentialIssue(
          created.session.id,
          created.session.generation,
          "sheet-workflows-runner",
        ),
      );
      expect(reissue._tag).toBe("Failure");
      expect(
        (yield* controller.authorizeCredential(
          created.session.id,
          created.session.generation,
          "sheet-workflows-runner",
        )).id,
      ).toBe(created.session.id);
      yield* controller.activate(
        created.session.id,
        created.session.generation,
        created.supervisorIdentity,
        "rev-a",
      );
      const admission = yield* controller.admitWorkload({
        sessionId: created.session.id,
        generation: created.session.generation,
        role: "sheet-workflows-runner",
        oauthClientId: "preview-session-runner-client",
        groupId: "workflow-execution",
        invocationId: "invocation-a",
        continuationId: null,
        endpoint: "workflow-endpoint-a",
        target: "development-target-a",
      });
      expect(admission.admissionId).not.toBe("");
    }),
  ),
);
