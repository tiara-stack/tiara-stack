import { it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Deferred, Duration, Effect, Fiber, FileSystem, Layer, Path } from "effect";
import { TestClock } from "effect/testing";
import type * as SqlClientType from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
import {
  makePreviewSessionController,
  makePreviewSessionAuthority,
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
