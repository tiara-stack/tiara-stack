import { it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Duration, Effect, Fiber, FileSystem, Layer, Path } from "effect";
import { TestClock } from "effect/testing";
import type * as SqlClientType from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
import {
  makePreviewSessionController,
  PreviewSessionController,
  previewSessionHeartbeatMs,
  previewSessionLeaseMs,
  previewSupervisorLeaseMs,
  supervisePreviewSessionLease,
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

it.live("persists pending sessions and fences writes after restart and resume", () =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const firstController = yield* makePreviewSessionController(() => value);
      const created = yield* firstController.create({
        owner: "developer@example.test",
        checkout: "/worktrees/change",
        manifests: { "sheet-web": "sha256:manifest" },
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
        manifests: {},
        requestedRevision: "rev-a",
      });
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
      const stopped = yield* controller.stop(created.session.id, created.ownerIdentity);
      const stoppedAgain = yield* controller.stop(created.session.id, created.ownerIdentity);
      expect(stoppedAgain.endedAt).toBe(stopped.endedAt);
      const admission = yield* Effect.exit(controller.admit(created.session.id, 1));
      expect(admission._tag).toBe("Failure");
    }),
  ),
);
